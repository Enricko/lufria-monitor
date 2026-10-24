"""Claude Code chat: WebSocket bridge to the claude CLI using stream-json I/O.

Wire format on /ws/claude:
  client → server: JSON {"type":"user","text":"...","images":[{"mime":"image/png","data":"<b64>"}]}
                or {"type":"interrupt"} to cancel the current turn
                or {"type":"resume","session_id":"..."} to resume a named session (e.g. after page refresh)
  server → client: raw JSON lines from claude --output-format=stream-json --verbose
                   plus {"type":"status","state":"thinking"|"idle"|"error","msg":"..."}
                   and  {"type":"session","session_id":"..."} emitted once the session_id is known

Design:
  - Each turn spawns claude --print (exits after one turn) with --resume <session_id> on turn 2+.
  - session_id is captured from the system/init line of the FIRST turn and returned to the client.
  - The client echoes it back on reconnect via {"type":"resume","session_id":"..."} so the
    conversation survives page refreshes and tab switches.
"""
import asyncio
import base64
import json
import logging
import os
import pwd
import signal

from fastapi import WebSocket, WebSocketDisconnect

from app import providers, claude_sessions

log = logging.getLogger(__name__)

CLAUDE_BIN = "/home/lufria/.local/bin/claude"
CLAUDE_USER = "lufria"

MAX_IMAGE_BYTES = 20 * 1024 * 1024  # 20 MB per image


def _user() -> pwd.struct_passwd:
    return pwd.getpwnam(CLAUDE_USER)


def _claude_env(custom_base_url: str | None = None, custom_api_key: str | None = None) -> dict:
    u = _user()
    env = os.environ.copy()
    env.update({
        "HOME": u.pw_dir,
        "USER": u.pw_name,
        "LOGNAME": u.pw_name,
        "SHELL": u.pw_shell,
        "PATH": "/home/lufria/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "TMPDIR": "/tmp",
    })
    if custom_base_url:
        # Never leak native credentials or alternate auth to a configured router.
        for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS",
                    "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
                    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"):
            env.pop(key, None)
        env["ANTHROPIC_BASE_URL"] = custom_base_url
        # Claude refuses unauthenticated execution before HTTP. A public marker
        # satisfies that guard; it is sent as X-Api-Key, never Authorization.
        env["ANTHROPIC_API_KEY"] = custom_api_key or "monitor-no-auth"
    return env


def _build_user_message(text: str, images: list[dict]) -> dict:
    """Build a claude stream-json user message, optionally with image blocks."""
    if not images:
        return {"type": "user", "message": {"role": "user", "content": text}}

    content: list[dict] = []
    for img in images:
        mime = img.get("mime", "image/jpeg")
        data = img.get("data", "")
        try:
            raw = base64.b64decode(data)
            if len(raw) > MAX_IMAGE_BYTES:
                continue
            clean_b64 = base64.b64encode(raw).decode("ascii")
        except Exception:
            continue
        content.append({"type": "image", "source": {"type": "base64", "media_type": mime, "data": clean_b64}})
    if text:
        content.append({"type": "text", "text": text})

    return {"type": "user", "message": {"role": "user", "content": content}}


async def _run_turn(
    text: str,
    images: list[dict],
    session_id: str | None,
    model: str | None,
    on_line: "asyncio.Future[None]",
    send,
    provider_id: str | None = None,
) -> tuple[str | None, asyncio.subprocess.Process]:
    """Spawn one claude --print turn. Returns (session_id, proc).
    Calls send(json_str) for each output line. on_line future resolves after first line."""
    u = _user()
    cmd = [
        CLAUDE_BIN,
        "--print",
        "--input-format=stream-json",
        "--output-format=stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
    ]

    custom_base_url: str | None = None
    custom_api_key: str | None = None

    provider_name = None
    if provider_id is not None or (model and model not in ("default", "claude-default") and not model.startswith("claude-")):
        if not model:
            raise providers.ProviderError("Select a model for the configured provider")
        base_url, api_key, provider_name = await asyncio.to_thread(providers.resolve_model, model, provider_id)
        custom_base_url = base_url.rstrip("/").removesuffix("/v1").rstrip("/")
        custom_api_key = api_key
        cmd += ["--model", model]
    elif model and model.startswith("claude-") and model != "claude-default":
        cmd += ["--model", model]

    if session_id:
        cmd += ["--resume", session_id]

    env = _claude_env(custom_base_url, custom_api_key)

    async def safe_send(raw):
        if custom_api_key:
            raw = raw.replace(custom_api_key, "[redacted]")
            raw = raw.replace(json.dumps(custom_api_key)[1:-1], "[redacted]")
        await send(raw)

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        env=env,
        cwd=u.pw_dir,
        limit=64 * 1024 * 1024,
        preexec_fn=lambda: (os.setgid(u.pw_gid), os.setuid(u.pw_uid)),
    )

    # Write the message then close stdin (signals end-of-input to claude)
    msg_bytes = (json.dumps(_build_user_message(text, images), ensure_ascii=False) + "\n").encode()
    assert proc.stdin
    proc.stdin.write(msg_bytes)
    await proc.stdin.drain()
    proc.stdin.close()

    captured_sid: str | None = session_id
    captured_model: str = ""
    first = True
    rate_limit_msg: dict | None = None
    active_tools: dict[str, tuple[str, str]] = {}

    while True:
        try:
            line = await proc.stdout.readline()  # type: ignore[union-attr]
        except (ValueError, asyncio.LimitOverrunError) as e:
            log.warning("StreamReader line limit overrun, draining chunk: %s", e)
            chunk = await proc.stdout.read(128 * 1024)  # type: ignore[union-attr]
            if not chunk:
                break
            continue

        if not line:
            break
        raw = line.decode("utf-8", errors="replace").rstrip("\n")
        if not raw.strip():
            continue

        if first:
            first = False
            if not on_line.done():
                on_line.set_result(None)

        try:
            obj = json.loads(raw)
            obj_type = obj.get("type")

            if obj_type == "system" and obj.get("subtype") == "init":
                captured_sid = obj.get("session_id", captured_sid)
                captured_model = str(obj.get("model", ""))
                if captured_sid:
                    await asyncio.to_thread(claude_sessions.set_session_binding, captured_sid,
                                            model if model is not None and (provider_id is not None or model not in ("default", "claude-default")) else captured_model or "claude-default",
                                            provider_id, provider_name)

            elif obj_type == "rate_limit_event":
                # Extract unified rate limit windows
                info = obj.get("rate_limit_info", {})
                windows = info.get("unifiedWindows", {})
                five_hour = windows.get("five_hour", {})
                seven_day = windows.get("seven_day", {})
                rate_limit_msg = {
                    "type": "rate_limit",
                    "five_hour": {
                        "utilization": five_hour.get("utilization", 0),
                        "resets_at": five_hour.get("resetsAt", 0),
                    },
                    "seven_day": {
                        "utilization": seven_day.get("utilization", 0),
                        "resets_at": seven_day.get("resetsAt", 0),
                    },
                }

            elif obj_type == "assistant":
                # Check for tool_use blocks inside assistant message
                content = obj.get("message", {}).get("content", [])
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "tool_use":
                            tool_id = block.get("id", "")
                            tool_name = block.get("name", "Tool")
                            inp = block.get("input", {})
                            cmd_str = inp.get("command") or inp.get("path") or json.dumps(inp)
                            if tool_id:
                                active_tools[tool_id] = (tool_name, str(cmd_str))
                            await safe_send(json.dumps({
                                "type": "tool_start",
                                "id": tool_id,
                                "tool": tool_name,
                                "command": str(cmd_str),
                            }))

            elif obj_type == "user":
                # Check for tool_result blocks (from Claude Code tool completion)
                content = obj.get("message", {}).get("content", [])
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "tool_result":
                            tool_id = block.get("tool_use_id", "")
                            meta = active_tools.pop(tool_id, ("Bash", ""))
                            tool_name, cmd_str = meta
                            res_content = block.get("content", "")
                            if isinstance(res_content, list):
                                res_content = "\n".join(str(x) for x in res_content)
                            await safe_send(json.dumps({
                                "type": "tool_done",
                                "id": tool_id,
                                "tool": tool_name,
                                "command": cmd_str,
                                "output": str(res_content)[:4000],
                            }))

            elif obj_type == "result":
                # Extract per-turn usage from the result line
                usage = obj.get("usage", {})
                turn_usage_msg = {
                    "type": "turn_usage",
                    "input_tokens": usage.get("input_tokens", 0),
                    "output_tokens": usage.get("output_tokens", 0),
                    "cache_read_input_tokens": usage.get("cache_read_input_tokens", 0),
                    "total_cost_usd": obj.get("total_cost_usd", 0.0),
                    "model": captured_model,
                }
                # Model may be in the init line's model field; also check result's modelUsage
                await safe_send(json.dumps(turn_usage_msg))

        except json.JSONDecodeError:
            pass

        await safe_send(raw)

    # Emit rate limit info after the turn (if we saw one)
    if rate_limit_msg:
        await safe_send(json.dumps(rate_limit_msg))

    return captured_sid, proc


async def handle_ws(ws: WebSocket):
    await ws.accept()
    await ws.send_text(json.dumps({"type": "status", "state": "idle", "msg": "ready"}))

    session_id: str | None = None
    session_model: str | None = None
    session_provider_id: str | None = None
    current_proc: asyncio.subprocess.Process | None = None
    current_task: asyncio.Task | None = None

    async def send(raw: str):
        await ws.send_text(raw)

    async def cancel_current():
        nonlocal current_proc, current_task
        if current_proc and current_proc.returncode is None:
            try:
                current_proc.send_signal(signal.SIGINT)
            except ProcessLookupError:
                pass
        if current_task and not current_task.done():
            current_task.cancel()
            try:
                await asyncio.wait_for(asyncio.shield(current_task), timeout=3)
            except (Exception, asyncio.CancelledError):
                pass
        if current_proc:
            try:
                current_proc.kill()
            except Exception:
                pass
            try:
                await asyncio.wait_for(current_proc.wait(), timeout=3)
            except Exception:
                pass
        current_proc = None
        current_task = None

    try:
        while True:
            raw_ws = await ws.receive_text()
            try:
                msg = json.loads(raw_ws)
            except json.JSONDecodeError:
                continue

            kind = msg.get("type")

            if kind == "interrupt":
                await cancel_current()
                await ws.send_text(json.dumps({"type": "status", "state": "idle", "msg": ""}))
                continue

            if kind == "resume":
                # Client is telling us which session to continue (after page refresh or session switch)
                given_sid = msg.get("session_id") or None
                if given_sid is not None and not isinstance(given_sid, str):
                    await send(json.dumps({"type": "status", "state": "error", "msg": "Invalid session ID"}))
                    continue
                # If switching sessions, detach without killing previous session so it completes in background
                if given_sid != session_id:
                    current_proc = None
                    current_task = None
                binding = await asyncio.to_thread(claude_sessions.get_session_binding, given_sid) if given_sid else None
                session_id = given_sid
                session_model = binding.get("model") if binding else None
                session_provider_id = binding.get("provider_id") if binding else None
                continue

            if kind != "user":
                continue

            # --- New user turn ---
            await cancel_current()

            text = str(msg.get("text", ""))
            images = msg.get("images", [])
            if "model" in msg:
                model_value = msg["model"]
                if model_value is not None and not isinstance(model_value, str):
                    await send(json.dumps({"type": "status", "state": "error", "msg": "Invalid model"}))
                    continue
                if model_value != session_model and "provider_id" not in msg:
                    session_provider_id = None
                session_model = model_value
            if "provider_id" in msg:
                provider_value = msg["provider_id"]
                if provider_value is not None and (not isinstance(provider_value, str) or not provider_value):
                    await send(json.dumps({"type": "status", "state": "error", "msg": "Invalid provider"}))
                    continue
                session_provider_id = provider_value
            model = session_model
            provider_id = session_provider_id

            await ws.send_text(json.dumps({"type": "status", "state": "thinking", "msg": ""}))

            loop = asyncio.get_running_loop()
            first_line_fut: asyncio.Future[None] = loop.create_future()

            async def _turn():
                nonlocal session_id, current_proc
                try:
                    sid, proc = await _run_turn(text, images, session_id, model, first_line_fut, send, provider_id=provider_id)
                    current_proc = proc
                    if sid and sid != session_id:
                        session_id = sid
                        # Tell client the session_id so it can resume after refresh
                        await ws.send_text(json.dumps({"type": "session", "session_id": sid}))
                except asyncio.CancelledError:
                    log.info("Turn cancelled by user")
                except Exception as e:
                    log.error("Claude turn failed (%s)", type(e).__name__)
                    await send(json.dumps({
                        "type": "assistant",
                        "error": str(e) if isinstance(e, providers.ProviderError) else "Unable to run Claude Code. Check provider settings and try again.",
                        "is_api_error_message": True,
                    }))
                finally:
                    if not first_line_fut.done():
                        first_line_fut.set_result(None)
                    await ws.send_text(json.dumps({"type": "status", "state": "idle", "msg": ""}))

            current_task = asyncio.ensure_future(_turn())
            # Attach proc reference as early as possible (after first stdout line)
            try:
                await asyncio.wait_for(asyncio.shield(first_line_fut), timeout=30)
            except asyncio.TimeoutError:
                pass

    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.exception("Claude chat error: %s", e)
        try:
            await ws.send_text(json.dumps({"type": "status", "state": "error", "msg": str(e)}))
        except Exception:
            pass
    finally:
        # Keep background Claude Code subprocess running even if client WebSocket disconnects
        # (e.g. page refresh, network drop, or tab close).
        # Subprocess writes outputs safely to ~/.claude session files.
        # Process cancellation is reserved for explicit user 'interrupt'.
        pass

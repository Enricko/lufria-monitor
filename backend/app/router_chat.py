"""9Router LLM chat: WebSocket bridge streaming from 9Router OpenAI-compatible API.

Wire format on /ws/router:
  client → server: {"type":"user","text":"...","model":"ag/gemini-3.8-flash","session_id":"..."}
              or   {"type":"resume","session_id":"..."} to load existing session
  server → client: {"type":"status","state":"thinking"|"idle"|"error","msg":"..."}
              and  {"type":"delta","text":"..."} for streaming text chunks
              and  {"type":"session","session_id":"..."} when new session created
              and  {"type":"turn_usage","input_tokens":N,"output_tokens":N,"total_cost_usd":0.0,"model":"..."}
"""
import asyncio
import html
import json
import logging
import os
import time
import uuid
from pathlib import Path

import httpx
from fastapi import WebSocket, WebSocketDisconnect

from . import pricing
from .config import DATA_DIR

log = logging.getLogger(__name__)

ROUTER_BASE = "https://9router.lufria.tech/v1"
SESSIONS_DIR = DATA_DIR / "router_sessions"
SESSIONS_DIR.mkdir(parents=True, exist_ok=True)


def _api_key() -> str:
    key = os.environ.get("HERMES_CUSTOM_9ROUTER_LUFRIA_TECH_API_KEY", "")
    if key:
        return key
    env_file = Path("/home/lufria/monitor/.env")
    if env_file.exists():
        try:
            for line in env_file.read_text("utf-8").splitlines():
                if line.startswith("HERMES_CUSTOM_9ROUTER_LUFRIA_TECH_API_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
        except Exception:
            pass
    return ""


# ---------------------------------------------------------------------------
# Session persistence
# ---------------------------------------------------------------------------

def _session_path(session_id: str) -> Path:
    # Sanitize: only allow uuid-like chars
    safe = "".join(c for c in session_id if c.isalnum() or c == "-")[:64]
    return SESSIONS_DIR / f"{safe}.json"


def _load_session(session_id: str) -> dict | None:
    p = _session_path(session_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text("utf-8"))
    except Exception:
        return None


def _save_session(session: dict) -> None:
    session["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    p = _session_path(session["id"])
    p.write_text(json.dumps(session, ensure_ascii=False, indent=2), "utf-8")


def _new_session(model: str, title: str) -> dict:
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return {
        "id": str(uuid.uuid4()),
        "model": model,
        "title": title,
        "messages": [],
        "created_at": now,
        "updated_at": now,
        "total_tokens": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "total_cost_usd": 0.0,
    }


# ---------------------------------------------------------------------------
# Server context & Tool definitions (Agent mode)
# ---------------------------------------------------------------------------

BASH_TOOL = {
    "type": "function",
    "function": {
        "name": "bash",
        "description": "Execute a bash shell command on this Linux server and return stdout and stderr. Use this to inspect files, check project directories, view system status, run git commands, check logs, or assist with development tasks.",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The shell command to run on the server (e.g. 'ls -la /root', 'git status', 'df -h', 'cat package.json')"
                }
            },
            "required": ["command"]
        }
    }
}


def _build_system_prompt() -> str:
    known_projects = [
        ("/home/lufria/monitor", "Lufria Monitor Dashboard & WebSocket server (FastAPI + React/Vite)"),
        ("/root/cetaphil-new", "Cetaphil Field Sales App (Laravel 11 backend + Flutter Mobile)"),
        ("/root/binav/apps/Binav-Avts-Project", "Binav AVTS tracking platform"),
        ("/root/workspace", "Active Hermes Agent Workspace"),
    ]
    proj_lines = []
    for path, desc in known_projects:
        if os.path.exists(path):
            proj_lines.append(f"- `{path}`: {desc}")

    return (
        "You are an expert AI software engineer, sysadmin, and development partner running directly on this Linux VPS server.\n\n"
        "SERVER CONTEXT:\n"
        "- Hostname / OS: Linux (Ubuntu 24.04/26.04)\n"
        "- Current User: lufria (Home: /home/lufria)\n"
        "- Working Directory: /home/lufria/monitor (and repositories under /root)\n"
        "- Active Server Projects:\n"
        + "\n".join(proj_lines) + "\n\n"
        "TOOLS & CAPABILITIES:\n"
        "- You have the `bash` tool to execute real commands directly on this server.\n"
        "- When the user asks you to check projects, files, directories, git status, logs, or services on this server, ALWAYS execute the appropriate bash command using the `bash` tool to get real, live output.\n"
        "- Never claim you lack access to the server or file system: you are integrated directly with this server.\n"
        "- Keep answers concise, direct, evidence-backed, and developer-focused."
    )


async def _run_bash(command: str) -> str:
    """Execute a bash command on the server and return stdout + stderr."""
    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd="/home/lufria",
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=45.0)
        out = (stdout.decode("utf-8", "replace") + stderr.decode("utf-8", "replace")).strip()
        return out if out else "(command executed with empty output)"
    except asyncio.TimeoutError:
        return "Command timed out after 45 seconds"
    except Exception as e:
        return f"Execution error: {e}"


# ---------------------------------------------------------------------------
# SSE streaming call with multi-provider routing & agent tool execution loop
# ---------------------------------------------------------------------------

async def _stream_turn(
    session: dict,
    user_text: str,
    send,
) -> tuple[str, int, int]:
    """Stream one agent turn with tool execution support across Hermes providers.
    Returns (collected_text, input_tokens, output_tokens).
    """
    from app.providers import resolve_model

    model = session.get("model", "ag/gemini-3.8-flash")
    base_url, api_key, prov_name = resolve_model(model)
    if not api_key:
        api_key = _api_key()
    if not base_url:
        base_url = ROUTER_BASE

    # Build initial message history
    messages: list[dict] = [{"role": "system", "content": _build_system_prompt()}]
    for m in session.get("messages", []):
        messages.append({"role": m["role"], "content": m["content"]})
    messages.append({"role": "user", "content": user_text})

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }

    full_collected_text = ""
    total_input_tokens = 0
    total_output_tokens = 0
    max_turns = 5

    async with httpx.AsyncClient(timeout=120.0) as client:
        for turn_idx in range(max_turns):
            payload = {
                "model": model,
                "messages": messages,
                "tools": [BASH_TOOL],
                "stream": True,
                "stream_options": {"include_usage": True},
            }

            turn_text = ""
            tool_calls_map: dict[int, dict] = {}
            turn_in_tokens = 0
            turn_out_tokens = 0

            try:
                async with client.stream(
                    "POST",
                    f"{base_url}/chat/completions",
                    headers=headers,
                    json=payload,
                ) as resp:
                    if resp.status_code != 200:
                        body = await resp.aread()
                        err_msg = f"{prov_name} error {resp.status_code}: {body.decode('utf-8', errors='replace')[:300]}"
                        await send(json.dumps({"type": "status", "state": "error", "msg": err_msg}))
                        return full_collected_text, total_input_tokens, total_output_tokens

                    async for line in resp.aiter_lines():
                        if not line:
                            continue
                        if line.startswith("data: "):
                            data = line[6:]
                            if data.strip() == "[DONE]":
                                break
                            try:
                                obj = json.loads(data)
                            except json.JSONDecodeError:
                                continue

                            # Usage
                            usage = obj.get("usage")
                            if usage:
                                turn_in_tokens = usage.get("prompt_tokens", 0) or usage.get("input_tokens", 0)
                                turn_out_tokens = usage.get("completion_tokens", 0) or usage.get("output_tokens", 0)

                            choices = obj.get("choices", [])
                            if not choices:
                                continue
                            delta = choices[0].get("delta", {})

                            # Text chunk
                            content = delta.get("content")
                            if content:
                                turn_text += content
                                full_collected_text += content
                                await send(json.dumps({"type": "delta", "text": content}))

                            # Tool call chunk
                            if delta.get("tool_calls"):
                                for tc in delta["tool_calls"]:
                                    idx = tc.get("index", 0)
                                    if idx not in tool_calls_map:
                                        tool_calls_map[idx] = {
                                            "id": tc.get("id", f"call_{idx}"),
                                            "function": {"name": "", "arguments": ""},
                                        }
                                    if tc.get("id"):
                                        tool_calls_map[idx]["id"] = tc["id"]
                                    fn = tc.get("function", {})
                                    if fn.get("name"):
                                        tool_calls_map[idx]["function"]["name"] += fn["name"]
                                    if fn.get("arguments"):
                                        tool_calls_map[idx]["function"]["arguments"] += fn["arguments"]

            except Exception as e:
                log.exception("Streaming exception on %s: %s", prov_name, e)
                await send(json.dumps({"type": "status", "state": "error", "msg": f"Connection error: {e}"}))
                break

            total_input_tokens += turn_in_tokens
            total_output_tokens += turn_out_tokens

            # If no tool calls occurred, the model has finished its answer!
            if not tool_calls_map:
                break

            # Handle each tool call
            for idx, tc in sorted(tool_calls_map.items()):
                fn_name = tc["function"]["name"]
                args_str = tc["function"]["arguments"]
                try:
                    args = json.loads(args_str)
                except Exception:
                    args = {"command": args_str}

                cmd = args.get("command", "")
                # Notify frontend with tool running indicator in realtime
                await send(json.dumps({
                    "type": "tool_start",
                    "id": tc["id"],
                    "tool": "bash",
                    "command": cmd,
                }))

                # Execute bash command
                start_t = time.time()
                out = await _run_bash(cmd)
                elapsed = time.time() - start_t
                out_snippet = out[:3000]

                # Notify frontend that tool execution finished
                await send(json.dumps({
                    "type": "tool_done",
                    "id": tc["id"],
                    "tool": "bash",
                    "command": cmd,
                    "output": out_snippet,
                    "elapsed": round(elapsed, 2),
                }))

                # Append collapsible details HTML so it stays closed by default
                escaped_cmd = html.escape(cmd.strip())
                escaped_out = html.escape(out_snippet.strip())
                elapsed_str = f" ({elapsed:.1f}s)" if elapsed >= 0.5 else ""
                details_html = (
                    f"\n\n<details class=\"tool-call\">\n"
                    f"<summary><span class=\"tool-call-left\"><span class=\"tool-call-arrow\">▶</span><span class=\"tool-call-icon\">⚙️</span><span class=\"tool-call-name\">Bash:</span><code class=\"tool-call-cmd\">{escaped_cmd}</code></span><span class=\"tool-call-badge-done\">✓ Selesai{elapsed_str}</span></summary>\n"
                    f"<div class=\"tool-call-body\"><pre><code>{escaped_out}</code></pre></div>\n"
                    f"</details>\n\n"
                )
                full_collected_text += details_html
                await send(json.dumps({"type": "delta", "text": details_html}))

                # Append to messages for next turn
                messages.append({
                    "role": "assistant",
                    "content": turn_text if turn_text else None,
                    "tool_calls": [
                        {
                            "id": tc["id"],
                            "type": "function",
                            "function": {"name": fn_name, "arguments": args_str},
                        }
                    ],
                })
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": out_snippet,
                })

    # Fallback token estimate if API didn't return usage
    if total_input_tokens == 0 and total_output_tokens == 0:
        total_chars = sum(len(m.get("content") or "") for m in messages)
        total_input_tokens = max(1, total_chars // 4)
        total_output_tokens = max(1, len(full_collected_text) // 4)

    return full_collected_text, total_input_tokens, total_output_tokens


# ---------------------------------------------------------------------------
# WebSocket handler
# ---------------------------------------------------------------------------

async def handle_ws(ws: WebSocket):
    await ws.accept()
    await ws.send_text(json.dumps({"type": "status", "state": "idle", "msg": "ready"}))

    # In-memory session state for this connection
    session: dict | None = None

    async def send(raw: str):
        await ws.send_text(raw)

    try:
        while True:
            raw_ws = await ws.receive_text()
            try:
                msg = json.loads(raw_ws)
            except json.JSONDecodeError:
                continue

            kind = msg.get("type")

            if kind == "resume":
                # Client restoring an existing session
                sid = str(msg.get("session_id", ""))
                if sid:
                    loaded = _load_session(sid)
                    if loaded:
                        session = loaded
                        await send(json.dumps({"type": "session", "session_id": sid}))
                continue

            if kind != "user":
                continue

            # --- New user turn ---
            text = str(msg.get("text", "")).strip()
            if not text:
                continue

            model = str(msg.get("model", "ag/gemini-3.8-flash"))
            given_sid = str(msg.get("session_id", ""))

            # Load or create session
            if given_sid and session is None:
                session = _load_session(given_sid)
            if session is None:
                title = text[:60]
                session = _new_session(model, title)
                _save_session(session)
                await send(json.dumps({"type": "session", "session_id": session["id"]}))
            else:
                # Update model if client is changing it (shouldn't normally change mid-session)
                if model and model != session.get("model"):
                    session["model"] = model

            await send(json.dumps({"type": "status", "state": "thinking", "msg": ""}))

            try:
                result = await _stream_turn(session, text, send)
                if result is None or not isinstance(result, tuple) or len(result) != 3:
                    await send(json.dumps({"type": "status", "state": "error", "msg": "Streaming failed"}))
                    continue

                collected_text, input_tokens, output_tokens = result
                turn_cost = pricing.estimate_cost_usd(session.get("model", model), input_tokens, output_tokens)

                # Persist messages
                session["messages"].append({"role": "user", "content": text})
                session["messages"].append({"role": "assistant", "content": collected_text})
                session["total_tokens"] = session.get("total_tokens", 0) + input_tokens + output_tokens
                session["input_tokens"] = session.get("input_tokens", 0) + input_tokens
                session["output_tokens"] = session.get("output_tokens", 0) + output_tokens
                session["total_cost_usd"] = round(session.get("total_cost_usd", 0.0) + turn_cost, 6)

                _save_session(session)

                # Emit usage
                await send(json.dumps({
                    "type": "turn_usage",
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "total_cost_usd": turn_cost,
                    "model": session.get("model", model),
                }))

                await send(json.dumps({"type": "status", "state": "idle", "msg": ""}))

            except httpx.TimeoutException:
                await send(json.dumps({"type": "status", "state": "error", "msg": "Request timed out"}))
            except Exception as e:
                log.exception("Router stream error: %s", e)
                await send(json.dumps({"type": "status", "state": "error", "msg": str(e)}))

    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.exception("Router chat error: %s", e)
        try:
            await ws.send_text(json.dumps({"type": "status", "state": "error", "msg": str(e)}))
        except Exception:
            pass

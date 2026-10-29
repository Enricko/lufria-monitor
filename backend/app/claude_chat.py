"""Claude Code chat: WebSocket bridge to the claude CLI using stream-json I/O.

Every turn spawns `claude --print` (with --resume <session_id> after the first), so each turn
can pick its own model *and* provider: official Claude through the CLI's own login, or any
Anthropic-compatible router from Settings (ANTHROPIC_BASE_URL). One session can move back and
forth between them; Claude Code drops thinking blocks written by another model itself.

Wire format on /ws/claude:
  client → server:
    {"type":"resume","session_id":"<uuid>"|""}   show a session ("" = new chat). Answered with
        {"type":"history",...} (the transcript), the events of a turn still running, then
        {"type":"attached","session_id","running"}
    {"type":"user","text","images":[{"mime","data"}],"model","provider_id","permission_mode",
        "effort","client_id"}                     one turn; text may be a slash command, which
                                                  the CLI runs (skills, /compact, /context, ...)
    {"type":"interrupt"}                          stop the running turn or bash command
    {"type":"bash","command","client_id"}          `!` bash mode -> {"type":"bash_result",...}
    {"type":"answer","request_id","behavior":"allow","answers"?,"permissions"?}
    {"type":"answer","request_id","behavior":"deny","message"?,"interrupt"?}
                                                  the user's pick in a prompt (see below)
  server → client:
    raw JSON lines from the CLI (system/init, assistant, user, stream_event, result),
    {"type":"turn_start"|"tool_start"|"tool_done"|"turn_usage"|"plan_limits",...},
    {"type":"prompt","request_id","tool_name","input",...}  the CLI waits for the user: a tool
        permission, AskUserQuestion or a plan to approve (Claude Code's dialogs),
    {"type":"prompt_done","request_id",...}       answered (maybe in another tab) or withdrawn,
    {"type":"session","session_id"} once a new session has its id,
    {"type":"status","state":"thinking"|"idle"|"error","msg"}

Turns belong to the server, not the socket (RUNS): refreshing the page or opening another
session leaves a turn running, and resuming its session replays what it has done so far,
open prompts included.
"""
import asyncio
import base64
import json
import logging
import os
import pwd
import signal
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Awaitable, Callable

from fastapi import HTTPException, WebSocket, WebSocketDisconnect

from app import claude_sessions, claude_workspace, providers
from app.claude_transcript import _strip_ansi, question_answers, tool_part, tool_result_text, usage_summary

log = logging.getLogger(__name__)

CLAUDE_BIN = "/home/lufria/.local/bin/claude"
CLAUDE_USER = "lufria"

MAX_IMAGE_BYTES = 20 * 1024 * 1024  # 20 MB per image
# Official combos: the main model plus subagents, all on the CLI's own login.
OFFICIAL_AGENTS = {
    "explorer": {
        "description": "Search and read many files quickly; reports findings with file paths and line numbers.",
        "prompt": "You explore the codebase to answer the question you are given. Read only what is needed, "
                  "and reply with a short summary that cites file paths and line numbers.",
        "model": "haiku",
    },
    "reviewer": {
        "description": "Review a finished change for correctness bugs, security risks and regressions.",
        "prompt": "You review the change you are given. Report only concrete, verified problems with file and "
                  "line references, most severe first. Do not edit files.",
        "model": "opus",
    },
}
# A defined subagent is only an option: without a rule the main model does the work itself. Appended to the
# system prompt so the cheap explorer and the reviewer actually get used. Worded "when offered" because the CLI
# records the system prompt on a conversation's first request and replays it on every resume
# (--system-prompt-snapshot, on by default): the text must be the same whatever model a later turn picks.
OFFICIAL_AGENT_RULES = {
    "explorer": "When the Agent tool offers an `explorer` subagent (Haiku, far cheaper than you), use it for every "
                "codebase search or exploration: finding where something lives, grep/find, or reading files to "
                "understand code. Do not run those searches yourself. Give it a precise question and work from its "
                "summary; read a file yourself only right before editing it, or when the user names that one file. "
                "The built-in `Explore` agent is turned off then: it runs on your model, not Haiku.",
    "reviewer": "When the Agent tool offers a `reviewer` subagent, have it review the diff before you report a code "
                "change as finished, unless it is a one-line or purely cosmetic edit, then fix or explain each "
                "problem it reports.",
}
# Every turn: the dashboard is a browser, maybe on another device. Without this Claude assumes a terminal on
# this machine and tells the user to scp what it made; the page turns a path in a reply into an attachment.
DASHBOARD_RULE = ("You are running inside the Lufria Monitor web dashboard, not a terminal: the user reads your "
                  "replies in a browser, often on another device. When you create a file for them (image, video, "
                  "audio, PDF, office document, CSV, archive), give its absolute path in inline code once it exists, "
                  "e.g. `/home/lufria/output/result.mp4`; the dashboard shows it under your reply as an attachment "
                  "they can preview and download. Any other path in inline code opens in the dashboard's file "
                  "viewer. Never tell them to fetch files with scp, rsync, sftp or similar.")
# One text for every turn and model (see OFFICIAL_AGENT_RULES): a changed text would not reach a running conversation.
SYSTEM_APPEND = " ".join([DASHBOARD_RULE, *OFFICIAL_AGENT_RULES.values()])
OFFICIAL_COMBOS = {
    "official-hemat": {"name": "Official · Hemat", "model": "sonnet", "agents": ["explorer"],
                       "description": "Sonnet works, Haiku explores"},
    "official-seimbang": {"name": "Official · Seimbang", "model": "opusplan", "agents": ["explorer", "reviewer"],
                          "description": "Opus plans, Sonnet executes, Haiku explores, Opus reviews (in plan mode every subagent runs on Opus)"},
    "official-kualitas": {"name": "Official · Kualitas", "model": "opus", "agents": ["explorer", "reviewer"],
                          "description": "Opus works, Haiku explores, Opus reviews"},
}
# Picker entries that run Claude Code through a router combo. The combo's own models are edited in the router,
# so only its name lives here; every role (main, subagents, background calls) is pointed at it.
OFFICIAL_ROUTES = {
    "official-antigravity": {"name": "Official · Antigravity Tops", "provider_id": "lufria", "model": "AntiGravity-Tops",
                             "description": "Everything runs on the 9Router combo AntiGravity-Tops; change its models in 9Router"},
}
ROUTED_COMBOS = {(r["provider_id"], r["model"]) for r in OFFICIAL_ROUTES.values()}
ROUTED_ENV = ("ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
              "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL")
# Model names the CLI resolves with its own login; anything else needs a provider.
NATIVE_ALIASES = {"default", "claude-default", "best", "opus", "sonnet", "haiku", "fable", "opusplan", *OFFICIAL_COMBOS}
PERMISSION_MODES = ("default", "acceptEdits", "plan", "bypassPermissions")
EFFORT_LEVELS = ("low", "medium", "high", "xhigh", "max")
# What Claude Code tells the model when the user picks "No" in its dialog without saying why.
REJECT_MESSAGE = ("The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a "
                  "file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the "
                  "user to tell you how to proceed.")
# The parts of a can_use_tool request the page draws its dialog from.
PROMPT_FIELDS = ("tool_name", "display_name", "title", "description", "input", "tool_use_id",
                 "permission_suggestions", "decision_reason", "blocked_path", "agent_id",
                 "default_to_no", "suppress_always_allow_rule")
REPLAY_LIMIT = 5000      # events kept to replay a running turn to a page that re-attaches
OUTBOX_LIMIT = 20000     # queued frames per socket before streaming deltas are dropped
CAPABILITIES_TTL = 600
# Every probe past the CLI's 60 s snapshot asks Anthropic's /api/oauth/usage, which answers 429 when
# polled often; the CLI then holds off 300 s and, with no snapshot under an hour old, reports no limits.
LIMITS_TTL = 300         # seconds a plan-limits answer is shared by every page
LIMITS_MIN_INTERVAL = 60  # even a refresh waits this long between probes


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


class TurnError(Exception):
    """A turn that can't start, with a message for the user."""


def is_native(model: str | None, provider_id: str | None) -> bool:
    """Official Claude through the CLI's own login (no provider, a Claude model or alias)."""
    return provider_id is None and (not model or model in NATIVE_ALIASES or model.startswith("claude-"))


async def _prepare(model: str | None, provider_id: str | None, session_id: str | None,
                   permission_mode: str, effort: str | None,
                   lock: Path | None = None) -> tuple[list[str], dict, str | None, str | None]:
    """CLI argv + env for one turn: (cmd, env, api key to redact, provider name).
    `lock`: keep the turn's writes inside this folder (sandboxed Bash + an edit guard)."""
    cmd = [
        CLAUDE_BIN,
        "--print",
        "--input-format=stream-json",
        "--output-format=stream-json",
        "--verbose",
        "--include-partial-messages",
        # Whatever would ask (a tool permission, AskUserQuestion, a plan to approve) comes over this pipe as a
        # can_use_tool control request; the page shows Claude Code's dialog and Run.answer replies.
        "--permission-prompt-tool", "stdio",
    ]
    if permission_mode == "bypassPermissions":
        cmd.append("--dangerously-skip-permissions")
    else:
        # Approving a plan may switch the turn to bypass (setMode), which the CLI only allows when offered up front.
        cmd += ["--permission-mode", permission_mode, "--allow-dangerously-skip-permissions"]
    if effort:
        cmd += ["--effort", effort]
    if lock is not None:
        missing = claude_workspace.sandbox_missing()
        if missing:
            raise TurnError(f"The folder lock needs {' and '.join(missing)}. Install with: sudo apt install bubblewrap socat")
        cmd += ["--settings", json.dumps(claude_workspace.folder_lock_settings(lock))]

    custom_base_url = custom_api_key = provider_name = None
    if provider_id is None and model in OFFICIAL_COMBOS:
        combo = OFFICIAL_COMBOS[model]
        cmd += ["--model", combo["model"], "--agents", json.dumps({n: OFFICIAL_AGENTS[n] for n in combo["agents"]})]
        if "explorer" in combo["agents"]:
            # The built-in Explore inherits the main model (Opus under opusplan/opus), which defeats the cheap explorer.
            cmd.append("--disallowedTools=Agent(Explore)")  # one argument: the flag takes a list and would eat what follows
    elif not is_native(model, provider_id):
        if not model:
            raise providers.ProviderError("Select a model for the configured provider")
        base_url, api_key, provider_name = await asyncio.to_thread(providers.resolve_model, model, provider_id)
        custom_base_url = base_url.rstrip("/").removesuffix("/v1").rstrip("/")
        custom_api_key = api_key
        cmd += ["--model", model]
    elif model and model not in ("default", "claude-default"):
        cmd += ["--model", model]

    cmd += ["--append-system-prompt", SYSTEM_APPEND]
    if session_id:
        cmd += ["--resume", session_id]
    env = _claude_env(custom_base_url, custom_api_key)
    if (provider_id, model) in ROUTED_COMBOS:
        env.update(dict.fromkeys(ROUTED_ENV, model))
    return cmd, env, custom_api_key or None, provider_name


def _redactor(secret: str | None) -> Callable[[str], str]:
    if not secret:
        return lambda raw: raw
    escaped = json.dumps(secret)[1:-1]
    return lambda raw: raw.replace(secret, "[redacted]").replace(escaped, "[redacted]")


async def _run_turn(
    text: str,
    images: list[dict],
    session_id: str | None,
    model: str | None,
    send: Callable[[str], object],
    provider_id: str | None = None,
    permission_mode: str = "bypassPermissions",
    effort: str | None = None,
    on_start: Callable[[asyncio.subprocess.Process, str | None], object] | None = None,
    on_session: Callable[[str], object] | None = None,
    cwd: Path | None = None,
    locked: bool = False,
    on_control: Callable[[dict, Callable[[str], str]], Awaitable[None]] | None = None,
) -> tuple[str | None, asyncio.subprocess.Process]:
    """Spawn one claude --print turn in `cwd` and forward its output. Returns (session_id, proc).

    stdin stays open until the CLI reports its result, so an interrupt can be sent as a
    control request (the CLI then records the interruption in the transcript) and the CLI's
    own control requests (prompts for the user) go to `on_control` with the redactor, which answers them."""
    u = _user()
    folder = cwd or Path(u.pw_dir)
    cmd, env, secret, provider_name = await _prepare(model, provider_id, session_id, permission_mode, effort,
                                                     lock=folder if locked else None)
    redact = _redactor(secret)

    async def safe_send(raw: str):
        result = send(redact(raw))
        if asyncio.iscoroutine(result):
            await result

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
        cwd=folder,
        limit=64 * 1024 * 1024,
        preexec_fn=lambda: (os.setgid(u.pw_gid), os.setuid(u.pw_uid)),
    )
    if on_start:
        on_start(proc, provider_name)

    stderr_tail = bytearray()

    async def drain_stderr():
        stream = getattr(proc, "stderr", None)
        if stream is None:
            return
        while chunk := await stream.read(4096):
            stderr_tail.extend(chunk)
            del stderr_tail[:-4096]

    stderr_task = asyncio.ensure_future(drain_stderr())

    msg_bytes = (json.dumps(_build_user_message(text, images), ensure_ascii=False) + "\n").encode()
    assert proc.stdin
    proc.stdin.write(msg_bytes)
    await proc.stdin.drain()

    captured_sid: str | None = session_id
    captured_model: str = ""
    saw_result = False
    tools: dict[str, dict] = {}

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

        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            await safe_send(raw)
            continue
        obj_type = obj.get("type")
        # Subagent traffic is folded into its Task card, not shown as the main thread.
        main_thread = not obj.get("parent_tool_use_id")

        if obj_type in ("control_request", "control_cancel_request"):
            # The CLI asks the user something (or takes the question back); what the page needs is emitted there.
            if on_control:
                await on_control(obj, redact)
            continue

        if obj_type == "system" and obj.get("subtype") == "init":
            captured_sid = obj.get("session_id", captured_sid)
            captured_model = str(obj.get("model", ""))
            if captured_sid:
                await asyncio.to_thread(claude_sessions.set_session_binding, captured_sid,
                                        model if model is not None and (provider_id is not None or model not in ("default", "claude-default")) else captured_model or "claude-default",
                                        provider_id, provider_name, str(folder), locked)
                if on_session:
                    on_session(captured_sid)

        elif obj_type == "rate_limit_event":
            # The official account's limits, straight from this turn's response headers.
            update = note_rate_limit(obj.get("rate_limit_info") or {}) if is_native(model, provider_id) else None
            if update:
                await safe_send(json.dumps({"type": "plan_limits", **update}))

        elif obj_type == "assistant" and main_thread:
            content = obj.get("message", {}).get("content", [])
            for block in content if isinstance(content, list) else []:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    part = tool_part(block)
                    tools[part["id"]] = part
                    await safe_send(json.dumps({"type": "tool_start", "part": part,
                                                # kept for older pages
                                                "id": part["id"], "tool": part["name"], "command": part["summary"]}))

        elif obj_type == "user" and main_thread:
            content = obj.get("message", {}).get("content", [])
            for block in content if isinstance(content, list) else []:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    tool_id = str(block.get("tool_use_id", ""))
                    part = tools.pop(tool_id, None) or {"name": "Tool", "summary": ""}
                    done = {"type": "tool_done", "id": tool_id, "tool": part["name"], "command": part["summary"],
                            "output": tool_result_text(block.get("content", "")), "is_error": bool(block.get("is_error"))}
                    answers = question_answers(obj.get("tool_use_result")) if part["name"] == "AskUserQuestion" else None
                    if answers is not None:
                        done["answers"] = answers
                    await safe_send(json.dumps(done))

        elif obj_type == "result":
            saw_result = True
            # Per model, subagents and the CLI's side calls included; custom models get our price.
            per_model = obj.get("model_usage_since_last_result") or obj.get("modelUsage") or {}
            if not per_model and obj.get("usage"):
                per_model = {captured_model or "unknown": {**obj["usage"], "costUSD": obj.get("total_cost_usd")}}
            await safe_send(json.dumps({"type": "turn_usage", **usage_summary(per_model), "model": captured_model}))
            # End of turn: closing stdin lets the CLI exit.
            if proc.stdin and not proc.stdin.is_closing():
                proc.stdin.close()

        await safe_send(raw)

    if proc.stdin and not proc.stdin.is_closing():
        proc.stdin.close()
    try:
        await asyncio.wait_for(asyncio.shield(stderr_task), timeout=2)
    except (asyncio.TimeoutError, Exception):
        stderr_task.cancel()
    if not saw_result:
        await proc.wait()
        if proc.returncode and proc.returncode > 0:  # negative = a signal, i.e. our interrupt
            detail = stderr_tail.decode("utf-8", errors="replace").strip().splitlines()[-3:]
            await safe_send(json.dumps({"type": "assistant", "is_api_error_message": True,
                                        "error": "Claude Code exited before finishing the turn"
                                                 + (f": {' '.join(detail)[:400]}" if detail else ".")}))

    return captured_sid, proc


# ---------------------------------------------------------------------------
# Runs: turns outlive the socket that started them
# ---------------------------------------------------------------------------

def _is_set_mode(update) -> bool:
    return (isinstance(update, dict) and set(update) == {"type", "mode", "destination"}
            and update["type"] == "setMode" and update["mode"] in PERMISSION_MODES and update["destination"] == "session")


def _permission_result(request: dict, msg: dict, redact: Callable[[str], str] = lambda raw: raw) -> dict:
    """The CLI's answer to one can_use_tool request from the page's pick. The page only chooses: the tool input
    stays the CLI's (plus AskUserQuestion's answers), and permission updates are the CLI's own suggestions (as the
    page saw them, through `redact`) or, for a plan, the session mode to work in. Raises ValueError for anything else."""
    behavior = msg.get("behavior")
    if behavior == "deny":
        message = msg.get("message")
        out = {"behavior": "deny",
               "message": message.strip()[:20000] if isinstance(message, str) and message.strip() else REJECT_MESSAGE}
        if msg.get("interrupt") is True:
            out["interrupt"] = True  # the turn stops, as after Esc in the terminal
        return out
    if behavior != "allow":
        raise ValueError("Invalid answer")
    updated = dict(request.get("input") or {})
    if request.get("tool_name") == "AskUserQuestion":
        answers = msg.get("answers")
        if not isinstance(answers, dict) or not answers \
                or not all(isinstance(k, str) and isinstance(v, str) for k, v in answers.items()):
            raise ValueError("Invalid answers")
        updated["answers"] = {k[:2000]: v[:20000] for k, v in list(answers.items())[:20]}
    out = {"behavior": "allow", "updatedInput": updated}
    permissions = msg.get("permissions") or []
    suggested = request.get("permission_suggestions") or []
    shown = [json.loads(redact(json.dumps(s, ensure_ascii=False))) for s in suggested]
    granted = []
    for p in permissions if isinstance(permissions, list) else [None]:
        if p in shown:
            granted.append(suggested[shown.index(p)])  # the CLI's own object, key included
        elif request.get("tool_name") == "ExitPlanMode" and _is_set_mode(p):
            granted.append(p)
        else:
            raise ValueError("Invalid permission update")
    if granted:
        out["updatedPermissions"] = granted
    return out


class Run:
    """One turn in flight. Sockets subscribe to it; its events are kept for re-attach."""

    def __init__(self, session_id: str | None):
        self.key = session_id or f"new:{uuid.uuid4()}"
        self.session_id = session_id
        self.proc: asyncio.subprocess.Process | None = None
        self.task: asyncio.Task | None = None
        self.events: list[str] = []
        self.subscribers: dict[int, Callable[[str], None]] = {}
        self.history_bytes: int | None = None
        self.done = False
        # Questions the CLI is waiting on, by request id: the original request, the (redacted) event the page got
        # and the redactor. Re-attaching pages get the open ones from here, not from the replay.
        self.prompts: dict[str, tuple[dict, str, Callable[[str], str]]] = {}

    def emit(self, raw: str, keep: bool = True) -> None:
        # Live deltas are not replayed: the full assistant message follows each of them.
        if keep and '"stream_event"' not in raw[:60] and len(self.events) < REPLAY_LIMIT:
            self.events.append(raw)
        for send in list(self.subscribers.values()):
            send(raw)

    def set_session(self, session_id: str) -> None:
        if self.session_id == session_id:
            return
        RUNS.pop(self.key, None)
        self.key = self.session_id = session_id
        RUNS[session_id] = self
        self.emit(json.dumps({"type": "session", "session_id": session_id}))

    async def execute(self, text: str, images: list[dict], model: str | None, provider_id: str | None,
                      permission_mode: str, effort: str | None, client_id: str | None,
                      cwd: Path | None = None, locked: bool = False) -> None:
        def started(proc, provider_name):
            self.proc = proc
            self.emit(json.dumps({"type": "turn_start", "client_id": client_id, "text": text,
                                  "images": len(images), "model": model or "default",
                                  "provider": provider_name, "provider_id": provider_id,
                                  "permission_mode": permission_mode, "effort": effort,
                                  "cwd": str(cwd) if cwd else None, "locked": locked}))

        self.emit(json.dumps({"type": "status", "state": "thinking", "msg": ""}))
        try:
            if self.session_id:
                self.history_bytes = await asyncio.to_thread(claude_sessions.transcript_size, self.session_id)
            sid, _ = await _run_turn(text, images, self.session_id, model, self.emit, provider_id=provider_id,
                                     permission_mode=permission_mode, effort=effort, on_start=started,
                                     on_session=self.set_session, cwd=cwd, locked=locked, on_control=self.control)
            if sid:
                self.set_session(sid)
        except asyncio.CancelledError:
            log.info("Turn cancelled")
        except Exception as e:
            log.error("Claude turn failed (%s)", type(e).__name__)
            self.emit(json.dumps({
                "type": "assistant",
                "error": str(e) if isinstance(e, (providers.ProviderError, TurnError)) else "Unable to run Claude Code. Check provider settings and try again.",
                "is_api_error_message": True,
            }))
        finally:
            await self._reap()
            for request_id in list(self.prompts):
                self._close_prompt(request_id, cancelled=True)
            self.done = True
            RUNS.pop(self.key, None)
            self.emit(json.dumps({"type": "status", "state": "idle", "msg": ""}))

    async def control(self, obj: dict, redact: Callable[[str], str] = lambda raw: raw) -> None:
        """A control message from the CLI. can_use_tool becomes a prompt on the page; a cancel takes one back
        (the CLI cancels on interrupt); anything else (MCP elicitation, ...) is refused so the CLI doesn't wait."""
        request_id = obj.get("request_id")
        if not isinstance(request_id, str) or not request_id:
            return
        if obj.get("type") == "control_cancel_request":
            self._close_prompt(request_id, cancelled=True)
            return
        request = obj.get("request") if isinstance(obj.get("request"), dict) else {}
        if request.get("subtype") != "can_use_tool" or not isinstance(request.get("tool_name"), str):
            await self._respond(request_id, error=f"The dashboard can't answer {request.get('subtype')!r} requests")
            return
        fields = {k: request[k] for k in PROMPT_FIELDS if request.get(k) is not None}
        if isinstance(fields.get("decision_reason"), str):
            fields["decision_reason"] = _strip_ansi(fields["decision_reason"])
        event = redact(json.dumps({"type": "prompt", "request_id": request_id, **fields}, ensure_ascii=False))
        self.prompts[request_id] = (request, event, redact)
        self.emit(event, keep=False)

    async def answer(self, request_id: str, msg: dict) -> bool:
        """The page's answer to a prompt. False when it is no longer open (answered in another tab, withdrawn)."""
        entry = self.prompts.get(request_id)
        if entry is None or self.done:
            return False
        result = _permission_result(entry[0], msg, entry[2])  # ValueError: the prompt stays open
        del self.prompts[request_id]  # before any await: a second answer (another tab) finds it closed
        sent = await self._respond(request_id, response=result)
        self.emit(json.dumps({"type": "prompt_done", "request_id": request_id,
                              **({"behavior": result["behavior"]} if sent else {"cancelled": True})}), keep=False)
        return True

    def _close_prompt(self, request_id: str, **detail) -> None:
        if self.prompts.pop(request_id, None) is not None:
            self.emit(json.dumps({"type": "prompt_done", "request_id": request_id, **detail}), keep=False)

    async def _respond(self, request_id: str, response: dict | None = None, error: str | None = None) -> bool:
        proc = self.proc
        if proc is None or proc.returncode is not None or not proc.stdin or proc.stdin.is_closing():
            return False
        body = ({"subtype": "error", "request_id": request_id, "error": error} if error is not None
                else {"subtype": "success", "request_id": request_id, "response": response})
        try:
            proc.stdin.write((json.dumps({"type": "control_response", "response": body}, ensure_ascii=False) + "\n").encode())
            await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError, RuntimeError):
            return False
        return True

    async def interrupt(self) -> None:
        """Ask the CLI to stop (it records the interruption), then escalate to signals."""
        proc = self.proc
        if proc is None:
            if self.task and not self.task.done():
                self.task.cancel()
            return
        if proc.returncode is None and proc.stdin and not proc.stdin.is_closing():
            request = {"type": "control_request", "request_id": f"interrupt-{uuid.uuid4().hex[:8]}",
                       "request": {"subtype": "interrupt"}}
            try:
                proc.stdin.write((json.dumps(request) + "\n").encode())
                await proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError, RuntimeError):
                pass
        for sig, wait in ((None, 5), (signal.SIGINT, 3), (signal.SIGKILL, 3)):
            if proc.returncode is not None:
                break
            if sig is not None:
                try:
                    proc.send_signal(sig)
                except ProcessLookupError:
                    break
            try:
                await asyncio.wait_for(proc.wait(), timeout=wait)
            except asyncio.TimeoutError:
                continue

    async def _reap(self) -> None:
        proc = self.proc
        if proc is None or proc.returncode is not None:
            return
        try:
            await asyncio.wait_for(proc.wait(), timeout=10)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            try:
                proc.kill()
            except ProcessLookupError:
                pass


RUNS: dict[str, Run] = {}


def running_ids() -> set[str]:
    return {run.session_id for run in RUNS.values() if run.session_id and not run.done}


# ---------------------------------------------------------------------------
# Capabilities: the CLI's own command list, agents and models (no API call)
# ---------------------------------------------------------------------------

_capabilities: dict[str, tuple[float, dict]] = {}  # per folder: its skills and commands differ
_capabilities_lock = asyncio.Lock()


def _routes() -> list[dict]:
    """Router-combo entries whose provider is configured and enabled."""
    try:
        records = providers.get_registry().records
    except providers.ProviderError:
        return []
    out = []
    for value, route in OFFICIAL_ROUTES.items():
        record = next((r for r in records if r["id"] == route["provider_id"] and r["enabled"]), None)
        if record:
            out.append({"value": value, "display_name": route["name"], "effort_levels": [],
                        "description": f"{route['description']} · via {record['name']}",
                        "route": {"model": route["model"], "provider_id": route["provider_id"]}})
    return out


async def capabilities(refresh: bool = False, cwd: Path | None = None) -> dict:
    folder = cwd or claude_workspace.cwd()
    async with _capabilities_lock:
        cached = _capabilities.get(str(folder))
        if refresh or not cached or time.time() - cached[0] >= CAPABILITIES_TTL:
            cached = (time.time(), await _probe_capabilities(folder))
            _capabilities[str(folder)] = cached
    missing = claude_workspace.sandbox_missing()  # live: installing them shouldn't wait for the cache
    combos = [{"value": v, "display_name": c["name"], "description": c["description"], "effort_levels": []}
              for v, c in OFFICIAL_COMBOS.items()]
    models = [*combos, *_routes(), *cached[1]["models"]]
    return {**cached[1], "models": models, "sandbox": {"available": not missing, "missing": missing}}


async def _control(folder: Path, request: dict, timeout: float = 45) -> dict:
    """Send one SDK control request to a throwaway CLI on the official login and return its answer."""
    u = _user()
    proc = await asyncio.create_subprocess_exec(
        CLAUDE_BIN, "--print", "--input-format=stream-json", "--output-format=stream-json", "--verbose",
        "--no-session-persistence", "--permission-prompts", "none",
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        env=_claude_env(), cwd=folder, limit=16 * 1024 * 1024,
        preexec_fn=lambda: (os.setgid(u.pw_gid), os.setuid(u.pw_uid)),
    )
    subtype = request["subtype"]
    request_id = f"{subtype}-{uuid.uuid4().hex[:8]}"
    try:
        assert proc.stdin and proc.stdout
        proc.stdin.write((json.dumps({"type": "control_request", "request_id": request_id,
                                      "request": request}) + "\n").encode())
        await proc.stdin.drain()

        async def answer() -> dict:
            while line := await proc.stdout.readline():  # type: ignore[union-attr]
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                response = obj.get("response") if obj.get("type") == "control_response" else None
                if isinstance(response, dict) and response.get("request_id") == request_id:
                    if response.get("subtype") != "success":
                        raise RuntimeError(str(response.get("error") or f"{subtype} failed"))
                    return response.get("response") or {}
            raise RuntimeError("Claude Code exited before answering")

        return await asyncio.wait_for(answer(), timeout=timeout)
    finally:
        if proc.returncode is None:
            proc.kill()
        await proc.wait()


async def _probe_capabilities(folder: Path) -> dict:
    """The SDK `initialize` answer: commands, agents, models and account."""
    data = await _control(folder, {"subtype": "initialize"})

    def text(value, limit):
        return " ".join(str(value or "").split())[:limit]

    commands = []
    for c in data.get("commands") or []:
        name = str(c.get("name", ""))
        if not name or name.startswith("__"):
            continue
        commands.append({"name": name, "description": text(c.get("description"), 400),
                         "argument_hint": text(c.get("argumentHint"), 120),
                         "aliases": [str(a) for a in c.get("aliases") or []],
                         "builtin": bool(c.get("builtin"))})
    account = data.get("account") or {}
    return {
        "version": data.get("claude_code_version"),
        "commands": commands,
        "agents": [{"name": str(a.get("name", "")), "description": text(a.get("description"), 300)}
                   for a in data.get("agents") or [] if a.get("name")],
        "models": [{"value": str(m.get("value", "")), "display_name": text(m.get("displayName"), 80),
                    "description": text(m.get("description"), 160),
                    "effort_levels": [str(e) for e in m.get("supportedEffortLevels") or []]}
                   for m in data.get("models") or [] if m.get("value")],
        "output_style": data.get("output_style"),
        "output_styles": [str(s) for s in data.get("available_output_styles") or []],
        "account": {"subscription": account.get("subscriptionType"), "provider": account.get("apiProvider")},
        "cwd": str(folder),
        "home": str(claude_workspace.home()),
        "memory": {scope: str(path) for scope, path in claude_workspace.memory_files(folder).items()},
    }


# ---------------------------------------------------------------------------
# Plan limits: the official login's 5-hour and weekly windows (no model call)
# ---------------------------------------------------------------------------

_SEVERITY = {"allowed": "normal", "allowed_warning": "warning", "rejected": "critical"}
# `limits` rows the page names itself; other kinds are labelled from their group and scope.
_LIMIT_KINDS = {"session": ("five_hour", "5-hour"), "weekly_all": ("seven_day", "Weekly")}
# What a CLI without `limits` rows reports, and what a turn's rate_limit_event carries (first two).
_NAMED_WINDOWS = (("five_hour", "5-hour"), ("seven_day", "Weekly"),
                  ("seven_day_opus", "Weekly · Opus"), ("seven_day_sonnet", "Weekly · Sonnet"))

_limits: dict = {"data": None, "at": 0.0, "error": None}
_limits_lock = asyncio.Lock()


def _epoch(value) -> int | None:
    """Unix seconds from an ISO timestamp (get_usage) or seconds already (rate_limit_event)."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str) and value:
        try:
            return int(datetime.fromisoformat(value).timestamp())
        except ValueError:
            return None
    return None


def _window(key: str, label: str, percent, resets_at, severity=None, active=False) -> dict:
    try:
        pct = max(0.0, float(percent))  # can pass 100: low-priority work may run past a cap
    except (TypeError, ValueError):
        pct = 0.0
    return {"key": key[:120], "label": label[:80], "percent": round(pct, 1), "resets_at": _epoch(resets_at),
            "severity": str(severity or "normal")[:32], "active": bool(active)}


def _windows(limits: dict) -> list[dict]:
    rows = []
    for row in limits.get("limits") or []:
        if not isinstance(row, dict):
            continue
        kind = str(row.get("kind") or "")
        scope = row.get("scope") if isinstance(row.get("scope"), dict) else {}
        name = next((str(s["display_name"]) for s in (scope.get("model"), scope.get("surface"))
                     if isinstance(s, dict) and s.get("display_name")), None)
        if kind in _LIMIT_KINDS and not name:
            key, label = _LIMIT_KINDS[kind]
        else:
            group = str(row.get("group") or kind).replace("_", " ").strip().capitalize() or "Limit"
            key, label = f"{kind}:{name or len(rows)}", f"{group} · {name}" if name else group
        rows.append(_window(key, label, row.get("percent"), row.get("resets_at"), row.get("severity"),
                            row.get("is_active")))
    if rows:
        return rows
    for key, label in _NAMED_WINDOWS:
        w = limits.get(key)
        if isinstance(w, dict) and w.get("utilization") is not None:
            rows.append(_window(key, label, w["utilization"], w.get("resets_at")))
    for m in limits.get("model_scoped") or []:
        if isinstance(m, dict) and m.get("utilization") is not None and m.get("display_name"):
            name = str(m["display_name"])
            rows.append(_window(f"model:{name}", f"Weekly · {name}", m["utilization"], m.get("resets_at")))
    return rows


def _plan_limits(usage: dict) -> dict:
    """The part of a `get_usage` answer the page shows."""
    limits = usage.get("rate_limits") if isinstance(usage.get("rate_limits"), dict) else None
    return {"available": bool(usage.get("rate_limits_available")), "subscription": usage.get("subscription_type"),
            "windows": _windows(limits) if limits else [], "fetched_at": time.time(), "source": "usage"}


async def plan_limits(refresh: bool = False) -> dict:
    """The official login's plan limits, whatever model a chat uses. One probe serves every page
    for LIMITS_TTL seconds, a refresh asks again after LIMITS_MIN_INTERVAL; official turns move the
    5-hour and weekly rows in between (note_rate_limit)."""
    async with _limits_lock:
        due = LIMITS_MIN_INTERVAL if refresh else LIMITS_TTL
        never = _limits["data"] is None and _limits["error"] is None
        if never or time.time() - _limits["at"] >= due:
            before = _limits["data"]
            try:
                answer = await _control(claude_workspace.home(), {"subtype": "get_usage", "skip_behaviors": True},
                                        timeout=30)
                fresh = _plan_limits(answer)
                if fresh["available"] and not isinstance(answer.get("rate_limits"), dict):
                    # The usage endpoint refused (usually 429): keep the last reading rather than blank it.
                    kept = _limits["data"] if _limits["data"] and _limits["data"]["available"] else None
                    if kept:
                        now = time.time()
                        kept = {**kept, "subscription": kept.get("subscription") or fresh["subscription"],
                                "windows": [w if not w["resets_at"] or w["resets_at"] > now
                                            else {**w, "percent": 0.0, "resets_at": None, "severity": "normal"}
                                            for w in kept["windows"]]}
                    # A turn that landed while this probe ran is current: no error over it.
                    error = None if kept and _limits["data"] is not before else (
                        "Anthropic's usage endpoint didn't answer (often rate-limited). The limits show up "
                        "with the next official chat turn or in a few minutes.")
                    _limits.update(data=kept or fresh, error=error)
                else:
                    _limits.update(data=fresh, error=None)
            except Exception as exc:
                log.warning("get_usage failed: %s", exc)
                _limits["error"] = f"Claude Code didn't report the plan limits: {str(exc)[:200] or type(exc).__name__}"
            _limits["at"] = time.time()
        data = _limits["data"] or {"available": False, "subscription": None, "windows": [], "fetched_at": None,
                                   "source": None}
        return {**data, "error": _limits["error"]}


def note_rate_limit(info: dict) -> dict | None:
    """Fold an official turn's rate_limit_event (a 0-1 fraction, epoch seconds) into the cached limits
    and return them, so the page moves while Claude works instead of at the next poll."""
    windows = info.get("unifiedWindows") if isinstance(info.get("unifiedWindows"), dict) else {}
    cached = _limits["data"]
    base = cached if cached and cached.get("available") else {"available": True, "subscription": None, "windows": []}
    rows = [dict(w) for w in base["windows"]]
    changed = False
    for key, label in _NAMED_WINDOWS[:2]:
        w = windows.get(key)
        if not isinstance(w, dict) or w.get("utilization") is None:
            continue
        row = next((r for r in rows if r["key"] == key), None)
        if row is None:
            row = _window(key, label, 0, None)
            rows.append(row)
        fresh = _window(key, label, (w["utilization"] or 0) * 100, w.get("resetsAt"),
                        _SEVERITY.get(w.get("status")) or row["severity"])
        row.update(percent=fresh["percent"], resets_at=fresh["resets_at"] or row["resets_at"],
                   severity=fresh["severity"])
        changed = True
    if not changed:
        return None
    data = {**base, "windows": rows, "fetched_at": time.time(), "source": "turn"}
    # The headers don't carry the scoped weekly rows; the next scheduled probe brings them.
    _limits.update(data=data, error=None)
    return {**data, "error": None}


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------

def _validate_sid(value) -> str | None:
    if value in (None, ""):
        return None
    if not isinstance(value, str) or not claude_sessions.UUID_RE.match(value):
        raise ValueError("Invalid session ID")
    return value


async def handle_ws(ws: WebSocket):
    await ws.accept()

    outbox: asyncio.Queue[str] = asyncio.Queue()
    conn = id(outbox)

    def send(raw: str) -> None:
        if outbox.qsize() > OUTBOX_LIMIT and '"stream_event"' in raw[:40]:
            return  # a stalled client loses live deltas, never the final messages
        outbox.put_nowait(raw)

    async def writer():
        while True:
            raw = await outbox.get()
            await ws.send_text(raw)

    writer_task = asyncio.ensure_future(writer())
    send(json.dumps({"type": "status", "state": "idle", "msg": "ready"}))

    session_id: str | None = None
    session_model: str | None = None
    session_provider_id: str | None = None
    session_cwd: str | None = None  # the followed session's folder; None for a new chat
    attached: Run | None = None
    bash_task: asyncio.Task | None = None

    def turn_folder(msg: dict) -> Path:
        """An existing session keeps its folder (--resume only finds it there); a new chat takes the
        folder picked on the page."""
        asked = msg.get("cwd") if isinstance(msg.get("cwd"), str) and msg.get("cwd") else None
        if session_id:
            folder = claude_workspace.folder(session_cwd)
            if asked and claude_workspace.folder(asked) != folder:
                raise ValueError(f"This conversation works in {folder}. Start a new chat to use another folder.")
            return folder
        return claude_workspace.folder(asked)

    def detach() -> None:
        nonlocal attached
        if attached:
            attached.subscribers.pop(conn, None)
            attached = None

    def error(msg: str) -> None:
        send(json.dumps({"type": "status", "state": "error", "msg": msg}))

    async def bash(command: str, client_id, folder: Path) -> None:
        send(json.dumps({"type": "bash_start", "client_id": client_id, "command": command}))
        try:
            result = await claude_workspace.run_bash(command, _claude_env(), folder)
        except asyncio.CancelledError:
            result = {"stdout": "", "stderr": "Interrupted", "code": None}
        except OSError as exc:
            result = {"stdout": "", "stderr": f"Could not run the command ({exc.strerror or exc})", "code": None}
        send(json.dumps({"type": "bash_result", "client_id": client_id, "command": command, **result}))

    try:
        while True:
            raw_ws = await ws.receive_text()
            try:
                msg = json.loads(raw_ws)
            except json.JSONDecodeError:
                continue
            if not isinstance(msg, dict):
                continue
            if attached is not None:
                session_id = attached.session_id or session_id
                if attached.done:
                    detach()

            kind = msg.get("type")

            if kind == "interrupt":
                if bash_task and not bash_task.done():
                    bash_task.cancel()
                run = attached or (RUNS.get(session_id) if session_id else None)
                if run and not run.done:
                    await run.interrupt()
                else:
                    send(json.dumps({"type": "status", "state": "idle", "msg": ""}))
                continue

            if kind == "answer":
                request_id = msg.get("request_id")
                run = attached or (RUNS.get(session_id) if session_id else None)
                try:
                    handled = isinstance(request_id, str) and run is not None and await run.answer(request_id, msg)
                except ValueError as exc:
                    error(str(exc))
                    if run is not None and request_id in run.prompts:
                        send(run.prompts[request_id][1])  # still open: the page dropped it when it answered
                    continue
                if not handled:
                    # Answered in another tab, withdrawn by the CLI, or the turn is over: drop it from this page.
                    send(json.dumps({"type": "prompt_done", "request_id": request_id, "cancelled": True}))
                continue

            if kind == "resume":
                try:
                    given_sid = _validate_sid(msg.get("session_id"))
                except ValueError as exc:
                    error(str(exc))
                    continue
                detach()
                session_id = given_sid
                binding = await asyncio.to_thread(claude_sessions.get_session_binding, given_sid) if given_sid else None
                session_model = binding.get("model") if binding else None
                session_provider_id = binding.get("provider_id") if binding else None
                session_cwd = await asyncio.to_thread(claude_sessions.session_cwd, given_sid) if given_sid else None
                run = RUNS.get(given_sid) if given_sid else None
                if given_sid:
                    try:
                        detail = await asyncio.to_thread(claude_sessions.get_session, given_sid,
                                                         run.history_bytes if run else None)
                    except HTTPException:
                        # A new session's transcript may not exist yet while its first turn runs.
                        detail = {"id": given_sid, "messages": [], "missing": run is None}
                    send(json.dumps({"type": "history", "session_id": given_sid, **detail}, ensure_ascii=False))
                # Replay and subscribe without awaiting in between: no live event can overtake it.
                run = RUNS.get(given_sid) if given_sid else None
                if run is not None:
                    for raw in list(run.events):
                        send(raw)
                    for _, event, _ in run.prompts.values():
                        send(event)  # open prompts aren't in the replay, which may also be full
                    if not run.done:
                        attached = run
                        run.subscribers[conn] = send
                send(json.dumps({"type": "attached", "session_id": given_sid, "running": attached is not None}))
                continue

            if kind == "bash":
                command = str(msg.get("command", "")).strip()
                if not command:
                    continue
                if bash_task and not bash_task.done():
                    error("A bash command is still running")
                    continue
                try:
                    folder = turn_folder(msg)
                except ValueError as exc:
                    error(str(exc))
                    continue
                bash_task = asyncio.ensure_future(bash(command, msg.get("client_id"), folder))
                continue

            if kind != "user":
                continue

            # --- New user turn ---
            if (attached and not attached.done) or (session_id and session_id in running_ids()):
                error("This session is still working. Wait for it or press Stop.")
                continue

            text = str(msg.get("text", ""))
            images = msg.get("images") if isinstance(msg.get("images"), list) else []
            if "model" in msg:
                model_value = msg["model"]
                if model_value is not None and not isinstance(model_value, str):
                    error("Invalid model")
                    continue
                if model_value != session_model and "provider_id" not in msg:
                    session_provider_id = None
                session_model = model_value
            if "provider_id" in msg:
                provider_value = msg["provider_id"]
                if provider_value is not None and (not isinstance(provider_value, str) or not provider_value):
                    error("Invalid provider")
                    continue
                session_provider_id = provider_value
            mode = msg.get("permission_mode") or "bypassPermissions"
            effort = msg.get("effort") or None
            if mode not in PERMISSION_MODES or (effort is not None and effort not in EFFORT_LEVELS):
                error("Invalid permission mode or effort")
                continue
            client_id = msg.get("client_id") if isinstance(msg.get("client_id"), str) else None

            try:
                folder = turn_folder(msg)
            except ValueError as exc:
                error(str(exc))
                continue
            session_cwd = str(folder)
            locked = msg.get("locked") is True

            run = Run(session_id)
            RUNS[run.key] = run
            attached = run
            run.subscribers[conn] = send
            run.task = asyncio.ensure_future(run.execute(
                text, images, session_model, session_provider_id, mode, effort, client_id, folder, locked))

    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.exception("Claude chat error: %s", e)
        try:
            await ws.send_text(json.dumps({"type": "status", "state": "error", "msg": str(e)}))
        except Exception:
            pass
    finally:
        # The turn keeps running without this socket; resuming its session re-attaches.
        detach()
        if bash_task and not bash_task.done():
            bash_task.cancel()
        writer_task.cancel()

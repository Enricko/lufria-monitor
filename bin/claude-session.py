#!/usr/bin/env python3
"""List/resume Monitor Claude sessions with their saved provider binding.

Keys are resolved internally and passed only through exec environment, never argv.
"""
import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import pwd
import sys

ROOT = Path(__file__).resolve().parents[1]
venv_py = ROOT / "backend" / ".venv" / "bin" / "python3"
if venv_py.exists() and os.path.realpath(sys.executable) != os.path.realpath(str(venv_py)):
    os.execv(str(venv_py), [str(venv_py)] + sys.argv)

sys.path.insert(0, str(ROOT / "backend"))
from app import claude_chat, claude_sessions, providers


def prepare(session_id):
    detail = claude_sessions.get_session(session_id)
    binding = claude_sessions.get_session_binding(session_id)
    model = (binding or {}).get("model") or detail.get("model")
    provider_id = (binding or {}).get("provider_id")
    command = [claude_chat.CLAUDE_BIN, "--resume", session_id]
    custom = provider_id is not None or (model and model not in ("default", "claude-default", "Claude Code") and not model.startswith("claude-"))
    if custom:
        base_url, key, provider_name = providers.resolve_model(model, provider_id)
        env = claude_chat._claude_env(base_url.rstrip("/").removesuffix("/v1").rstrip("/"), key)
    else:
        provider_name = "Claude native"
        env = claude_chat._claude_env()
        # A terminal's stale custom endpoint must not override a native binding.
        env.pop("ANTHROPIC_BASE_URL", None)
    if model and model not in ("Claude Code",) and (custom or model not in ("default", "claude-default")):
        command.extend(["--model", model])
    return command, env, {"session_id": session_id, "model": model or "default", "provider": provider_name, "provider_id": provider_id, "ready": True}


def main():
    parser = argparse.ArgumentParser(description="List/resume Claude Code sessions from Monitor, including custom models")
    parser.add_argument("action", nargs="?", choices=("list", "resume", "check"), default="list")
    parser.add_argument("session_id", nargs="?")
    parser.add_argument("--limit", type=int, default=15)
    args = parser.parse_args()
    user = pwd.getpwnam("lufria")
    if os.geteuid() == 0:
        os.initgroups(user.pw_name, user.pw_gid)
        os.setgid(user.pw_gid)
        os.setuid(user.pw_uid)
    if os.geteuid() != user.pw_uid:
        parser.error("Run as lufria (or root, which drops to lufria)")
    os.environ["HOME"] = user.pw_dir
    try:
        if args.action == "list":
            sessions = sorted(claude_sessions.list_sessions(), key=lambda s: s["updated_at"], reverse=True)
            for s in sessions[:max(1, min(args.limit, 100))]:
                when = datetime.fromtimestamp(s["updated_at"]).astimezone().strftime("%d %b %H:%M")
                title = " ".join(str(s["title"]).split())[:70]
                route = s.get("provider") or "legacy/native"
                print(f'{s["id"]}  {when}  {s.get("model", "default")}  [{route}]\n  {title}')
            print("\nOpen: claude-session resume <SESSION_ID>")
            return
        if not args.session_id:
            parser.error("session_id is required for resume/check")
        command, env, info = prepare(args.session_id)
        if args.action == "check":
            print(json.dumps(info, ensure_ascii=False, indent=2))
            return
        if not sys.stdin.isatty():
            parser.error("resume requires an interactive terminal")
        print(f'Opening {info["session_id"]} · {info["provider"]} · {info["model"]}', flush=True)
        os.chdir(user.pw_dir)
        os.execve(command[0], command, env)
    except Exception:
        print("Could not load session/provider. Check the session ID and provider settings in Monitor.", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()

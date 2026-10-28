"""PreToolUse hook for a Claude Code chat locked to its folder (see claude_workspace.folder_lock_settings).

Usage: python -I folder_guard.py <allowed folder>...   with the hook's JSON on stdin.
Refuses Edit/Write/MultiEdit/NotebookEdit on a path that resolves (symlinks included) outside every
allowed folder. Anything it can't read is refused too: a broken guard must not open the lock.
"""
import json
import os
import sys


def target(payload: dict) -> str | None:
    tool_input = payload.get("tool_input") or {}
    path = tool_input.get("file_path") or tool_input.get("notebook_path")
    if not isinstance(path, str) or not path:
        return None
    base = payload.get("cwd") if isinstance(payload.get("cwd"), str) else os.getcwd()
    return os.path.realpath(os.path.join(base, os.path.expanduser(path)))


def inside(path: str, root: str) -> bool:
    root = os.path.realpath(root)
    return path == root or path.startswith(root.rstrip("/") + "/")


def decide(payload: dict, allowed: list[str]) -> str | None:
    """None to allow, else the reason for refusing."""
    path = target(payload)
    if path is None:
        return "The folder lock couldn't tell which file this edit is for."
    if any(inside(path, root) for root in allowed):
        return None
    return (f"This chat is locked to {allowed[0]}: {path} is outside it, so it can't be changed. "
            "Work inside the folder, or ask the user to unlock the folder in the dashboard.")


def main() -> None:
    allowed = sys.argv[1:]
    try:
        payload = json.load(sys.stdin)
        reason = decide(payload, allowed) if allowed and isinstance(payload, dict) else "The folder lock is misconfigured."
    except (ValueError, OSError):
        reason = "The folder lock couldn't read this tool call."
    if reason:
        json.dump({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                          "permissionDecisionReason": reason}}, sys.stdout)


if __name__ == "__main__":
    main()

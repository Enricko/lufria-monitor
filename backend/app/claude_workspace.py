"""What the Claude Code page does outside the CLI: `!` bash mode, `#` memory notes, `@` file search,
and the folder a chat works in.

All of it runs as the dashboard user in the chat's folder, which is also where every Claude Code turn
starts (so ./CLAUDE.md there is the project memory the CLI loads). A chat can be locked to its folder:
see folder_lock_settings().
"""
import asyncio
import os
import pwd
import re
import shlex
import shutil
import signal
import stat
import sys
from pathlib import Path

CLAUDE_USER = "lufria"
BASH_TIMEOUT = 300
BASH_OUTPUT_LIMIT = 30_000
MEMORY_LIMIT = 512 * 1024
SEARCH_SKIP = {".git", "node_modules", ".venv", "venv", "__pycache__", ".cache", ".npm", ".local", ".cargo",
               ".rustup", "dist", "build", ".next", "snap", ".mozilla", ".vscode-server", "go", ".gradle"}
SEARCH_MAX_ENTRIES = 40_000
FOLDER_LIST_LIMIT = 500
SANDBOX_TOOLS = ("bwrap", "socat")  # what Claude Code's sandbox needs on Linux
GUARD_SCRIPT = Path(__file__).with_name("folder_guard.py")
WRITE_TOOLS = "Edit|Write|MultiEdit|NotebookEdit"
SANDBOX_HIDDEN_SOCKETS = ["/var/run/docker.sock", "/run/docker.sock", "/run/podman/podman.sock"]
PREVIEW_TEXT_LIMIT = 512 * 1024
PREVIEW_IMAGE_LIMIT = 25 * 1024 * 1024
DIR_LIST_LIMIT = 2000
STAT_LIMIT = 20
# Shown inline by the viewer and as chat attachments; any other file is download-only.
MEDIA_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
               ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon",
               ".svg": "image/svg+xml",
               ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
               ".ogv": "video/ogg",
               ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg",
               ".opus": "audio/ogg", ".m4a": "audio/mp4", ".flac": "audio/flac", ".aac": "audio/aac"}


def home() -> Path:
    return Path(pwd.getpwnam(CLAUDE_USER).pw_dir)


def cwd() -> Path:
    """Default folder of a new chat."""
    return home()


def folder(path: str | None) -> Path:
    """A chat's folder: an existing directory given as an absolute (or ~) path; home when not given."""
    if not path:
        return cwd()
    p = Path(path).expanduser()
    if not p.is_absolute():
        raise ValueError("Folder must be an absolute path")
    p = p.resolve()
    if not p.is_dir():
        raise ValueError(f"Not a folder: {p}")
    if not os.access(p, os.R_OK | os.X_OK):
        raise ValueError(f"No access to {p}")
    return p


def project_dir_name(path: str | Path) -> str:
    """Claude Code keeps a folder's sessions in ~/.claude/projects/<this>."""
    return re.sub(r"[^A-Za-z0-9]", "-", str(path))


def list_folders(path: str | None) -> dict:
    """Folder picker: the sub-folders of one folder."""
    base = folder(path)
    dirs = []
    try:
        with os.scandir(base) as it:
            for entry in it:
                try:
                    if entry.is_dir() and not entry.name.startswith("."):
                        dirs.append(entry.name)
                except OSError:
                    continue
    except OSError as exc:
        raise ValueError(f"Can't read {base}: {exc.strerror}") from None
    dirs.sort(key=str.lower)
    return {
        "path": str(base),
        "parent": str(base.parent) if base != base.parent else None,
        "home": str(home()),
        "writable": os.access(base, os.W_OK),
        "dirs": [{"name": d, "path": str(base / d)} for d in dirs[:FOLDER_LIST_LIMIT]],
        "truncated": len(dirs) > FOLDER_LIST_LIMIT,
    }


def preview_path(path: str, root: Path | None = None) -> Path:
    """A path from the chat (absolute, ~ or relative to the chat's folder), resolved."""
    if "\0" in path:
        raise ValueError("Invalid path")
    try:
        p = Path(path).expanduser() if path else (root or cwd())
    except RuntimeError:  # ~nosuchuser
        raise ValueError(f"Unknown home folder: {path}") from None
    return (p if p.is_absolute() else (root or cwd()) / p).resolve()


def list_dir(path: str, root: Path | None = None) -> dict:
    """File viewer: the files and folders of one folder, folders first."""
    base = preview_path(path, root)
    if not base.is_dir():
        raise ValueError(f"Not a folder: {base}")
    entries = []
    try:
        with os.scandir(base) as it:
            for entry in it:
                try:
                    is_dir = entry.is_dir()
                    size = None if is_dir else entry.stat().st_size
                except OSError:  # broken symlink, vanished
                    is_dir, size = False, None
                entries.append({"name": entry.name, "dir": is_dir, "size": size})
    except OSError as exc:
        raise ValueError(f"Can't read {base}: {exc.strerror}") from None
    entries.sort(key=lambda e: (not e["dir"], e["name"].lower()))
    return {
        "path": str(base),
        "parent": str(base.parent) if base != base.parent else None,
        "entries": entries[:DIR_LIST_LIMIT],
        "truncated": len(entries) > DIR_LIST_LIMIT,
    }


def _regular(p: Path) -> os.stat_result:
    """A regular file's stat. Anything else is refused before it's opened (opening a FIFO releases its
    writer, a serial tty resets its board)."""
    if str(p).startswith("/sys/devices/") and (p.name in ("config", "rom") or p.name.startswith("resource")):
        raise ValueError(f"Not previewed: reading {p.name} would wake the PCI device")
    try:
        st = os.stat(p)
    except FileNotFoundError:
        raise ValueError(f"No such file: {p}") from None
    except OSError as exc:
        raise ValueError(f"Can't read {p}: {exc.strerror}") from None
    if not stat.S_ISREG(st.st_mode):
        raise ValueError(f"Not a regular file: {p}")
    return st


def _read_regular(p: Path, limit: int) -> tuple[bytes, os.stat_result]:
    """Up to limit + 1 bytes of a regular file; O_NONBLOCK + fstat cover a swap after the check."""
    _regular(p)
    try:
        fd = os.open(p, os.O_RDONLY | os.O_NONBLOCK)
    except OSError as exc:
        raise ValueError(f"Can't read {p}: {exc.strerror}") from None
    with os.fdopen(fd, "rb") as f:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise ValueError(f"Not a regular file: {p}")
        return f.read(limit + 1), st


def read_preview(path: str, root: Path | None = None) -> dict:
    """File viewer: a file's text, or what kind of file it is (folder, image, video, audio, binary)."""
    p = preview_path(path, root)
    if p.is_dir():
        return {"kind": "dir", "path": str(p), "name": p.name}
    mime = MEDIA_TYPES.get(p.suffix.lower())
    data, st = _read_regular(p, 0 if mime else PREVIEW_TEXT_LIMIT)
    info = {"path": str(p), "name": p.name, "size": st.st_size, "mtime": st.st_mtime}
    if mime:
        kind = mime.split("/")[0]
        if kind == "image" and st.st_size > PREVIEW_IMAGE_LIMIT:
            return {**info, "kind": "binary"}
        return {**info, "kind": kind, "mime": mime}
    if b"\0" in data[:8192]:
        return {**info, "kind": "binary"}
    truncated = len(data) > PREVIEW_TEXT_LIMIT
    text = data[:PREVIEW_TEXT_LIMIT].decode("utf-8", errors="replace")
    return {**info, "kind": "text", "text": text, "truncated": truncated}


def raw_file(path: str, root: Path | None = None, download: bool = False) -> tuple[Path, str, os.stat_result]:
    """A file to send as-is: images, video and audio inline; anything as a download (octet-stream)."""
    p = preview_path(path, root)
    st = _regular(p)
    if not os.access(p, os.R_OK):
        raise ValueError(f"No access to {p}")
    if download:
        return p, "application/octet-stream", st
    mime = MEDIA_TYPES.get(p.suffix.lower())
    if not mime:
        raise ValueError(f"No inline preview for {p.name}")
    if mime.startswith("image/") and st.st_size > PREVIEW_IMAGE_LIMIT:
        raise ValueError(f"Too large to preview: {p}")
    return p, mime, st


def stat_files(paths: list[str], root: Path | None = None, relative: bool = True) -> list[dict]:
    """Chat attachments: which of the paths a reply mentions are files that exist, and what kind.
    `relative=False`: the chat's folder is gone, so relative paths can't mean anything."""
    out = []
    for path in paths[:STAT_LIMIT]:
        if not relative and not path.startswith(("/", "~")):
            out.append({"path": path, "exists": False})
            continue
        try:
            p = preview_path(path, root)
            st = _regular(p)
        except (ValueError, OSError, RuntimeError):
            out.append({"path": path, "exists": False})
            continue
        mime = MEDIA_TYPES.get(p.suffix.lower(), "")
        out.append({"path": path, "exists": True, "resolved": str(p), "name": p.name, "size": st.st_size,
                    "mtime": st.st_mtime, "kind": mime.split("/")[0] if mime else "file"})
    return out


def sandbox_missing() -> list[str]:
    return [tool for tool in SANDBOX_TOOLS if not shutil.which(tool)]


def folder_lock_settings(root: Path) -> dict:
    """--settings for a chat locked to its folder.

    Bash runs in Claude Code's own sandbox (bubblewrap: writes only inside the folder, no sudo, no way
    to opt out per command), and a PreToolUse hook refuses Edit/Write/NotebookEdit outside it. The
    CLI's own plan files and this folder's auto-memory stay writable.
    """
    claude = home() / ".claude"
    allowed = [root, claude / "plans", claude / "projects" / project_dir_name(root) / "memory"]
    guard = " ".join(shlex.quote(str(a)) for a in [sys.executable, "-I", GUARD_SCRIPT, *allowed])
    # Ubuntu's AppArmor userns restriction stops the CLI's seccomp helper, which is what blocks unix
    # sockets; without it, hide the sockets that would act outside the folder (Docker, systemd --user).
    hidden = [p for p in SANDBOX_HIDDEN_SOCKETS + [f"/run/user/{os.getuid()}/bus"] if os.path.exists(p)]
    return {
        "sandbox": {"enabled": True, "failIfUnavailable": True, "autoAllowBashIfSandboxed": True,
                    "allowUnsandboxedCommands": False, "network": {"allowAllUnixSockets": True},
                    "filesystem": {"denyRead": hidden}},
        "hooks": {"PreToolUse": [{"matcher": WRITE_TOOLS, "hooks": [{"type": "command", "command": guard}]}]},
    }


def memory_files(root: Path | None = None) -> dict[str, Path]:
    return {"project": (root or cwd()) / "CLAUDE.md", "user": home() / ".claude" / "CLAUDE.md"}


def read_memory(root: Path | None = None) -> list[dict]:
    out = []
    for scope, path in memory_files(root).items():
        try:
            content = path.read_text("utf-8", errors="replace")[:MEMORY_LIMIT]
            exists = True
        except FileNotFoundError:
            content, exists = "", False
        out.append({"scope": scope, "path": str(path), "exists": exists, "content": content})
    return out


def _memory_path(scope: str, root: Path | None) -> Path:
    path = memory_files(root).get(scope)
    if path is None:
        raise ValueError("Unknown memory scope")
    return path


def append_memory(scope: str, note: str, root: Path | None = None) -> dict:
    """`# note`: add one bullet to a CLAUDE.md, like the terminal's memory shortcut."""
    note = " ".join(note.split())
    if not note or len(note) > 2000:
        raise ValueError("Memory note must contain 1-2000 characters")
    path = _memory_path(scope, root)
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = path.read_text("utf-8", errors="replace") if path.exists() else ""
    sep = "" if not existing or existing.endswith("\n") else "\n"
    with path.open("a", encoding="utf-8") as fh:
        fh.write(f"{sep}- {note}\n")
    return {"scope": scope, "path": str(path)}


def write_memory(scope: str, content: str, root: Path | None = None) -> dict:
    """/memory editor: replace the whole file."""
    if len(content.encode("utf-8")) > MEMORY_LIMIT:
        raise ValueError("Memory file is too large")
    path = _memory_path(scope, root)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.monitor-tmp")
    tmp.write_text(content, "utf-8")
    os.replace(tmp, path)
    return {"scope": scope, "path": str(path)}


def search_files(query: str, limit: int = 40, root: Path | None = None) -> list[dict]:
    """`@` completion: a typed directory is listed, a bare word is found by a bounded walk."""
    query = query.strip().lstrip("@")
    base = root or cwd()
    if "/" in query:
        folder, prefix = query.rsplit("/", 1)
        root = Path(folder or "/").expanduser()
        root = root if root.is_absolute() else base / root
        try:
            entries = sorted(root.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except OSError:
            # Not a real folder from here: match it anywhere in the path instead.
            return [] if query.startswith(("/", "~")) else _walk(base, query.lower(), limit, whole_path=True)
        shown = f"{folder}/" if folder else "/"
        out = []
        for entry in entries:
            if entry.name.lower().startswith(prefix.lower()) and (prefix.startswith(".") or not entry.name.startswith(".")):
                is_dir = entry.is_dir()
                out.append({"path": shown + entry.name + ("/" if is_dir else ""), "dir": is_dir})
                if len(out) >= limit:
                    break
        return out
    return _walk(base, query.lower(), limit)


def _walk(base: Path, needle: str, limit: int, whole_path: bool = False) -> list[dict]:
    matches: list[tuple[int, int, str, bool]] = []
    seen = 0
    for dirpath, dirnames, filenames in os.walk(base):
        rel = Path(dirpath).relative_to(base)
        depth = len(rel.parts)
        dirnames[:] = sorted(d for d in dirnames
                             if d not in SEARCH_SKIP and (needle.startswith(".") or not d.startswith(".")))
        if depth >= 4:
            dirnames[:] = []
        for name, is_dir in [(d, True) for d in dirnames] + [(f, False) for f in filenames]:
            seen += 1
            if needle.startswith(".") or not name.startswith("."):
                low = name.lower()
                path = (rel / name).as_posix() + ("/" if is_dir else "")
                if not needle or needle in (path.lower() if whole_path else low):
                    matches.append((0 if low.startswith(needle) else 1, depth, path, is_dir))
        if seen > SEARCH_MAX_ENTRIES:
            break
    matches.sort(key=lambda m: (m[0], m[1], len(m[2]), m[2]))
    return [{"path": path, "dir": is_dir} for _, _, path, is_dir in matches[:limit]]


async def run_bash(command: str, env: dict, root: Path | None = None) -> dict:
    """`!` bash mode: your own command, so it isn't sandboxed. The process group is killed on timeout
    or when the caller is cancelled."""
    proc = await asyncio.create_subprocess_exec(
        "/bin/bash", "-lc", command, stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        cwd=root or cwd(), env=env, start_new_session=True)
    timed_out = False
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=BASH_TIMEOUT)
    except (asyncio.TimeoutError, asyncio.CancelledError) as exc:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await proc.wait()
        if isinstance(exc, asyncio.CancelledError):
            raise
        timed_out, stdout, stderr = True, b"", f"Timed out after {BASH_TIMEOUT} s".encode()

    def clip(data: bytes) -> str:
        text = data.decode("utf-8", errors="replace")
        return text if len(text) <= BASH_OUTPUT_LIMIT else text[:BASH_OUTPUT_LIMIT] + "\n… (truncated)"

    return {"stdout": clip(stdout), "stderr": clip(stderr), "code": None if timed_out else proc.returncode}

"""Browser terminal: login shells on pseudo-terminals that outlive the WebSocket.

Each session is a login shell for the user the dashboard runs as (never root) on its own PTY. Sessions
live in this process, so a page reload or a dropped tunnel reattaches to the same shell and gets the
output it missed (up to SCROLLBACK bytes). They run inside lufria-monitor.service's cgroup, so
restarting the service ends every session.

Wire format on /ws/terminal/{id}: binary frames carry terminal bytes both ways; text frames are JSON
control messages (client -> server `resize`, server -> client `attach` and `exit`).

Files dropped or pasted into the page are uploaded here (`open_upload`, `finish_upload`) and the page
pastes their path: the browser can't hand the shell a file from the viewer's own computer. Claude Code
attaches a pasted path to a PNG, JPEG, GIF or WebP file as an image and can read any other file.
"""
import asyncio
import contextlib
import fcntl
import json
import os
import pwd
import re
import secrets
import signal
import struct
import subprocess
import termios
import time
from pathlib import Path
from typing import BinaryIO

from fastapi import WebSocket

from .config import UPLOAD_DIR

MAX_SESSIONS = 8
SCROLLBACK = 512 * 1024        # output bytes kept per session and replayed on (re)attach
HIGH_WATER = 1024 * 1024       # stop reading the PTY while a client has this much unsent output...
LOW_WATER = 256 * 1024         # ...and resume once every client is below this
MAX_PENDING_INPUT = 1024 * 1024
MAX_UPLOAD = 100 * 1024 * 1024  # Cloudflare's tunnel refuses bigger request bodies anyway
UPLOAD_TTL = 7 * 86400          # uploads are dropped after this; Claude Code keeps its own copy of images
IMAGE_MAGIC = ((b"\x89PNG\r\n\x1a\n", "png"), (b"\xff\xd8\xff", "jpg"), (b"GIF87a", "gif"), (b"GIF89a", "gif"))

sessions: dict[str, "Session"] = {}


def _user() -> pwd.struct_passwd:
    return pwd.getpwuid(os.getuid())


def _env(user: pwd.struct_passwd) -> dict[str, str]:
    # Clean env: drop systemd's INVOCATION_ID, JOURNAL_STREAM etc.; the login shell sources the rest
    env = {
        "HOME": user.pw_dir, "USER": user.pw_name, "LOGNAME": user.pw_name, "SHELL": user.pw_shell,
        "PATH": os.environ.get("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"),
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "TERM": "xterm-256color", "COLORTERM": "truecolor",
    }
    runtime = f"/run/user/{user.pw_uid}"
    if os.path.isdir(runtime):
        env["XDG_RUNTIME_DIR"] = runtime
    return env


def _size(cols, rows) -> tuple[int, int]:
    def clamp(v, default: int) -> int:
        try:
            return min(max(int(v), 2), 1000)
        except (TypeError, ValueError):
            return default
    return clamp(cols, 80), clamp(rows, 24)


def _set_size(fd: int, cols: int, rows: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


class Client:
    def __init__(self):
        self.queue: asyncio.Queue[bytes | None] = asyncio.Queue()  # None = the shell exited
        self.pending = 0  # queued bytes not yet handed to the socket

    def send(self, data: bytes) -> None:
        self.pending += len(data)
        self.queue.put_nowait(data)


class Session:
    def __init__(self, cols=None, rows=None):
        self.id = secrets.token_hex(4)
        self.created = time.time()
        self.clients: set[Client] = set()
        self.buf = bytearray()   # output bytes [end - len(buf), end)
        self.end = 0             # total output bytes so far; clients resume from an offset into this
        self.exit_code: int | None = None
        self._input = bytearray()
        self._reading = self._writing = False
        self._loop = asyncio.get_running_loop()

        user = _user()
        master, slave = os.openpty()
        _set_size(slave, *_size(cols, rows))
        # setsid --ctty: new session with the PTY as controlling terminal, so job control and ^C work
        self.proc = subprocess.Popen(["setsid", "--ctty", user.pw_shell, "-l"], stdin=slave, stdout=slave,
                                     stderr=slave, cwd=user.pw_dir, env=_env(user))
        os.close(slave)
        os.set_blocking(master, False)
        self.fd = master
        # The shell exiting ends the session even if a background job still holds the terminal open
        self._pidfd = os.pidfd_open(self.proc.pid)
        self._loop.add_reader(self._pidfd, self._on_shell_exit)
        self.resume()
        sessions[self.id] = self

    def info(self) -> dict:
        return {"id": self.id, "created": self.created}

    # --- output -------------------------------------------------------------------------------
    def _read(self) -> bool:
        """Read one chunk from the PTY and fan it out. False once nothing more will come."""
        try:
            data = os.read(self.fd, 65536)
        except BlockingIOError:
            return False
        except OSError:  # EIO: every process closed the terminal
            data = b""
        if not data:
            self._close()
            return False
        self.end += len(data)
        self.buf += data
        if len(self.buf) > SCROLLBACK:
            # cut at a line break near the limit so replay doesn't start mid escape sequence
            cut = len(self.buf) - SCROLLBACK
            nl = self.buf.find(b"\n", cut, cut + 4096)
            del self.buf[:nl + 1 if nl >= 0 else cut]
        for c in self.clients:
            c.send(data)
        return True

    def _on_output(self) -> None:
        if self._read() and any(c.pending > HIGH_WATER for c in self.clients):
            self._loop.remove_reader(self.fd)
            self._reading = False

    def resume(self) -> None:
        if not self._reading and self.fd >= 0 and all(c.pending < LOW_WATER for c in self.clients):
            self._loop.add_reader(self.fd, self._on_output)
            self._reading = True

    def _on_shell_exit(self) -> None:
        while self.fd >= 0 and self._read():  # flush what it printed last
            pass
        self._close()

    # --- input --------------------------------------------------------------------------------
    def write(self, data: bytes) -> None:
        if self.fd < 0 or len(self._input) + len(data) > MAX_PENDING_INPUT:
            return
        self._input += data
        self._flush_input()

    def _flush_input(self) -> None:
        try:
            del self._input[:os.write(self.fd, self._input)]
        except BlockingIOError:
            pass
        except OSError:
            self._input.clear()
        want = bool(self._input)
        if want != self._writing:
            if want:
                self._loop.add_writer(self.fd, self._flush_input)
            else:
                self._loop.remove_writer(self.fd)
            self._writing = want

    def resize(self, cols, rows) -> None:
        if self.fd >= 0:
            _set_size(self.fd, *_size(cols, rows))

    # --- clients ------------------------------------------------------------------------------
    def attach(self, since: int | None) -> tuple[Client, int]:
        """Register a client and queue the output it is missing. `since` is the offset the client
        already has; if that is no longer buffered it gets the whole buffer. Returns the offset the
        queued stream starts at."""
        start = self.end - len(self.buf)
        offset = since if since is not None and start <= since <= self.end else start
        client = Client()
        self.clients.add(client)
        if offset < self.end:
            client.send(bytes(self.buf[offset - start:]))
        return client, offset

    def detach(self, client: Client) -> None:
        self.clients.discard(client)
        self.resume()

    # --- teardown -----------------------------------------------------------------------------
    def signal(self, sig: int) -> None:
        if self.proc.returncode is None:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(self.proc.pid, sig)

    def kill(self) -> None:
        self.signal(signal.SIGHUP)
        self._close()  # closing the master hangs up the terminal for everything still on it

    def _close(self) -> None:
        if self.fd < 0:
            return
        if self._reading:
            self._loop.remove_reader(self.fd)
        if self._writing:
            self._loop.remove_writer(self.fd)
        self._reading = self._writing = False
        os.close(self.fd)
        self.fd = -1
        self._loop.remove_reader(self._pidfd)
        os.close(self._pidfd)
        sessions.pop(self.id, None)
        self._reaper = asyncio.ensure_future(self._reap())

    async def _reap(self) -> None:
        try:
            await asyncio.to_thread(self.proc.wait, 3)
        except subprocess.TimeoutExpired:
            self.signal(signal.SIGKILL)
            await asyncio.to_thread(self.proc.wait)
        self.exit_code = self.proc.returncode
        for c in self.clients:
            c.queue.put_nowait(None)


def overview() -> dict:
    return {"user": _user().pw_name, "max": MAX_SESSIONS, "sessions": [s.info() for s in sessions.values()]}


def close_all() -> None:
    for s in list(sessions.values()):
        s.kill()


def image_ext(data: bytes) -> str | None:
    """File extension for the image types Claude Code accepts, judged by content; None for anything else."""
    for magic, ext in IMAGE_MAGIC:
        if data.startswith(magic):
            return ext
    return "webp" if data[:4] == b"RIFF" and data[8:12] == b"WEBP" else None


def upload_name(name: str, head: bytes) -> str:
    """The sender's file name cut down to letters, digits, '.', '_' and '-': the pasted path must be one word
    to the shell, and Claude Code takes a paste as a path only if it is just that. An image Claude Code can
    attach gets the extension of its content, which is what Claude Code checks first."""
    name = re.sub(r"[^\w.-]+", "_", re.split(r"[/\\]", name)[-1]).strip("._") or "file"
    if ext := image_ext(head):
        name = f"{name.rsplit('.', 1)[0]}.{ext}"
    return name.encode()[-120:].decode(errors="ignore")  # the end keeps the extension; well under NAME_MAX


def open_upload() -> tuple[Path, BinaryIO]:
    """A private temp file for an upload in progress. Uploads older than UPLOAD_TTL go on the way."""
    UPLOAD_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    cutoff = time.time() - UPLOAD_TTL
    for old in UPLOAD_DIR.iterdir():
        with contextlib.suppress(OSError):
            if old.is_file() and old.stat().st_mtime < cutoff:
                old.unlink()
    tmp = UPLOAD_DIR / f".{secrets.token_hex(8)}.part"
    return tmp, open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb")


def finish_upload(tmp: Path, name: str, head: bytes) -> str:
    """Give a complete upload its final name (`head` = its first bytes) and return the path to paste."""
    path = UPLOAD_DIR / f"{time.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(3)}-{upload_name(name, head)}"
    tmp.rename(path)
    return str(path)


async def serve(ws: WebSocket, s: Session, since: int | None) -> None:
    """Stream session `s` over an accepted WebSocket until the client leaves or the shell exits."""
    client, offset = s.attach(since)
    await ws.send_json({"type": "attach", "offset": offset, "reset": offset != since})

    async def outgoing():
        while True:
            items = [await client.queue.get()]
            while not client.queue.empty():
                items.append(client.queue.get_nowait())
            data = b"".join(i for i in items if i is not None)
            if data:
                await ws.send_bytes(data)
                client.pending -= len(data)
                s.resume()
            if items[-1] is None:
                await ws.send_json({"type": "exit", "code": s.exit_code})
                await ws.close()
                return

    async def incoming():
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                return
            if msg.get("bytes"):
                s.write(msg["bytes"])
            elif msg.get("text"):
                try:
                    ctl = json.loads(msg["text"])
                except ValueError:
                    continue
                if isinstance(ctl, dict) and ctl.get("type") == "resize":
                    s.resize(ctl.get("cols"), ctl.get("rows"))

    tasks = [asyncio.create_task(outgoing()), asyncio.create_task(incoming())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        s.detach(client)

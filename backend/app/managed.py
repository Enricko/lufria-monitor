"""Services started, stopped and restarted from the dashboard, arranged as a tree.

A child runs on top of its parent (a simulator on an API, an API on its database): starting a child
starts its ancestors first, stopping a service stops its children first, and restarting one brings
back the children that were running.

Kinds:
  systemd  system unit, changed with `sudo -n systemctl` (the service user has passwordless sudo)
  user     unit of the service user's own systemd manager (lingering keeps it up)
  docker   container (the dashboard runs with the docker group)
  command  a command line, run as the transient user unit lufria-svc-<id>.service. It lives in
           user@<uid>.service, not in lufria-monitor.service's cgroup, so restarting the dashboard
           leaves it running. Transient units are not started on boot.
           `match` (a regex on the full command line) finds copies started outside the dashboard:
           they show as running, and stop/restart take them over.

The list is data/services.json. Actions run in their own thread and the page polls their progress.
"""
import json
import os
import re
import shlex
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import psutil

from .config import DATA_DIR

SERVICES_FILE = Path(os.environ.get("MONITOR_SERVICES_FILE", DATA_DIR / "services.json"))
KINDS = ("systemd", "user", "docker", "command")
ACTIONS = ("start", "stop", "restart")
UNIT_PREFIX = "lufria-svc-"
MAX_SERVICES = 64
READY_TIMEOUT = 60   # seconds a start waits for the `ready` check before giving up
SETTLE = 1.5         # a command that dies within this long counts as a failed start
LOG_LINES = 300
UP = ("running", "starting", "external")

ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,39}")
UNIT_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9@_.:\\-]{0,250}")
CONTAINER_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")

UID = os.getuid()
_RUNTIME = f"/run/user/{UID}"
# the dashboard runs as a system service: point systemctl --user at the lingering user manager
USER_ENV = {**os.environ, "XDG_RUNTIME_DIR": _RUNTIME, "DBUS_SESSION_BUS_ADDRESS": f"unix:path={_RUNTIME}/bus"}


def _cgroup(pid: int | str) -> str:
    try:
        return Path(f"/proc/{pid}/cgroup").read_text().strip().split("::", 1)[-1]
    except OSError:
        return ""


OWN_CGROUP = _cgroup("self")
OWN_UNIT = OWN_CGROUP.rsplit("/", 1)[-1] if OWN_CGROUP.endswith(".service") else ""


class ActionError(Exception):
    def __init__(self, sid: str, message: str):
        super().__init__(message)
        self.sid = sid


class Busy(Exception):
    pass


def _run(cmd: list[str], timeout: float = 30, user: bool = False, merge: bool = False) -> tuple[int, str, str]:
    try:
        p = subprocess.run(cmd, capture_output=not merge, stdout=subprocess.PIPE if merge else None,
                           stderr=subprocess.STDOUT if merge else None, text=True, errors="replace",
                           timeout=timeout, env=USER_ENV if user else None, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return 124, "", f"{shlex.join(cmd[:4])} did not finish within {timeout:.0f} s"
    except OSError as e:
        return 127, "", str(e)
    return p.returncode, p.stdout or "", p.stderr or ""


# --- the list ---

def unit_of(sid: str) -> str:
    return f"{UNIT_PREFIX}{sid}.service"


def _text(raw: dict, key: str, where: str, limit: int) -> str:
    v = raw.get(key)
    if v is None:
        return ""
    if not isinstance(v, str):
        raise ValueError(f"{where}: {key} must be text")
    v = v.strip()
    if len(v) > limit:
        raise ValueError(f"{where}: {key} is longer than {limit} characters")
    if any(c in v for c in "\n\r\0"):
        raise ValueError(f"{where}: {key} must be a single line")
    return v


def _clean(raw, i: int, strict: bool) -> dict:
    if not isinstance(raw, dict):
        raise ValueError(f"entry {i + 1} is not an object")
    name = _text(raw, "name", f"entry {i + 1}", 60)
    where = f"“{name}”" if name else f"entry {i + 1}"
    if not name:
        raise ValueError(f"{where}: a name is required")
    sid = _text(raw, "id", where, 40)
    if not ID_RE.fullmatch(sid):
        raise ValueError(f"{where}: id must be lowercase letters, digits and dashes")
    kind = raw.get("kind")
    if kind not in KINDS:
        raise ValueError(f"{where}: kind must be one of {', '.join(KINDS)}")
    s = {"id": sid, "name": name, "kind": kind, "parent": _text(raw, "parent", where, 40) or None,
         "target": "", "command": "", "cwd": "", "match": "", "log": "",
         "ready": _text(raw, "ready", where, 300), "url": _text(raw, "url", where, 300), "stop_timeout": 30}

    if kind in ("systemd", "user"):
        unit = _text(raw, "target", where, 250)
        if unit and "." not in unit:
            unit += ".service"
        if not UNIT_RE.fullmatch(unit):
            raise ValueError(f"{where}: enter a systemd unit name, like nginx.service")
        if kind == "systemd" and OWN_UNIT and unit == OWN_UNIT:
            raise ValueError(f"{where}: {unit} is this dashboard; it can't stop or restart itself from here")
        s["target"] = unit
    elif kind == "docker":
        name_ = _text(raw, "target", where, 128)
        if not CONTAINER_RE.fullmatch(name_):
            raise ValueError(f"{where}: enter a container name")
        s["target"] = name_
    else:
        cmd = _text(raw, "command", where, 2000)
        try:
            argv = shlex.split(cmd)
        except ValueError as e:
            raise ValueError(f"{where}: command can't be parsed ({e})") from None
        if not argv:
            raise ValueError(f"{where}: a command is required")
        s["command"] = cmd
        for key in ("cwd", "log"):
            p = _text(raw, key, where, 300)
            if p and (not p.startswith("/") or any(c.isspace() for c in p)):
                raise ValueError(f"{where}: {'working directory' if key == 'cwd' else 'log file'} "
                                 "must be an absolute path without spaces")
            s[key] = p
        if strict and s["cwd"] and not Path(s["cwd"]).is_dir():
            raise ValueError(f"{where}: working directory {s['cwd']} does not exist")
        if strict and s["log"] and not Path(s["log"]).parent.is_dir():
            raise ValueError(f"{where}: the folder for {s['log']} does not exist")
        s["match"] = _text(raw, "match", where, 300)
        if s["match"]:
            try:
                re.compile(s["match"])
            except re.error as e:
                raise ValueError(f"{where}: match is not a valid regex ({e})") from None

    if s["ready"] and not _ready_target(s["ready"]):
        raise ValueError(f"{where}: ready must be a port, host:port or an http(s):// URL")
    if s["url"] and not s["url"].startswith(("http://", "https://")):
        raise ValueError(f"{where}: link must start with http:// or https://")
    try:
        t = int(raw.get("stop_timeout") or 30)
    except (TypeError, ValueError):
        raise ValueError(f"{where}: stop timeout must be a number of seconds") from None
    if not 1 <= t <= 600:
        raise ValueError(f"{where}: stop timeout must be between 1 and 600 seconds")
    s["stop_timeout"] = t
    return s


def validate(items, strict: bool = True) -> list[dict]:
    if not isinstance(items, list):
        raise ValueError("services must be a list")
    if len(items) > MAX_SERVICES:
        raise ValueError(f"at most {MAX_SERVICES} services")
    out = [_clean(raw, i, strict) for i, raw in enumerate(items)]
    by_id = {}
    for s in out:
        if s["id"] in by_id:
            raise ValueError(f"two services use the id {s['id']}")
        by_id[s["id"]] = s
    for s in out:
        if s["parent"] is None:
            continue
        if s["parent"] not in by_id:
            raise ValueError(f"“{s['name']}” runs on top of {s['parent']}, which is not in the list")
        seen, cur = {s["id"]}, by_id[s["parent"]]
        while cur:
            if cur["id"] in seen:
                raise ValueError(f"“{s['name']}” ends up running on top of itself")
            seen.add(cur["id"])
            cur = by_id.get(cur["parent"]) if cur["parent"] else None
    return out


def load() -> list[dict]:
    try:
        data = json.loads(SERVICES_FILE.read_text())
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as e:
        raise ValueError(f"{SERVICES_FILE} can't be read: {e}") from None
    return validate(data.get("services", []) if isinstance(data, dict) else data, strict=False)


def save(items) -> list[dict]:
    clean = validate(items)
    SERVICES_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = SERVICES_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"services": clean}, indent=2) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, SERVICES_FILE)
    return clean


# --- status ---

def _show(units: list[str], user: bool) -> dict[str, dict]:
    units = list(dict.fromkeys(units))
    if not units:
        return {}
    props = "LoadState,ActiveState,SubState,Result,ActiveEnterTimestamp,MemoryCurrent,MainPID,UnitFileState"
    _, out, _ = _run(["systemctl", *(["--user"] if user else []), "show", "--timestamp=unix",
                      f"--property={props}", "--", *units], timeout=10, user=user)
    # one block per unit, in argument order, blank line between
    blocks = out.strip("\n").split("\n\n") if out.strip() else []
    return {u: dict(l.split("=", 1) for l in b.splitlines() if "=" in l) for u, b in zip(units, blocks)}


def _from_unit(p: dict | None, transient: bool = False) -> dict:
    if not p:
        return {"state": "unknown", "detail": "systemd did not answer", "since": None, "memory": None, "boot": ""}
    load, active, sub = p.get("LoadState", ""), p.get("ActiveState", ""), p.get("SubState", "")
    if load == "not-found" and active == "inactive":
        return {"state": "stopped" if transient else "missing", "detail": "" if transient else "unit not found",
                "since": None, "memory": None, "boot": "no" if transient else ""}
    state = {"active": "running", "reloading": "running", "activating": "starting",
             "deactivating": "stopping", "failed": "failed"}.get(active, "stopped")
    detail = sub if state != "failed" else f"failed ({p.get('Result', '')})"
    ts, mem = p.get("ActiveEnterTimestamp", "").lstrip("@"), p.get("MemoryCurrent", "")
    return {"state": state, "detail": detail,
            "since": int(ts) if state in UP and ts.isdigit() else None,
            "memory": int(mem) if mem.isdigit() else None,
            "boot": "no" if transient else p.get("UnitFileState", "")}


def _docker(names: list[str]) -> dict[str, dict]:
    names = list(dict.fromkeys(names))
    if not names:
        return {}
    code, out, err = _run(["docker", "inspect", "--type=container", *names], timeout=10)
    try:
        found = json.loads(out) if out.strip() else []
    except ValueError:
        found = []
    res = {}
    for n in names:
        c = next((c for c in found if c.get("Name", "").lstrip("/") == n or c.get("Id", "").startswith(n)), None)
        if c is None:
            missing = "no such" in err.lower()
            res[n] = {"state": "missing" if missing else "unknown", "since": None, "memory": None, "boot": "",
                      "detail": "container not found" if missing else (err.strip()[:200] or "docker did not answer")}
            continue
        st = c.get("State", {})
        status = st.get("Status", "")
        state = {"running": "running", "restarting": "starting", "removing": "stopping", "dead": "failed"}.get(status, "stopped")
        detail = status
        if status == "exited":
            detail = f"exited ({st.get('ExitCode')})"
        health = (st.get("Health") or {}).get("Status")
        if state == "running" and health:
            detail = f"running · {health}"
        since = None
        m = re.match(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)", st.get("StartedAt", ""))
        if state in UP and m and not m.group(1).startswith("0001"):
            since = int(datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp())
        mem = None
        if state == "running":
            try:
                mem = int(Path(f"/sys/fs/cgroup/system.slice/docker-{c['Id']}.scope/memory.current").read_text())
            except (OSError, ValueError, KeyError):
                pass
        res[n] = {"state": state, "detail": detail, "since": since, "memory": mem,
                  "boot": (c.get("HostConfig", {}).get("RestartPolicy") or {}).get("Name") or "no"}
    return res


def _scan(patterns: dict[str, re.Pattern]) -> dict[str, list[psutil.Process]]:
    """Processes of this user matching each pattern, outside their own lufria-svc unit. Skips the
    dashboard's own cgroup (its terminals and Claude Code runs) and the user manager itself."""
    found: dict[str, list[psutil.Process]] = {k: [] for k in patterns}
    if not patterns:
        return found
    me = os.getpid()
    for p in psutil.process_iter(["uids", "cmdline"]):
        try:
            uids, cmd = p.info["uids"], p.info["cmdline"]
            if not uids or uids.real != UID or p.pid == me or not cmd:
                continue
            line = " ".join(cmd)
            hits = [k for k, rx in patterns.items() if rx.search(line)]
            if not hits:
                continue
            cg = _cgroup(p.pid)
            if not cg or (OWN_CGROUP and (cg == OWN_CGROUP or cg.startswith(OWN_CGROUP + "/"))) or cg.endswith("/init.scope"):
                continue
            for k in hits:
                if not cg.endswith("/" + unit_of(k)):
                    found[k].append(p)
        except psutil.Error:
            continue
    return found


def statuses(items: list[dict]) -> dict[str, dict]:
    sys_units = _show([s["target"] for s in items if s["kind"] == "systemd"], user=False)
    user_units = _show([s["target"] for s in items if s["kind"] == "user"]
                       + [unit_of(s["id"]) for s in items if s["kind"] == "command"], user=True)
    containers = _docker([s["target"] for s in items if s["kind"] == "docker"])
    external = _scan({s["id"]: re.compile(s["match"]) for s in items if s["kind"] == "command" and s["match"]})
    out = {}
    for s in items:
        kind = s["kind"]
        if kind == "systemd":
            st = _from_unit(sys_units.get(s["target"]))
        elif kind == "user":
            st = _from_unit(user_units.get(s["target"]))
        elif kind == "docker":
            st = containers.get(s["target"]) or {"state": "unknown", "detail": "", "since": None, "memory": None, "boot": ""}
        else:
            st = _from_unit(user_units.get(unit_of(s["id"])), transient=True)
            procs = external.get(s["id"], [])
            if procs and st["state"] not in ("running", "starting"):
                rss, start = 0, None
                for p in procs:
                    try:
                        rss += p.memory_info().rss
                        start = min(start or p.create_time(), p.create_time())
                    except psutil.Error:
                        pass
                st = {"state": "external", "detail": f"started outside the dashboard · pid {', '.join(str(p.pid) for p in procs[:4])}",
                      "since": int(start) if start else None, "memory": rss or None, "boot": "no"}
            st["unit"] = unit_of(s["id"])
        out[s["id"]] = st
    return out


# --- actions ---

_lock = threading.Lock()
_busy: dict[str, str] = {}       # id -> waiting | starting | stopping | restarting
_errors: dict[str, dict] = {}    # id -> {action, message, ts} of the last failed action


def overview() -> dict:
    try:
        items, error = load(), None
    except ValueError as e:
        items, error = [], str(e)
    with _lock:  # before reading states: a reply saying "not busy" then never carries pre-action states
        busy, errors = dict(_busy), dict(_errors)
    st = statuses(items)
    return {"services": [{**s, "status": st[s["id"]], "busy": busy.get(s["id"]), "error": errors.get(s["id"])}
                         for s in items],
            "error": error, "self_unit": OWN_UNIT}


def _chain(sid: str, by_id: dict) -> list[dict]:
    """sid and its ancestors, root first."""
    out, cur = [], by_id.get(sid)
    while cur:
        out.append(cur)
        cur = by_id.get(cur["parent"]) if cur["parent"] else None
    return out[::-1]


def _subtree(sid: str, by_id: dict) -> list[dict]:
    """sid then its descendants, parents before children (pre-order, list order among siblings)."""
    kids: dict[str, list[dict]] = {}
    for s in by_id.values():
        if s["parent"]:
            kids.setdefault(s["parent"], []).append(s)
    out = []

    def walk(s):
        out.append(s)
        for c in kids.get(s["id"], []):
            walk(c)
    walk(by_id[sid])
    return out


def _status(s: dict) -> dict:
    return statuses([s])[s["id"]]


def _step(s: dict, verb: str | None) -> None:
    with _lock:
        if verb:
            _busy[s["id"]] = verb
        else:
            _busy.pop(s["id"], None)


def _must(s: dict, cmd: list[str], timeout: float = 120, user: bool = False, ok: tuple[int, ...] = (0,)) -> None:
    code, out, err = _run(cmd, timeout=timeout, user=user)
    if code not in ok:
        raise ActionError(s["id"], (err or out).strip()[:1500] or f"{cmd[0]} exited with {code}")


def _ready_target(r: str):
    if r.startswith(("http://", "https://")):
        return r if urlsplit(r).hostname else None
    host, _, port = r.rpartition(":")
    return (host.strip("[]") or "127.0.0.1", int(port)) if port.isdigit() and 0 < int(port) < 65536 else None


def _probe(r: str) -> bool:
    t = _ready_target(r)
    if isinstance(t, str):
        try:
            with urllib.request.urlopen(t, timeout=2):
                return True
        except urllib.error.HTTPError as e:
            return e.code < 500   # it answers: up, even if this path is a 404
        except (OSError, ValueError):
            return False
    try:
        with socket.create_connection(t, timeout=1):
            return True
    except OSError:
        return False


def _tail_logs(s: dict, n: int = 12) -> str:
    text = logs(s, n)["text"].strip()
    return f"\n\nLast lines of its log:\n{text}" if text else ""


def _wait_ready(s: dict) -> None:
    if not s["ready"]:
        return
    deadline = time.monotonic() + READY_TIMEOUT
    while not _probe(s["ready"]):
        if _status(s)["state"] not in UP:
            raise ActionError(s["id"], f"stopped before {s['ready']} answered" + _tail_logs(s))
        if time.monotonic() > deadline:
            raise ActionError(s["id"], f"{s['ready']} did not answer within {READY_TIMEOUT} s")
        time.sleep(1)


def _start_command(s: dict) -> None:
    unit = unit_of(s["id"])
    _run(["systemctl", "--user", "reset-failed", "--", unit], user=True)  # a failed run keeps the name taken
    cmd = ["systemd-run", "--user", "--quiet", f"--unit={unit}", f"--description={s['name']} (Lufria Monitor)",
           f"--property=WorkingDirectory={s['cwd'] or '~'}", f"--property=TimeoutStopSec={s['stop_timeout']}"]
    if s["log"]:
        cmd += [f"--property=StandardOutput=append:{s['log']}", f"--property=StandardError=append:{s['log']}"]
    _must(s, [*cmd, "--", *shlex.split(s["command"])], user=True)
    time.sleep(SETTLE)
    st = _status(s)
    if st["state"] not in UP:
        raise ActionError(s["id"], f"exited right after starting ({st['detail'] or st['state']})" + _tail_logs(s))


def _start(s: dict) -> None:
    kind, t = s["kind"], s["target"]
    if kind == "systemd":
        _must(s, ["sudo", "-n", "systemctl", "start", "--", t], timeout=300)
    elif kind == "user":
        _must(s, ["systemctl", "--user", "start", "--", t], timeout=300, user=True)
    elif kind == "docker":
        _must(s, ["docker", "start", t])
    else:
        _start_command(s)
    _wait_ready(s)


def _kill_external(s: dict) -> None:
    procs = _scan({s["id"]: re.compile(s["match"])})[s["id"]] if s["match"] else []
    for p in procs:
        try:
            p.terminate()
        except psutil.Error:
            pass
    _, alive = psutil.wait_procs(procs, timeout=s["stop_timeout"])
    for p in alive:
        try:
            p.kill()
        except psutil.Error:
            pass
    psutil.wait_procs(alive, timeout=5)


def _stop(s: dict) -> None:
    kind, t, wait = s["kind"], s["target"], s["stop_timeout"]
    if kind == "systemd":
        _must(s, ["sudo", "-n", "systemctl", "stop", "--", t], timeout=300)
    elif kind == "user":
        _must(s, ["systemctl", "--user", "stop", "--", t], timeout=300, user=True)
    elif kind == "docker":
        _must(s, ["docker", "stop", "-t", str(wait), t], timeout=wait + 30)
    else:
        unit = unit_of(s["id"])
        _must(s, ["systemctl", "--user", "stop", "--", unit], timeout=wait + 30, user=True, ok=(0, 5))  # 5: not loaded
        _run(["systemctl", "--user", "reset-failed", "--", unit], user=True)  # killed on purpose: not a failure
        _kill_external(s)
    if _status(s)["state"] in UP:
        raise ActionError(s["id"], "still running after the stop")


def _do_start(sid: str, by_id: dict) -> None:
    for s in _chain(sid, by_id):
        if _status(s)["state"] in UP:
            _wait_ready(s)
        else:
            _step(s, "starting")
            _start(s)
        _step(s, None)


def _do_stop(sid: str, by_id: dict) -> None:
    for s in reversed(_subtree(sid, by_id)):  # children before their parents
        if _status(s)["state"] in (*UP, "stopping"):
            _step(s, "stopping")
            _stop(s)
        _step(s, None)


def _do_restart(sid: str, by_id: dict) -> None:
    s = by_id[sid]
    if _status(s)["state"] not in UP:
        return _do_start(sid, by_id)
    for a in _chain(sid, by_id)[:-1]:  # reserved in case it had to start; it doesn't
        _step(a, None)
    running = []
    for d in _subtree(sid, by_id)[1:]:
        if _status(d)["state"] in UP:
            running.append(d)
        else:
            _step(d, None)
    for d in reversed(running):
        _step(d, "stopping")
        _stop(d)
        _step(d, "waiting")
    _step(s, "restarting")
    kind, t = s["kind"], s["target"]
    if kind == "systemd":
        _must(s, ["sudo", "-n", "systemctl", "restart", "--", t], timeout=300)
    elif kind == "user":
        _must(s, ["systemctl", "--user", "restart", "--", t], timeout=300, user=True)
    elif kind == "docker":
        _must(s, ["docker", "restart", "-t", str(s["stop_timeout"]), t], timeout=s["stop_timeout"] + 60)
    else:  # stop + start: takes over copies started outside, and picks up an edited command
        _stop(s)
        _start_command(s)
    _wait_ready(s)
    _step(s, None)
    for d in running:  # parents before children
        _step(d, "starting")
        _start(d)
        _step(d, None)


def run(sid: str, action: str, by_id: dict, affected: list[str]) -> None:
    """Carry out an action reserved by request(). Records the failure, never raises."""
    try:
        {"start": _do_start, "stop": _do_stop, "restart": _do_restart}[action](sid, by_id)
    except ActionError as e:
        with _lock:
            _errors[e.sid] = {"action": action, "message": str(e), "ts": int(time.time())}
    except Exception as e:  # noqa: BLE001 - must not leave services marked busy
        with _lock:
            _errors[sid] = {"action": action, "message": f"{type(e).__name__}: {e}", "ts": int(time.time())}
    finally:
        with _lock:
            for i in affected:
                _busy.pop(i, None)


def request(sid: str, action: str, background: bool = True) -> None:
    """Reserve the services an action touches and run it. KeyError: unknown id; Busy: overlaps another action."""
    by_id = {s["id"]: s for s in load()}
    if sid not in by_id:
        raise KeyError(sid)
    touched = {"start": _chain(sid, by_id), "stop": _subtree(sid, by_id),
               "restart": _chain(sid, by_id)[:-1] + _subtree(sid, by_id)}[action]  # restart of a stopped one = start
    affected = [s["id"] for s in touched]
    with _lock:
        clash = next((i for i in affected if i in _busy), None)
        if clash:
            raise Busy(by_id[clash]["name"])
        for i in affected:
            _busy[i] = "waiting"
            _errors.pop(i, None)
    if background:
        threading.Thread(target=run, args=(sid, action, by_id, affected), daemon=True,
                         name=f"managed-{action}-{sid}").start()
    else:
        run(sid, action, by_id, affected)


# --- logs ---

def _tail_file(path: str, n: int) -> str:
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 256 * 1024))
            data = f.read().decode(errors="replace")
    except FileNotFoundError:
        return ""
    except OSError as e:
        return f"can't read {path}: {e}"
    return "\n".join(data.splitlines()[-n:])


def logs(s: dict, n: int = LOG_LINES) -> dict:
    kind, t = s["kind"], s["target"]
    journal = ["--no-pager", "-o", "short-iso", "-n", str(n)]
    if kind == "systemd":
        source, (_, out, err) = f"journalctl -u {t}", _run(["journalctl", "-u", t, *journal], timeout=15)
    elif kind == "user":
        source, (_, out, err) = f"journalctl --user -u {t}", _run(["journalctl", "--user", "-u", t, *journal], timeout=15, user=True)
    elif kind == "docker":
        source, (_, out, err) = f"docker logs {t}", _run(["docker", "logs", "--tail", str(n), "--timestamps", t], timeout=15, merge=True)
    elif s["log"]:
        source, out, err = s["log"], _tail_file(s["log"], n), ""
    else:
        unit = unit_of(s["id"])
        source, (_, out, err) = f"journalctl --user -u {unit}", _run(["journalctl", "--user", "-u", unit, *journal], timeout=15, user=True)
    return {"source": source, "text": ANSI_RE.sub("", out or err)}


def logs_for(sid: str, n: int = LOG_LINES) -> dict:
    s = next((s for s in load() if s["id"] == sid), None)
    if s is None:
        raise KeyError(sid)
    return logs(s, max(10, min(n, 2000)))

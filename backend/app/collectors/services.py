import json
import socket
import subprocess
from urllib.parse import urlparse

import yaml

from ..config import CLOUDFLARED_CONFIG

SHOW_PROPS = "ActiveState,SubState,LoadState,Description,ActiveEnterTimestamp,MemoryCurrent,MainPID,UnitFileState"


def _run(cmd: list[str], timeout: int = 10) -> tuple[int, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout if p.returncode == 0 else p.stderr
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, str(e)


def systemd(watched: list[str]) -> dict:
    watched_info = []
    for name in watched:
        unit = name if name.endswith(".service") else f"{name}.service"
        code, out = _run(["systemctl", "show", unit, f"--property={SHOW_PROPS}"])
        props = dict(l.split("=", 1) for l in out.splitlines() if "=" in l) if code == 0 else {}
        mem = props.get("MemoryCurrent", "")
        watched_info.append({
            "unit": unit,
            "description": props.get("Description", ""),
            "load": props.get("LoadState", "unknown"),
            "active": props.get("ActiveState", "unknown"),
            "sub": props.get("SubState", ""),
            "enabled": props.get("UnitFileState", ""),
            "since": props.get("ActiveEnterTimestamp", ""),
            "memory": int(mem) if mem.isdigit() else None,
            "pid": int(props.get("MainPID", "0") or 0),
        })

    code, out = _run(["systemctl", "list-units", "--type=service", "--all", "--output=json", "--no-pager"])
    units = []
    if code == 0:
        try:
            units = [{"unit": u["unit"], "active": u["active"], "sub": u["sub"],
                      "description": u["description"]} for u in json.loads(out)]
        except (ValueError, KeyError):
            pass
    failed = [u for u in units if u["active"] == "failed"]
    running = sum(1 for u in units if u["sub"] == "running")
    return {"watched": watched_info, "all": units, "failed": failed, "running": running}


def docker() -> dict:
    code, out = _run(["docker", "ps", "-a", "--format", "{{json .}}"])
    if code != 0:
        return {"available": False, "error": out.strip()[:200], "containers": []}
    containers = []
    for line in out.splitlines():
        try:
            c = json.loads(line)
        except ValueError:
            continue
        containers.append({"name": c.get("Names"), "image": c.get("Image"), "state": c.get("State"),
                           "status": c.get("Status"), "ports": c.get("Ports")})
    return {"available": True, "containers": containers}


def _port_open(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except OSError:
        return False


def tunnel() -> dict:
    try:
        cfg = yaml.safe_load(CLOUDFLARED_CONFIG.read_text())
    except (OSError, yaml.YAMLError) as e:
        return {"available": False, "error": str(e), "routes": []}
    routes = []
    for rule in cfg.get("ingress", []):
        host = rule.get("hostname")
        service = rule.get("service", "")
        if not host:
            continue
        u = urlparse(service)
        port = u.port or {"http": 80, "https": 443, "ssh": 22}.get(u.scheme)
        up = _port_open(u.hostname, port) if u.hostname and port else None
        routes.append({"hostname": host, "service": service, "up": up})
    return {"available": True, "routes": routes}

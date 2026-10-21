"""Power readings.

Primary source is WattSeal (wattseal.service), relayed by the root helper in
/run/lufria-monitor/power.json together with raw Intel RAPL counters.

WattSeal's CPU (RAPL package) and RAM figures are used as-is. Its disk and NIC
estimates count every mount point and virtual interface (LVM volumes, overlay,
docker bridges/veths), which on this server adds ~13 W of phantom devices, so
we re-apply WattSeal's own formulas (collector/src/sensors/{disk,network}.rs)
to physical devices only, and rescale per-app power to the corrected total.
"""
import json
import time
from functools import lru_cache
from pathlib import Path

import psutil

from ..config import POWER_FILE
from .system import block_devices

STALE_AFTER = 5  # seconds

# WattSeal v1.0.6 models (MiB/s based)
RAM_W = 5.0
DISK_MODEL = {"ssd": (0.05, 0.015), "hdd": (3.0, 0.035), "unknown": (0.3, 0.02)}  # idle W, W per MiB/s
NIC_IDLE_W, NIC_W_PER_MIB, NIC_MAX_W = 0.2, 0.01, 3.0
MIB = 1_048_576


def _read_helper() -> dict | None:
    try:
        data = json.loads(POWER_FILE.read_text())
    except (OSError, ValueError):
        return None
    if time.time() - data.get("ts", 0) > STALE_AFTER:
        return None
    return data


@lru_cache(maxsize=1)
def _disk_kinds() -> dict[str, str]:
    kinds = {}
    for d in block_devices():
        if d.get("tran") == "usb":
            kinds[d["name"]] = "unknown"
        elif d.get("rota"):
            kinds[d["name"]] = "hdd"
        else:
            kinds[d["name"]] = "ssd"
    return kinds


@lru_cache(maxsize=64)
def _is_physical_nic(name: str) -> bool:
    return Path(f"/sys/class/net/{name}/device").exists()


def disk_watts(per_disk: dict[str, dict]) -> float:
    total = 0.0
    for name, kind in _disk_kinds().items():
        idle, per_mib = DISK_MODEL[kind]
        io = per_disk.get(name, {"r": 0.0, "w": 0.0})
        total += idle + (io["r"] + io["w"]) / MIB * per_mib
    return total


def nic_watts(per_nic: dict[str, dict]) -> float:
    total = 0.0
    for name in psutil.net_if_stats():
        if not _is_physical_nic(name):
            continue
        io = per_nic.get(name, {"rx": 0.0, "tx": 0.0})
        total += min(NIC_IDLE_W + (io["rx"] + io["tx"]) / MIB * NIC_W_PER_MIB, NIC_MAX_W)
    return total


def read_battery() -> dict | None:
    bat = psutil.sensors_battery()
    if bat is None:
        return None
    return {"percent": bat.percent, "plugged": bat.power_plugged}


def _gpu_watts(gpu: dict | None) -> float | None:
    nv = (gpu or {}).get("nvidia")
    if not nv:
        return None
    if nv.get("power_w") is not None:
        return nv["power_w"]
    return 0.0 if nv.get("state") == "suspended" else None  # D3cold draws ~0 W


def snapshot(overhead_watts: float, per_disk: dict, per_nic: dict, gpu: dict | None = None) -> dict:
    helper = _read_helper()
    rapl = helper.get("rapl") if helper else None
    ws = helper.get("wattseal") if helper else None
    ws_fresh = bool(ws and ws.get("ts") and time.time() - ws["ts"] <= STALE_AFTER and ws.get("cpu") is not None)

    if ws_fresh:
        source, cpu = "wattseal", ws["cpu"]
    elif rapl and rapl.get("package") is not None:
        source, cpu = "rapl", rapl["package"]
    else:
        source, cpu = None, None

    components = None
    total = None
    apps = []
    if source:
        components = {
            "cpu": cpu,
            "ram": ws["ram"] if ws_fresh and ws.get("ram") is not None else RAM_W,
            "gpu": _gpu_watts(gpu),
            "disk": disk_watts(per_disk),
            "net": nic_watts(per_nic),
            "overhead": overhead_watts,
        }
        measured = sum(v for k, v in components.items() if k != "overhead" and v is not None)
        total = measured + overhead_watts
        if ws_fresh and ws.get("total"):
            # WattSeal has no GPU access (PrivateDevices), so its total excludes the dGPU
            scale = (measured - (components["gpu"] or 0)) / ws["total"]
            apps = [{**a, "w": a["w"] * scale} for a in ws.get("apps", [])]

    return {
        "source": source,
        "total": total,
        "components": components,
        "rapl": rapl,
        "apps": apps,
        "wattseal": {
            "ok": ws_fresh,
            "error": helper.get("wattseal_error") if helper else "helper not running",
            "raw_total": ws.get("total") if ws else None,
            "raw_disk": ws.get("disk") if ws else None,
            "raw_net": ws.get("net") if ws else None,
            "cpu_usage": ws.get("cpu_usage") if ws else None,
        },
        "battery": read_battery(),
    }

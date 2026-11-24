"""Opt-in public summary, for embedding the server's vitals elsewhere (the
owner's GitHub profile card reads it).

Off unless MONITOR_PUBLIC_PROFILE=1: the route then 404s like any unknown path.
When on, it returns a handful of headline numbers and nothing else: no
hostnames, IPs, process or service names, paths or settings.
"""
import os
import time

from . import db, energy, sampler

ENABLED = os.environ.get("MONITOR_PUBLIC_PROFILE") == "1"
TTL = 10.0  # seconds; energy.summary() scans the whole samples table

_cached: tuple[float, dict] | None = None


def _round(value, digits: int = 1):
    return None if value is None else round(value, digits)


def profile() -> dict:
    global _cached
    now = time.time()
    if _cached and now - _cached[0] < TTL:
        return _cached[1]
    snap = sampler.latest
    summary = energy.summary()
    totals = summary["totals"]
    first = db.query("SELECT MIN(ts) AS ts FROM samples")[0]["ts"]
    data = {
        "ts": int(now),
        "online": bool(snap),
        "watts": _round((snap.get("power") or {}).get("total")),
        "cpu_percent": _round((snap.get("cpu") or {}).get("percent")),
        "cpu_temp": _round((snap.get("temps") or {}).get("cpu")),
        "mem_percent": _round((snap.get("mem") or {}).get("percent")),
        "uptime_s": int(snap["uptime"]) if snap.get("uptime") else None,
        "kwh_today": _round(totals["today"]["kwh"], 3),
        "cost_today": round(totals["today"]["cost"]),
        "kwh_month": _round(totals["this_month"]["kwh"], 2),
        "cost_month": round(totals["this_month"]["cost"]),
        "history_days": int((now - first) // 86400) if first else 0,
        "timezone": summary["timezone"],
    }
    _cached = (now, data)
    return data

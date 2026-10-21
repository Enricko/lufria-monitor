"""Energy (kWh) and cost (Rp) aggregation from per-minute samples."""
import json
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from . import db, sampler
from .config import APPS_FILE

COMPONENTS = ("cpu", "ram", "gpu", "disk", "net", "overhead")
UJ_PER_KWH = 3.6e12
APP_WINDOWS = {"1h": 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400}
# Energy per component: minute-average watts x sampled seconds
_COMPONENT_WH = ", ".join(f"SUM(p_{c} * seconds) / 3600.0 AS wh_{c}" for c in COMPONENTS)

# period -> (sqlite strftime format of the bucket key, how many buckets to return)
PERIODS = {
    "hour": ("%Y-%m-%d %H:00", 48),
    "day": ("%Y-%m-%d", 31),
    "week": ("%Y-W%W", 12),
    "month": ("%Y-%m", 12),
}


def _tz(settings: dict) -> ZoneInfo:
    return ZoneInfo(settings["timezone"])


def _offset_seconds(tz: ZoneInfo) -> int:
    return int(datetime.now(tz).utcoffset().total_seconds())


def rate(settings: dict) -> float:
    """Effective Rp per kWh including PPJ."""
    return float(settings["tariff_rp_per_kwh"]) * (1 + float(settings["ppj_percent"]) / 100)


def buckets(period: str) -> list[dict]:
    settings = db.get_settings()
    fmt, count = PERIODS[period]
    off = _offset_seconds(_tz(settings))
    rp = rate(settings)
    rows = db.query(
        f"""SELECT strftime('{fmt}', ts + ?, 'unixepoch') AS bucket,
                   MIN(ts) AS start, SUM(wh) AS wh, AVG(watts) AS avg_w, MAX(watts_max) AS max_w,
                   SUM(seconds) AS seconds, {_COMPONENT_WH}
            FROM samples WHERE watts IS NOT NULL
            GROUP BY bucket ORDER BY bucket DESC LIMIT ?""",
        (off, count),
    )
    for r in rows:
        r["kwh"] = (r.pop("wh") or 0) / 1000
        r["cost"] = r["kwh"] * rp
        r["coverage_hours"] = (r.pop("seconds") or 0) / 3600
        # rows recorded before the component split show up as "other"
        parts = {c: (r.pop(f"wh_{c}") or 0) / 1000 for c in COMPONENTS}
        parts["other"] = max(r["kwh"] - sum(parts.values()), 0)
        r["components"] = parts
    return rows[::-1]


def apps(window: str) -> dict:
    """Per-app energy from WattSeal, rescaled to our corrected component total."""
    settings = db.get_settings()
    rp = rate(settings)
    try:
        data = json.loads(APPS_FILE.read_text())
    except (OSError, ValueError):
        return {"available": False, "apps": [], "updated": None}
    w = data.get(window, {"total_uj": 0, "apps": []})
    # Ratio of corrected (physical devices only) to WattSeal's raw total over the same minutes
    r = db.query(
        """SELECT SUM((p_cpu + p_ram + p_disk + p_net) * seconds) AS ours,
                  SUM(ws_raw * seconds) AS raw
           FROM samples WHERE ts >= ? AND ws_raw IS NOT NULL""",
        (int(time.time()) - APP_WINDOWS[window],),
    )[0]
    if r["ours"] and r["raw"]:
        scale = r["ours"] / r["raw"]
    else:
        live = sampler.latest.get("power") or {}
        comps = live.get("components") or {}
        raw = (live.get("wattseal") or {}).get("raw_total")
        measured = sum(v for k, v in comps.items() if k not in ("overhead", "gpu") and v is not None)
        scale = measured / raw if raw and measured else 1.0
    total_kwh = w["total_uj"] / UJ_PER_KWH * scale
    rows = []
    for a in w["apps"]:
        kwh = a["uj"] / UJ_PER_KWH * scale
        rows.append({"name": a["name"], "kwh": kwh, "cost": kwh * rp,
                     "share": a["uj"] / w["total_uj"] if w["total_uj"] else 0, "cpu": a["cpu"]})
    listed = sum(a["kwh"] for a in rows)
    return {"available": True, "updated": data.get("_ts"), "window": window, "scale": scale,
            "total_kwh": total_kwh, "total_cost": total_kwh * rp,
            "other_kwh": max(total_kwh - listed, 0), "apps": rows}


def _sum_since(ts: float) -> dict:
    r = db.query("SELECT SUM(wh) AS wh, AVG(watts) AS avg_w, SUM(seconds) AS s FROM samples WHERE ts >= ?",
                 (int(ts),))[0]
    return {"kwh": (r["wh"] or 0) / 1000, "avg_w": r["avg_w"], "hours": (r["s"] or 0) / 3600}


def summary() -> dict:
    settings = db.get_settings()
    tz = _tz(settings)
    rp = rate(settings)
    now = datetime.now(tz)
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    starts = {
        "this_hour": now.replace(minute=0, second=0, microsecond=0),
        "today": today,
        "this_week": today - timedelta(days=today.weekday()),
        "this_month": today.replace(day=1),
    }
    totals = {}
    for key, start in starts.items():
        t = _sum_since(start.timestamp())
        t["cost"] = t["kwh"] * rp
        totals[key] = t
    all_time = _sum_since(0)
    all_time["cost"] = all_time["kwh"] * rp
    totals["all_time"] = all_time

    # Projection from the last 24h average power
    last24 = _sum_since(time.time() - 86400)
    avg_w = last24["avg_w"]
    projection = None
    if avg_w:
        projection = {
            "avg_w": avg_w,
            "kwh_day": avg_w * 24 / 1000,
            "kwh_month": avg_w * 24 * 30 / 1000,
            "kwh_year": avg_w * 24 * 365 / 1000,
        }
        for k in ("day", "month", "year"):
            projection[f"cost_{k}"] = projection[f"kwh_{k}"] * rp
    return {"totals": totals, "projection": projection, "rate": rp,
            "tariff_rp_per_kwh": settings["tariff_rp_per_kwh"], "ppj_percent": settings["ppj_percent"],
            "timezone": settings["timezone"]}

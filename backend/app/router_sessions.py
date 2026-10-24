"""9Router session management API.

Endpoints:
  GET    /api/router/sessions              – list all sessions (newest first)
  GET    /api/router/sessions/{session_id} – full session with messages
  DELETE /api/router/sessions/{session_id} – delete session file
  GET    /api/router/models                – proxy to 9Router /v1/models
  GET    /api/router/usage                 – aggregate usage stats
"""
import json
import logging
import os
import re
import time
from datetime import datetime
from pathlib import Path

import httpx
from fastapi import HTTPException

from .config import DATA_DIR, ROOT

log = logging.getLogger(__name__)

SESSIONS_DIR = DATA_DIR / "router_sessions"
SESSIONS_DIR.mkdir(parents=True, exist_ok=True)

ROUTER_BASE = "https://9router.lufria.tech/v1"
SAFE_RE = re.compile(r"^[a-f0-9\-]{8,64}$")


def _api_key() -> str:
    key = os.environ.get("HERMES_CUSTOM_9ROUTER_LUFRIA_TECH_API_KEY", "")
    if key:
        return key
    env_file = ROOT / ".env"
    if env_file.exists():
        try:
            for line in env_file.read_text("utf-8").splitlines():
                if line.startswith("HERMES_CUSTOM_9ROUTER_LUFRIA_TECH_API_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
        except Exception:
            pass
    return ""


def _validate_sid(session_id: str) -> None:
    if not SAFE_RE.match(session_id):
        raise HTTPException(400, "invalid session_id")


def _session_path(session_id: str) -> Path:
    return SESSIONS_DIR / f"{session_id}.json"


def _parse_iso_ts(ts_str) -> int:
    """Parse ISO timestamp string to unix timestamp int."""
    if isinstance(ts_str, (int, float)):
        return int(ts_str)
    if isinstance(ts_str, str):
        try:
            dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
            return int(dt.timestamp())
        except Exception:
            pass
    return int(time.time())


# ---------------------------------------------------------------------------
# Session CRUD
# ---------------------------------------------------------------------------

def list_sessions() -> list[dict]:
    if not SESSIONS_DIR.exists():
        return []

    sessions: list[dict] = []
    for p in SESSIONS_DIR.glob("*.json"):
        try:
            data = json.loads(p.read_text("utf-8"))
        except Exception:
            continue

        sessions.append({
            "id": data.get("id", p.stem),
            "model": data.get("model", ""),
            "title": data.get("title", "(no title)"),
            "created_at": _parse_iso_ts(data.get("created_at")),
            "updated_at": _parse_iso_ts(data.get("updated_at")),
            "message_count": len(data.get("messages", [])),
            "total_tokens": data.get("total_tokens", 0),
            "total_cost_usd": data.get("total_cost_usd", 0.0),
        })

    sessions.sort(key=lambda s: s["updated_at"], reverse=True)
    return sessions[:50]


def get_session(session_id: str) -> dict:
    _validate_sid(session_id)
    p = _session_path(session_id)
    if not p.exists():
        raise HTTPException(404, "session not found")
    try:
        data = json.loads(p.read_text("utf-8"))
    except Exception as e:
        raise HTTPException(500, str(e))

    # Convert messages to frontend format: {role, text, ts}
    messages = []
    for m in data.get("messages", []):
        messages.append({
            "role": m.get("role", "user"),
            "text": m.get("content", ""),
            "ts": _parse_iso_ts(m.get("ts", data.get("updated_at"))),
        })

    return {
        "id": data.get("id", session_id),
        "model": data.get("model", ""),
        "title": data.get("title", ""),
        "messages": messages,
        "usage": {
            "input_tokens": data.get("input_tokens", data.get("total_tokens", 0)),
            "output_tokens": data.get("output_tokens", 0),
            "cache_read_input_tokens": 0,
            "total_cost_usd": data.get("total_cost_usd", 0.0),
        },
    }


def delete_session(session_id: str) -> dict:
    _validate_sid(session_id)
    p = _session_path(session_id)
    if not p.exists():
        raise HTTPException(404, "session not found")
    try:
        p.unlink()
    except Exception as e:
        raise HTTPException(500, str(e))
    return {"ok": True}


# ---------------------------------------------------------------------------
# Models proxy (Multi-provider across Binav, Lufria, OMO)
# ---------------------------------------------------------------------------

def list_models() -> list[dict]:
    try:
        from app.providers import get_all_models
        models = get_all_models()
        return [
            {
                "id": m["id"],
                "name": m.get("name", m["id"]),
                "provider": m.get("provider", "Hermes Provider"),
                "provider_id": m.get("provider_id", "router"),
            }
            for m in models
        ]
    except Exception as e:
        log.exception("Failed to fetch models from providers: %s", e)
        return []


# ---------------------------------------------------------------------------
# Usage aggregation
# ---------------------------------------------------------------------------

def get_usage() -> dict:
    from collections import defaultdict

    now = time.time()
    today_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    week_start = now - 7 * 86400
    month_start = now - 30 * 86400

    daily = defaultdict(lambda: {
        "sessions": set(),
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_creation_tokens": 0,
        "cost_usd": 0.0,
    })

    models_agg = defaultdict(lambda: {
        "cost_usd": 0.0,
        "input_tokens": 0,
        "output_tokens": 0,
    })

    if SESSIONS_DIR.exists():
        for p in SESSIONS_DIR.glob("*.json"):
            try:
                data = json.loads(p.read_text("utf-8"))
            except Exception:
                continue

            sid = data.get("id", p.stem)
            model = data.get("model", "unknown")
            in_tok = data.get("input_tokens", 0)
            out_tok = data.get("output_tokens", 0)
            tot_tok = data.get("total_tokens", in_tok + out_tok)
            if in_tok == 0 and out_tok == 0 and tot_tok > 0:
                in_tok = int(tot_tok * 0.6)
                out_tok = tot_tok - in_tok

            cost = data.get("total_cost_usd", 0.0)
            updated = _parse_iso_ts(data.get("updated_at"))
            day_str = datetime.fromtimestamp(updated).strftime("%Y-%m-%d")

            daily[day_str]["sessions"].add(sid)
            daily[day_str]["input_tokens"] += in_tok
            daily[day_str]["output_tokens"] += out_tok
            daily[day_str]["cost_usd"] += cost

            models_agg[model]["input_tokens"] += in_tok
            models_agg[model]["output_tokens"] += out_tok
            models_agg[model]["cost_usd"] += cost

    def make_bucket():
        return {
            "sessions": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_tokens": 0,
            "cache_creation_tokens": 0,
            "total_tokens": 0,
            "cost_usd": 0.0,
        }

    summary = {
        "today": make_bucket(),
        "week": make_bucket(),
        "month": make_bucket(),
        "all_time": make_bucket(),
    }

    history_list = []
    today_str = datetime.fromtimestamp(now).strftime("%Y-%m-%d")

    for day_str in sorted(daily.keys(), reverse=True):
        d = daily[day_str]
        tot = d["input_tokens"] + d["output_tokens"]
        day_item = {
            "date": day_str,
            "sessions": len(d["sessions"]),
            "input_tokens": d["input_tokens"],
            "output_tokens": d["output_tokens"],
            "cache_read_tokens": 0,
            "cache_creation_tokens": 0,
            "total_tokens": tot,
            "cost_usd": round(d["cost_usd"], 4),
        }
        history_list.append(day_item)

        summary["all_time"]["sessions"] += day_item["sessions"]
        summary["all_time"]["input_tokens"] += day_item["input_tokens"]
        summary["all_time"]["total_tokens"] += tot
        summary["all_time"]["cost_usd"] = round(summary["all_time"]["cost_usd"] + day_item["cost_usd"], 4)

        dt_day = datetime.strptime(day_str, "%Y-%m-%d").timestamp()
        if day_str == today_str or dt_day >= today_start:
            for k in ("sessions", "input_tokens", "output_tokens", "total_tokens"):
                summary["today"][k] += day_item[k]
            summary["today"]["cost_usd"] = round(summary["today"]["cost_usd"] + day_item["cost_usd"], 4)

        if dt_day >= week_start:
            for k in ("sessions", "input_tokens", "output_tokens", "total_tokens"):
                summary["week"][k] += day_item[k]
            summary["week"]["cost_usd"] = round(summary["week"]["cost_usd"] + day_item["cost_usd"], 4)

        if dt_day >= month_start:
            for k in ("sessions", "input_tokens", "output_tokens", "total_tokens"):
                summary["month"][k] += day_item[k]
            summary["month"]["cost_usd"] = round(summary["month"]["cost_usd"] + day_item["cost_usd"], 4)

    return {
        "summary": summary,
        "history": history_list,
        "models": {k: {"cost_usd": round(v["cost_usd"], 4), "input_tokens": v["input_tokens"], "output_tokens": v["output_tokens"]} for k, v in models_agg.items()},
        "total_sessions": summary["all_time"]["sessions"],
        "total_input_tokens": summary["all_time"]["input_tokens"],
        "total_output_tokens": summary["all_time"]["output_tokens"],
        "total_cost_usd": summary["all_time"]["cost_usd"],
        "sessions_today": summary["today"]["sessions"],
        "sessions_this_week": summary["week"]["sessions"],
    }

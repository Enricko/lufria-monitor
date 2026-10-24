"""Claude session history API.

Endpoints:
  GET    /api/claude/sessions              – list all sessions (newest first, cap 50)
  GET    /api/claude/sessions/{session_id} – full message list + usage
  DELETE /api/claude/sessions/{session_id} – delete the .jsonl file
  GET    /api/claude/usage                 – aggregate token/cost stats
"""
import json
import re
import time
import threading
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException

from .config import DATA_DIR
from .providers import atomic_write_json

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

CLAUDE_DIR = Path("/home/lufria/.claude")
HISTORY_FILE = CLAUDE_DIR / "history.jsonl"
SESSIONS_DIR = CLAUDE_DIR / "projects" / "-home-lufria"

BINDINGS_FILE = DATA_DIR / "claude_session_bindings.json"
_BINDINGS_LOCK = threading.RLock()


def _read_bindings() -> dict:
    try:
        data = json.loads(BINDINGS_FILE.read_text("utf-8"))
        if not isinstance(data, dict):
            raise ValueError
        return data
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        raise ValueError("Session routing storage is unreadable") from None


def get_session_binding(session_id: str) -> dict | None:
    _validate_sid(session_id)
    with _BINDINGS_LOCK:
        binding = _read_bindings().get(session_id)
        if binding is None:
            return None
        return {field: binding.get(field) for field in ("model", "provider", "provider_id")}


def set_session_binding(session_id: str, model: str, provider_id: str | None, provider: str | None) -> None:
    _validate_sid(session_id)
    with _BINDINGS_LOCK:
        bindings = _read_bindings()
        bindings[session_id] = {"model": model, "provider_id": provider_id, "provider": provider}
        atomic_write_json(BINDINGS_FILE, bindings)


def _delete_binding(session_id):
    with _BINDINGS_LOCK:
        bindings = _read_bindings()
        if session_id in bindings:
            del bindings[session_id]
            atomic_write_json(BINDINGS_FILE, bindings)


UUID_RE = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")


def _parse_ts(ts_raw) -> int:
    """Parse timestamp from either ISO string or millisecond int."""
    if not ts_raw:
        return int(time.time())
    if isinstance(ts_raw, (int, float)):
        ts = int(ts_raw)
        # If it looks like milliseconds (> year 10000 in seconds)
        if ts > 1_000_000_000_000:
            ts //= 1000
        return ts
    if isinstance(ts_raw, str):
        try:
            dt = datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))
            return int(dt.timestamp())
        except Exception:
            pass
        try:
            return int(ts_raw) // 1000
        except Exception:
            pass
    return int(time.time())



def _validate_sid(session_id: str) -> None:
    if not UUID_RE.match(session_id):
        raise HTTPException(400, "invalid session_id")


def _session_file(session_id: str) -> Path:
    p = SESSIONS_DIR / f"{session_id}.jsonl"
    # Safety: confirm resolved path stays inside SESSIONS_DIR
    try:
        resolved = p.resolve()
        resolved_dir = SESSIONS_DIR.resolve()
        if resolved_dir not in resolved.parents and resolved != resolved_dir:
            # The path itself must be a file directly inside, not a subdir escape
            if resolved.parent != resolved_dir:
                raise HTTPException(403, "forbidden")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(403, "forbidden")
    return p


# ---------------------------------------------------------------------------
# History helpers
# ---------------------------------------------------------------------------

def _read_history_sessions() -> dict[str, dict]:
    """Read history.jsonl → dict[session_id -> {title, created_at, project}]."""
    result: dict[str, dict] = {}
    if not HISTORY_FILE.exists():
        return result
    try:
        with HISTORY_FILE.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    sid = obj.get("sessionId", "")
                    if not sid or sid in result:
                        continue
                    display = str(obj.get("display", ""))[:60] or "(no title)"
                    ts = _parse_ts(obj.get("timestamp"))
                    project = str(obj.get("project", "/home/lufria"))
                    result[sid] = {
                        "title": display,
                        "created_at": ts,
                        "project": project,
                    }
                except (json.JSONDecodeError, Exception):
                    pass
    except Exception:
        pass
    return result


def _scan_sessions() -> list[dict]:
    """Return sessions list from .jsonl files in SESSIONS_DIR."""
    if not SESSIONS_DIR.exists():
        return []

    history = _read_history_sessions()
    sessions: list[dict] = []

    for jsonl_path in SESSIONS_DIR.glob("*.jsonl"):
        sid = jsonl_path.stem
        if not UUID_RE.match(sid):
            continue

        try:
            stat = jsonl_path.stat()
        except Exception:
            continue

        size_bytes = stat.st_size
        updated_at = int(stat.st_mtime)

        # Try to get title from history or ai-title entries in the file
        title = "(no title)"
        created_at = int(stat.st_ctime)
        project = "/home/lufria"
        message_count = 0
        ai_title = None

        hist = history.get(sid)
        if hist:
            title = hist["title"]
            created_at = hist["created_at"] or created_at
            project = hist["project"]

        # Scan file for message count + ai-title
        first_user_text: str | None = None
        session_model: str | None = None
        try:
            with jsonl_path.open("r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                        t = obj.get("type", "")
                        if t == "user":
                            message_count += 1
                            if first_user_text is None:
                                msg = obj.get("message", {})
                                content = msg.get("content", "")
                                if isinstance(content, str):
                                    first_user_text = content
                                elif isinstance(content, list):
                                    for block in content:
                                        if isinstance(block, dict) and block.get("type") == "text":
                                            first_user_text = block.get("text", "")
                                            break
                        elif t == "assistant":
                            message_count += 1
                            if not session_model:
                                session_model = obj.get("message", {}).get("model")
                        elif t == "system" and obj.get("subtype") == "init":
                            session_model = obj.get("model") or session_model
                        elif t == "ai-title":
                            ai_title = str(obj.get("aiTitle", ""))[:60]
                    except Exception:
                        pass
        except Exception:
            pass

        # Priority: ai-title > history.jsonl display > first user text
        if ai_title:
            title = ai_title
        elif not hist and first_user_text:
            title = first_user_text[:60]

        sessions.append({
            "id": sid,
            "title": title,
            "model": session_model or "Claude Code",
            **(get_session_binding(sid) or {"provider": None, "provider_id": None}),
            "created_at": created_at,
            "updated_at": updated_at,
            "message_count": message_count,
            "size_bytes": size_bytes,
            "project": project,
        })

    # Sort newest first, cap at 50
    sessions.sort(key=lambda s: s["updated_at"], reverse=True)
    return sessions[:50]


# ---------------------------------------------------------------------------
# Per-session helpers
# ---------------------------------------------------------------------------

def _extract_text(content) -> str:
    """Extract plain text from a content value (str or list of blocks)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                btype = block.get("type")
                if btype == "text":
                    parts.append(block.get("text", ""))
                elif btype == "tool_use":
                    tool_name = block.get("name", "Bash")
                    inp = block.get("input", {})
                    cmd = inp.get("command") or inp.get("path") or json.dumps(inp)
                    parts.append(f"\n\n> ⚙️ **{tool_name}:** `{cmd}`\n\n")
        return "".join(parts)
    return ""


def _read_session(session_id: str) -> dict:
    """Read a session .jsonl file and return messages + usage."""
    _validate_sid(session_id)
    path = _session_file(session_id)
    if not path.exists():
        raise HTTPException(404, "session not found")

    messages: list[dict] = []
    usage = {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_input_tokens": 0,
        "total_cost_usd": 0.0,
    }
    title = session_id[:8]
    ai_title = None
    session_model = None
    history = _read_history_sessions()
    hist = history.get(session_id)
    if hist:
        title = hist["title"]

    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    t = obj.get("type", "")

                    if t == "ai-title":
                        ai_title = str(obj.get("aiTitle", ""))[:60]

                    elif t == "user":
                        msg = obj.get("message", {})
                        content = msg.get("content", "")
                        text = _extract_text(content)
                        if text:
                            messages.append({"role": "user", "text": text, "ts": _parse_ts(obj.get("timestamp"))})

                    elif t == "assistant":
                        msg = obj.get("message", {})
                        session_model = msg.get("model") or session_model
                        content = msg.get("content", [])
                        text = _extract_text(content)
                        ts = _parse_ts(obj.get("timestamp"))
                        if text:
                            messages.append({"role": "assistant", "text": text, "ts": ts})
                        # Accumulate usage from assistant messages
                        u = msg.get("usage", {})
                        if u:
                            usage["input_tokens"] += int(u.get("input_tokens", 0))
                            usage["output_tokens"] += int(u.get("output_tokens", 0))
                            usage["cache_read_input_tokens"] += int(u.get("cache_read_input_tokens", 0))

                    elif t == "cost-state":
                        cost = obj.get("totalCostUSD", 0.0)
                        if cost:
                            usage["total_cost_usd"] = float(cost)

                except Exception:
                    pass
    except Exception as e:
        raise HTTPException(500, str(e))

    if ai_title:
        title = ai_title

    return {
        "id": session_id,
        "title": title,
        "messages": messages,
        "usage": usage,
        "model": session_model or "Claude Code",
        **(get_session_binding(session_id) or {"provider": None, "provider_id": None}),
    }


# ---------------------------------------------------------------------------
# Route handlers (called from main.py with @app.get/delete decorators)
# ---------------------------------------------------------------------------

def list_sessions() -> list[dict]:
    return _scan_sessions()


def get_session(session_id: str) -> dict:
    return _read_session(session_id)


def delete_session(session_id: str) -> dict:
    _validate_sid(session_id)
    path = _session_file(session_id)
    if not path.exists():
        raise HTTPException(404, "session not found")
    try:
        path.unlink()
        _delete_binding(session_id)
    except Exception as e:
        raise HTTPException(500, str(e))
    return {"ok": True}


def get_usage() -> dict:
    """Aggregate comprehensive usage stats across all sessions (today/week/month/all_time)."""
    if not SESSIONS_DIR.exists():
        empty_bucket = lambda: {
            "sessions": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_tokens": 0,
            "cache_creation_tokens": 0,
            "total_tokens": 0,
            "cost_usd": 0.0,
        }
        return {
            "summary": {
                "today": empty_bucket(),
                "week": empty_bucket(),
                "month": empty_bucket(),
                "all_time": empty_bucket(),
            },
            "history": [],
            "models": {},
            "total_sessions": 0,
            "total_input_tokens": 0,
            "total_output_tokens": 0,
            "total_cost_usd": 0.0,
            "sessions_today": 0,
            "sessions_this_week": 0,
        }

    now = time.time()
    today_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    week_start = now - 7 * 86400
    month_start = now - 30 * 86400

    from collections import defaultdict
    daily = defaultdict(lambda: {
        "sessions": set(),
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_creation_tokens": 0,
        "cost_usd": 0.0,
    })

    models = defaultdict(lambda: {
        "cost_usd": 0.0,
        "input_tokens": 0,
        "output_tokens": 0,
    })

    for jsonl_path in SESSIONS_DIR.glob("*.jsonl"):
        sid = jsonl_path.stem
        if not UUID_RE.match(sid):
            continue

        try:
            mtime = jsonl_path.stat().st_mtime
        except Exception:
            continue

        cost_state_obj = None
        assistant_seen = set()
        session_turns = []

        try:
            with jsonl_path.open("r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                        t = obj.get("type", "")
                        if t == "cost-state":
                            cost_state_obj = obj
                        elif t == "assistant":
                            msg = obj.get("message", {})
                            mid = msg.get("id")
                            if mid and mid not in assistant_seen:
                                assistant_seen.add(mid)
                                ts = _parse_ts(obj.get("timestamp")) or int(mtime)
                                u = msg.get("usage", {})
                                session_turns.append({
                                    "ts": ts,
                                    "input_tokens": int(u.get("input_tokens", 0)),
                                    "output_tokens": int(u.get("output_tokens", 0)),
                                    "cache_read_tokens": int(u.get("cache_read_input_tokens", 0)),
                                    "cache_creation_tokens": int(u.get("cache_creation_input_tokens", 0)),
                                })
                    except Exception:
                        pass
        except Exception:
            continue

        if cost_state_obj:
            cost = float(cost_state_obj.get("totalCostUSD", 0.0))
            st = cost_state_obj.get("startTime")
            ts = (st / 1000.0) if st else mtime
            day_str = datetime.fromtimestamp(ts).strftime("%Y-%m-%d")

            mu = cost_state_obj.get("modelUsage", {})
            if mu:
                inp = sum(int(m.get("inputTokens", 0)) for m in mu.values())
                out = sum(int(m.get("outputTokens", 0)) for m in mu.values())
                cr = sum(int(m.get("cacheReadInputTokens", 0)) for m in mu.values())
                cc = sum(int(m.get("cacheCreationInputTokens", 0)) for m in mu.values())
                for mname, mval in mu.items():
                    models[mname]["cost_usd"] += float(mval.get("costUSD", 0.0))
                    models[mname]["input_tokens"] += int(mval.get("inputTokens", 0))
                    models[mname]["output_tokens"] += int(mval.get("outputTokens", 0))
            else:
                inp = sum(t["input_tokens"] for t in session_turns)
                out = sum(t["output_tokens"] for t in session_turns)
                cr = sum(t["cache_read_tokens"] for t in session_turns)
                cc = sum(t["cache_creation_tokens"] for t in session_turns)

            daily[day_str]["sessions"].add(sid)
            daily[day_str]["input_tokens"] += inp
            daily[day_str]["output_tokens"] += out
            daily[day_str]["cache_read_tokens"] += cr
            daily[day_str]["cache_creation_tokens"] += cc
            daily[day_str]["cost_usd"] += cost
        else:
            for turn in session_turns:
                day_str = datetime.fromtimestamp(turn["ts"]).strftime("%Y-%m-%d")
                daily[day_str]["sessions"].add(sid)
                daily[day_str]["input_tokens"] += turn["input_tokens"]
                daily[day_str]["output_tokens"] += turn["output_tokens"]
                daily[day_str]["cache_read_tokens"] += turn["cache_read_tokens"]
                daily[day_str]["cache_creation_tokens"] += turn["cache_creation_tokens"]
                turn_cost = (
                    turn["input_tokens"] * 3.0 +
                    turn["output_tokens"] * 15.0 +
                    turn["cache_read_tokens"] * 0.30 +
                    turn["cache_creation_tokens"] * 3.75
                ) / 1_000_000.0
                daily[day_str]["cost_usd"] += turn_cost

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
        tot = d["input_tokens"] + d["output_tokens"] + d["cache_read_tokens"] + d["cache_creation_tokens"]
        day_item = {
            "date": day_str,
            "sessions": len(d["sessions"]),
            "input_tokens": d["input_tokens"],
            "output_tokens": d["output_tokens"],
            "cache_read_tokens": d["cache_read_tokens"],
            "cache_creation_tokens": d["cache_creation_tokens"],
            "total_tokens": tot,
            "cost_usd": round(d["cost_usd"], 4),
        }
        history_list.append(day_item)

        # Aggregate into all_time
        summary["all_time"]["sessions"] += day_item["sessions"]
        summary["all_time"]["input_tokens"] += day_item["input_tokens"]
        summary["all_time"]["output_tokens"] += day_item["output_tokens"]
        summary["all_time"]["cache_read_tokens"] += day_item["cache_read_tokens"]
        summary["all_time"]["cache_creation_tokens"] += day_item["cache_creation_tokens"]
        summary["all_time"]["total_tokens"] += tot
        summary["all_time"]["cost_usd"] = round(summary["all_time"]["cost_usd"] + day_item["cost_usd"], 4)

        # Check today
        dt_day = datetime.strptime(day_str, "%Y-%m-%d").timestamp()
        if day_str == today_str or dt_day >= today_start:
            for k in ("sessions", "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "total_tokens"):
                summary["today"][k] += day_item[k]
            summary["today"]["cost_usd"] = round(summary["today"]["cost_usd"] + day_item["cost_usd"], 4)

        # Check week
        if dt_day >= week_start:
            for k in ("sessions", "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "total_tokens"):
                summary["week"][k] += day_item[k]
            summary["week"]["cost_usd"] = round(summary["week"]["cost_usd"] + day_item["cost_usd"], 4)

        # Check month
        if dt_day >= month_start:
            for k in ("sessions", "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "total_tokens"):
                summary["month"][k] += day_item[k]
            summary["month"]["cost_usd"] = round(summary["month"]["cost_usd"] + day_item["cost_usd"], 4)

    return {
        "summary": summary,
        "history": history_list,
        "models": {k: {"cost_usd": round(v["cost_usd"], 4), "input_tokens": v["input_tokens"], "output_tokens": v["output_tokens"]} for k, v in models.items()},
        "total_sessions": summary["all_time"]["sessions"],
        "total_input_tokens": summary["all_time"]["input_tokens"],
        "total_output_tokens": summary["all_time"]["output_tokens"],
        "total_cost_usd": summary["all_time"]["cost_usd"],
        "sessions_today": summary["today"]["sessions"],
        "sessions_this_week": summary["week"]["sessions"],
    }

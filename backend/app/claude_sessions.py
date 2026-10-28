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
from .claude_transcript import first_prompt_title, read_thread, usage_summary
from .providers import atomic_write_json

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

CLAUDE_DIR = Path("/home/lufria/.claude")
HISTORY_FILE = CLAUDE_DIR / "history.jsonl"
SESSIONS_DIR = CLAUDE_DIR / "projects" / "-home-lufria"  # the home folder; other folders sit next to it

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
        return {field: binding.get(field) for field in ("model", "provider", "provider_id", "cwd", "locked")}


def set_session_binding(session_id: str, model: str, provider_id: str | None, provider: str | None,
                        cwd: str | None = None, locked: bool | None = None) -> None:
    _validate_sid(session_id)
    with _BINDINGS_LOCK:
        bindings = _read_bindings()
        old = bindings.get(session_id) or {}
        bindings[session_id] = {"model": model, "provider_id": provider_id, "provider": provider,
                                "cwd": cwd or old.get("cwd"), "locked": old.get("locked") if locked is None else locked}
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


def _project_dirs() -> list[Path]:
    """One directory per folder Claude Code has worked in; the home folder first."""
    try:
        others = sorted(d for d in SESSIONS_DIR.parent.iterdir() if d.is_dir() and d != SESSIONS_DIR)
    except OSError:
        others = []
    return [SESSIONS_DIR, *others]


def _transcripts():
    for project in _project_dirs():
        for path in project.glob("*.jsonl"):
            if UUID_RE.match(path.stem):
                yield path


def _session_file(session_id: str) -> Path:
    """The transcript, in whichever folder's project directory it is (session ids are UUIDs, so the
    name can't leave it). A missing session gets a path in the home folder that doesn't exist."""
    _validate_sid(session_id)
    for project in _project_dirs():
        p = project / f"{session_id}.jsonl"
        if p.exists():
            return p
    return SESSIONS_DIR / f"{session_id}.jsonl"


def _transcript_cwd(path: Path) -> str | None:
    """The folder a session ran in, as the CLI recorded it on its entries."""
    try:
        with path.open("rb") as fh:
            for i, raw in enumerate(fh):
                if b'"cwd"' in raw:
                    obj = json.loads(raw)
                    if isinstance(obj.get("cwd"), str):
                        return obj["cwd"]
                if i > 200:
                    break
    except (OSError, ValueError):
        pass
    return None


def session_cwd(session_id: str) -> str | None:
    """Turns of an existing session must run in its folder, or --resume can't find it."""
    binding = get_session_binding(session_id) or {}
    if binding.get("cwd"):
        return binding["cwd"]
    path = _session_file(session_id)
    return _transcript_cwd(path) if path.exists() else None


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


# path -> ((mtime_ns, size), summary): the sidebar is fetched after every turn; most files haven't changed.
_SCAN_CACHE: dict[Path, tuple[tuple[int, int], dict]] = {}


def _summarize(jsonl_path: Path) -> dict:
    """Message count, titles, latest model and folder of one transcript."""
    out = {"message_count": 0, "first_user_text": None, "custom_title": None, "ai_title": None,
           "model": None, "cwd": None}
    try:
        with jsonl_path.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    t = obj.get("type", "")
                    if out["cwd"] is None and isinstance(obj.get("cwd"), str):
                        out["cwd"] = obj["cwd"]
                    # meta entries (skill bodies, caveats) are not prompts
                    if t == "user" and not obj.get("isMeta"):
                        out["message_count"] += 1
                        if out["first_user_text"] is None:
                            out["first_user_text"] = first_prompt_title(obj.get("message", {}).get("content", ""))
                    elif t == "assistant":
                        out["message_count"] += 1
                        model = obj.get("message", {}).get("model")
                        if model and model != "<synthetic>":
                            out["model"] = model  # latest wins: sessions can switch models
                    elif t == "ai-title":
                        out["ai_title"] = str(obj.get("aiTitle", ""))[:60]
                    elif t == "custom-title":
                        out["custom_title"] = str(obj.get("customTitle", ""))[:60] or out["custom_title"]
                except Exception:
                    pass
    except Exception:
        pass
    return out


def _scan_sessions() -> list[dict]:
    """Return sessions list from the transcripts of every folder."""
    history = _read_history_sessions()
    sessions: list[dict] = []
    seen_paths = set()

    for jsonl_path in _transcripts():
        sid = jsonl_path.stem
        try:
            stat = jsonl_path.stat()
        except Exception:
            continue
        seen_paths.add(jsonl_path)
        key = (stat.st_mtime_ns, stat.st_size)
        cached = _SCAN_CACHE.get(jsonl_path)
        if cached and cached[0] == key:
            summary = cached[1]
        else:
            summary = _summarize(jsonl_path)
            _SCAN_CACHE[jsonl_path] = (key, summary)

        title = "(no title)"
        created_at = int(stat.st_ctime)
        project = summary["cwd"] or "/home/lufria"
        hist = history.get(sid)
        if hist:
            title = hist["title"]
            created_at = hist["created_at"] or created_at
            project = summary["cwd"] or hist["project"]

        # Priority: /rename > ai-title > first prompt > history.jsonl display
        title = summary["custom_title"] or summary["ai_title"] or summary["first_user_text"] or title
        binding = get_session_binding(sid) or {"provider": None, "provider_id": None}

        sessions.append({
            "id": sid,
            "title": title,
            "model": summary["model"] or "Claude Code",
            **binding,
            "cwd": binding.get("cwd") or project,
            "locked": bool(binding.get("locked")),
            "created_at": created_at,
            "updated_at": int(stat.st_mtime),
            "message_count": summary["message_count"],
            "size_bytes": stat.st_size,
            "project": project,
        })

    for gone in set(_SCAN_CACHE) - seen_paths:
        _SCAN_CACHE.pop(gone, None)

    # Sort newest first, cap at 50
    sessions.sort(key=lambda s: s["updated_at"], reverse=True)
    return sessions[:50]


# ---------------------------------------------------------------------------
# Per-session helpers
# ---------------------------------------------------------------------------

def _read_session(session_id: str, max_bytes: int | None = None) -> dict:
    """Read a session .jsonl file and return structured messages + usage."""
    _validate_sid(session_id)
    path = _session_file(session_id)
    if not path.exists():
        raise HTTPException(404, "session not found")
    try:
        thread = read_thread(path, max_bytes)
    except OSError as e:
        raise HTTPException(500, str(e))
    hist = _read_history_sessions().get(session_id)
    first = next((first_prompt_title(m["parts"][0].get("text") or "") for m in thread.messages
                  if m["role"] == "user" and m["parts"] and m["parts"][0]["kind"] == "text"), None)
    title = thread.custom_title or thread.title or first or (hist or {}).get("title") or session_id[:8]
    binding = get_session_binding(session_id) or {"provider": None, "provider_id": None}
    return {
        "id": session_id,
        "title": title,
        "messages": thread.messages,
        "usage": thread.usage,
        "model": thread.model or "Claude Code",
        **binding,
        "cwd": binding.get("cwd") or _transcript_cwd(path),
        "locked": bool(binding.get("locked")),
    }


def transcript_size(session_id: str) -> int:
    """Bytes in a transcript now; a running turn's history is cut here."""
    _validate_sid(session_id)
    try:
        return _session_file(session_id).stat().st_size
    except OSError:
        return 0


# ---------------------------------------------------------------------------
# Route handlers (called from main.py with @app.get/delete decorators)
# ---------------------------------------------------------------------------

def list_sessions() -> list[dict]:
    return _scan_sessions()


def get_session(session_id: str, max_bytes: int | None = None) -> dict:
    return _read_session(session_id, max_bytes)


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
    if not SESSIONS_DIR.parent.exists():
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

    for jsonl_path in _transcripts():
        sid = jsonl_path.stem

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
                # Same prices as the page's usage line: the CLI only guesses for custom models.
                priced = usage_summary(mu)
                cost = priced["total_cost_usd"]
                inp, out = priced["input_tokens"], priced["output_tokens"]
                cr, cc = priced["cache_read_input_tokens"], priced["cache_creation_input_tokens"]
                for m in priced["models"]:
                    models[m["model"]]["cost_usd"] += m["cost_usd"] or 0.0
                    models[m["model"]]["input_tokens"] += m["input_tokens"]
                    models[m["model"]]["output_tokens"] += m["output_tokens"]
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

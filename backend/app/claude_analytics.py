"""Live usage analytics over every Claude Code transcript: one event per model request.

Transcripts are append-only, so each file is read once and then only from where it stopped. Official Claude
models have no price per request in the transcript, only the CLI's running per-model cost (`cost-state`).
That cost gives each model's price per weighted token, so a request's cost is its weighted tokens times that
rate. Tokens the CLI counted but the main thread doesn't show (subagents) become one event without a request.
"""
import json
import threading
import time
from bisect import bisect_right
from collections import defaultdict
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from app import claude_sessions, db, pricing

RANGES = ("today", "24h", "7d", "30d", "60d", "all")
LIVE_WINDOW = 120   # seconds a model counts as "in use" after its last request
RECENT = 15
# Anthropic's price ratios against one input token: output 5x, cache read 0.1x, cache write 1.25x.
_W_OUT, _W_READ, _W_WRITE = 5.0, 0.1, 1.25
_COUNTS = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens")
_CLI_KEYS = {"input_tokens": "inputTokens", "output_tokens": "outputTokens",
             "cache_read_tokens": "cacheReadInputTokens", "cache_write_tokens": "cacheCreationInputTokens"}

_lock = threading.Lock()


class _File:
    def __init__(self, sid: str = ""):
        self.sid = sid
        self.offset = 0
        self.mtime_ns = 0
        self.events: dict[str, dict] = {}   # message id -> event, later lines replace earlier ones
        self.cost_state: dict | None = None


_files: dict[str, _File] = {}


def _weight(c: dict) -> float:
    return c["input_tokens"] + _W_OUT * c["output_tokens"] + _W_READ * c["cache_read_tokens"] + _W_WRITE * c["cache_write_tokens"]


def _read_new(path, state: _File) -> None:
    """Fold the complete lines written since the last read into `state`."""
    try:
        size = path.stat().st_size
        if size < state.offset:   # rewritten: start over
            state.offset, state.events, state.cost_state = 0, {}, None
        with path.open("rb") as fh:
            fh.seek(state.offset)
            chunk = fh.read()
    except OSError:
        return
    end = chunk.rfind(b"\n")
    if end < 0:
        return
    state.offset += end + 1
    for raw in chunk[:end].split(b"\n"):
        try:
            obj = json.loads(raw)
        except ValueError:
            continue
        kind = obj.get("type")
        if kind == "cost-state":
            state.cost_state = obj
        elif kind == "assistant":
            msg = obj.get("message") or {}
            model, mid, u = msg.get("model"), msg.get("id"), msg.get("usage") or {}
            if not mid or not model or model == "<synthetic>":
                continue
            state.events[mid] = {
                "ts": claude_sessions._parse_ts(obj.get("timestamp")), "sid": path.stem, "model": model, "request": True,
                "input_tokens": int(u.get("input_tokens") or 0), "output_tokens": int(u.get("output_tokens") or 0),
                "cache_read_tokens": int(u.get("cache_read_input_tokens") or 0),
                "cache_write_tokens": int(u.get("cache_creation_input_tokens") or 0),
            }


def _refresh() -> list[_File]:
    seen = set()
    for path in claude_sessions._transcripts():
        key = str(path)
        seen.add(key)
        try:
            mtime_ns = path.stat().st_mtime_ns
        except OSError:
            continue
        state = _files.setdefault(key, _File(path.stem))
        if state.mtime_ns != mtime_ns:
            _read_new(path, state)
            state.mtime_ns = mtime_ns
    for key in set(_files) - seen:
        del _files[key]
    return list(_files.values())


def _all_events() -> tuple[list[dict], dict[str, float]]:
    """Every event, oldest first, with each official model's price per weighted token."""
    states = _refresh()
    cost, weight = defaultdict(float), defaultdict(float)
    extra: list[dict] = []
    for state in states:
        usage = (state.cost_state or {}).get("modelUsage") or {}
        main = defaultdict(lambda: dict.fromkeys(_COUNTS, 0))
        last_ts = 0
        for e in state.events.values():
            last_ts = max(last_ts, e["ts"])
            for k in _COUNTS:
                main[e["model"]][k] += e[k]
        for model, raw in usage.items():
            if not isinstance(raw, dict):
                continue
            counts = {k: int(raw.get(_CLI_KEYS[k]) or 0) for k in _COUNTS}
            if pricing.cli_knows_price(model) and raw.get("costUSD") is not None:
                cost[model] += float(raw["costUSD"])
                weight[model] += _weight(counts)
            rest = {k: max(0, counts[k] - main[model][k]) for k in _COUNTS}
            if any(rest.values()):
                extra.append({"ts": last_ts or int(time.time()), "sid": state.sid, "model": model, "request": False, **rest})
    rates = {m: cost[m] / weight[m] for m in cost if weight[m] > 0}
    events = [e for s in states for e in s.events.values()] + extra
    events.sort(key=lambda e: e["ts"])
    return events, rates


def _event_cost(e: dict, rates: dict[str, float]) -> float | None:
    model = e["model"]
    if model in rates:
        return _weight(e) * rates[model]
    if not pricing.cli_knows_price(model):
        return pricing.estimate_cost_usd(model, e["input_tokens"], e["output_tokens"], e["cache_read_tokens"], e["cache_write_tokens"])
    return None   # an official model in a session without a cost record


def _family(model: str) -> str:
    low = model.lower()
    for name in ("opus", "sonnet", "haiku", "fable"):
        if name in low:
            return name.capitalize()
    return model.split("/")[0] if "/" in model else "Other"


def _slots(rng: str, tz: ZoneInfo, first_ts: float | None) -> tuple[list[float], float]:
    """Bucket start times (epoch seconds) for the range, and the end of the last one."""
    now = datetime.now(tz)
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if rng == "today":
        start, step, stop = midnight, timedelta(hours=1), midnight + timedelta(days=1)
    elif rng == "24h":
        start, step, stop = now.replace(minute=0, second=0, microsecond=0) - timedelta(hours=23), timedelta(hours=1), now
    elif rng == "7d":
        start, step, stop = midnight - timedelta(days=6), timedelta(hours=6), midnight + timedelta(days=1)
    elif rng in ("30d", "60d"):
        days = int(rng[:-1])
        start, step, stop = midnight - timedelta(days=days - 1), timedelta(days=1), midnight + timedelta(days=1)
    else:
        first = datetime.fromtimestamp(first_ts, tz).replace(hour=0, minute=0, second=0, microsecond=0) if first_ts else midnight
        step = timedelta(days=7 if (midnight - first).days > 180 else 1)
        start, stop = first, midnight + timedelta(days=1)
    slots, cur = [], start
    while cur < stop:
        slots.append(cur.timestamp())
        cur += step
    return slots, stop.timestamp()


def snapshot(rng: str = "today") -> dict:
    tz = ZoneInfo(db.get_settings()["timezone"])
    with _lock:
        events, rates = _all_events()
    slots, stop = _slots(rng, tz, events[0]["ts"] if events else None)
    start = slots[0]
    inside = [e for e in events if start <= e["ts"] < stop]

    def empty():
        return {"requests": 0, **dict.fromkeys(_COUNTS, 0), "cost_usd": 0.0}

    series = [{"t": int(t), **empty()} for t in slots]
    totals, by_model, by_family = empty(), defaultdict(empty), defaultdict(empty)
    last_used: dict[str, int] = {}
    sessions, unpriced = set(), False
    for e in inside:
        cost = _event_cost(e, rates)
        unpriced = unpriced or cost is None
        family = _family(e["model"])
        row = series[bisect_right(slots, e["ts"]) - 1]
        for bucket in (row, totals, by_model[e["model"]], by_family[family]):
            bucket["requests"] += 1 if e["request"] else 0
            bucket["cost_usd"] += cost or 0.0
            for k in _COUNTS:
                bucket[k] += e[k]
        last_used[e["model"]] = max(last_used.get(e["model"], 0), e["ts"])
        sessions.add(e["sid"])

    def finish(bucket: dict) -> dict:
        bucket["tokens"] = sum(bucket[k] for k in _COUNTS)
        bucket["cost_usd"] = round(bucket["cost_usd"], 6)
        return bucket

    now = time.time()
    latest = [e for e in reversed(events) if e["request"]][:RECENT]
    recent = [{"ts": e["ts"], "model": e["model"], "session": e["sid"], **{k: e[k] for k in _COUNTS},
               "cost_usd": None if (c := _event_cost(e, rates)) is None else round(c, 6)} for e in latest]
    return {
        "generated_at": now, "range": rng, "timezone": tz.key, "unpriced": unpriced,
        "step_seconds": int(slots[1] - slots[0]) if len(slots) > 1 else 3600,
        "totals": {**finish(totals), "sessions": len(sessions)},
        "series": [finish(r) for r in series],
        "by_family": sorted(({"family": f, **finish(b)} for f, b in by_family.items()), key=lambda r: -r["tokens"]),
        "by_model": sorted(({"model": m, "family": _family(m), "last_used": last_used[m], **finish(b)}
                            for m, b in by_model.items()), key=lambda r: -r["tokens"]),
        "recent": recent,
        "live_models": sorted({e["model"] for e in events if e["request"] and now - e["ts"] <= LIVE_WINDOW}),
    }

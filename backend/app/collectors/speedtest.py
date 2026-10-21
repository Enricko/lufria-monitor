"""Internet speed test using the Ookla CLI (`speedtest -f json`)."""
import asyncio
import json
import shutil
import time

from .. import db
from ..config import BIN_DIR

_lock = asyncio.Lock()
state = {"running": False, "last_error": None}


def _binary() -> str | None:
    local = BIN_DIR / "speedtest"
    if local.exists():
        return str(local)
    return shutil.which("speedtest")


async def run() -> dict:
    if _lock.locked():
        return {"error": "already running"}
    async with _lock:
        state["running"] = True
        try:
            return await _run()
        finally:
            state["running"] = False


async def _run() -> dict:
    binary = _binary()
    row = {"ts": int(time.time())}
    if binary is None:
        row["error"] = "speedtest CLI not installed"
    else:
        proc = await asyncio.create_subprocess_exec(
            binary, "--accept-license", "--accept-gdpr", "-f", "json",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=120)
        except asyncio.TimeoutError:
            proc.kill()
            out, err = b"", b"timeout"
        try:
            r = json.loads(out)
            row.update({
                "down_mbps": r["download"]["bandwidth"] * 8 / 1e6,
                "up_mbps": r["upload"]["bandwidth"] * 8 / 1e6,
                "ping_ms": r["ping"]["latency"],
                "jitter_ms": r["ping"].get("jitter"),
                "loss": r.get("packetLoss"),
                "server": f'{r["server"]["name"]} ({r["server"]["location"]})',
                "isp": r.get("isp"),
                "url": r.get("result", {}).get("url"),
            })
        except (ValueError, KeyError, TypeError):
            row["error"] = (err.decode(errors="replace") or out.decode(errors="replace")).strip()[:300]
    db.insert("speedtests", row)
    state["last_error"] = row.get("error")
    return row


def history(limit: int = 200) -> list[dict]:
    return db.query("SELECT * FROM speedtests ORDER BY ts DESC LIMIT ?", (limit,))[::-1]


async def scheduler() -> None:
    while True:
        hours = float(db.get_settings()["speedtest_interval_hours"] or 0)
        last = db.query("SELECT MAX(ts) AS ts FROM speedtests")[0]["ts"] or 0
        if hours > 0 and time.time() - last >= hours * 3600:
            await run()
        await asyncio.sleep(60)

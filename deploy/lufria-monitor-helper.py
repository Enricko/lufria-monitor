#!/usr/bin/env python3
"""Root helper for Lufria Monitor.

Reads root-only data and publishes it as world-readable JSON in /run/lufria-monitor:
  power.json  - Intel RAPL watts per domain + latest WattSeal reading, every second
  apps.json   - WattSeal per-app energy over rolling windows, every 2 minutes
  smart.json  - smartctl health per disk, every 30 minutes

WattSeal (wattseal.service) keeps its SQLite DB in WAL mode as root, so it is
read here rather than by the unprivileged web app.
"""
import json
import os
import sqlite3
import subprocess
import time
from pathlib import Path

OUT = Path("/run/lufria-monitor")
RAPL = Path("/sys/class/powercap")
SMART_EVERY = 1800
APPS_EVERY = 120

WATTSEAL_DB = Path("/opt/wattseal/power_monitoring.db")
HOUR_MS = 3_600_000  # WattSeal rows with duration_ms < 1h are raw per-second samples
COMPONENT_TABLES = {"cpu": "cpu_data", "ram": "ram_data", "disk": "disk_data", "net": "network_data",
                    "total": "total_data"}
APP_WINDOWS = {"1h": 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400}


def write(name: str, data: dict) -> None:
    tmp = OUT / f".{name}.tmp"
    tmp.write_text(json.dumps(data))
    tmp.chmod(0o644)
    os.replace(tmp, OUT / name)


def rapl_domains() -> dict[str, tuple[Path, int]]:
    """Map domain name -> (energy_uj path, max range). Uses the MSR interface (intel-rapl:*)."""
    domains = {}
    for d in sorted(RAPL.glob("intel-rapl:*")):
        try:
            name = (d / "name").read_text().strip()
            max_range = int((d / "max_energy_range_uj").read_text())
        except OSError:
            continue
        if name.startswith("package"):
            name = "package" if "package" not in domains else name
        domains.setdefault(name, (d / "energy_uj", max_range))
    return domains


def smart() -> dict:
    out = {"_ts": time.time()}
    try:
        devs = json.loads(subprocess.run(["lsblk", "-J", "-d", "-o", "NAME,TYPE"],
                                         capture_output=True, text=True, timeout=10).stdout)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return out
    for d in devs.get("blockdevices", []):
        if d["type"] != "disk" or d["name"].startswith(("loop", "zram")):
            continue
        try:
            r = json.loads(subprocess.run(["smartctl", "-j", "-a", f"/dev/{d['name']}"],
                                          capture_output=True, text=True, timeout=60).stdout)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            continue
        attrs = {a["name"]: a["raw"]["value"] for a in r.get("ata_smart_attributes", {}).get("table", [])}
        nvme = r.get("nvme_smart_health_information_log", {})
        out[d["name"]] = {
            "available": "smart_status" in r,
            "passed": r.get("smart_status", {}).get("passed"),
            "model": r.get("model_name"),
            "serial": r.get("serial_number"),
            "temperature": r.get("temperature", {}).get("current"),
            "power_on_hours": r.get("power_on_time", {}).get("hours"),
            "power_cycles": r.get("power_cycle_count"),
            "reallocated": attrs.get("Reallocated_Sector_Ct"),
            "pending": attrs.get("Current_Pending_Sector"),
            "percent_used": nvme.get("percentage_used"),
            "data_written_tb": nvme["data_units_written"] * 512000 / 1e12 if "data_units_written" in nvme else None,
            "messages": [m.get("string") for m in r.get("smartctl", {}).get("messages", [])],
        }
    return out


class WattSeal:
    def __init__(self):
        self.conn: sqlite3.Connection | None = None

    def _db(self) -> sqlite3.Connection:
        if self.conn is None:
            if not WATTSEAL_DB.exists():
                raise FileNotFoundError(WATTSEAL_DB)
            self.conn = sqlite3.connect(f"file:{WATTSEAL_DB}?mode=ro", uri=True, timeout=2)
        return self.conn

    def _query(self, sql: str, params: tuple = ()) -> list:
        try:
            return self._db().execute(sql, params).fetchall()
        except sqlite3.Error:
            self.conn = None  # reopen next time (e.g. WattSeal recreated the DB)
            raise

    def _tables(self) -> set[str]:
        return {r[0] for r in self._query("SELECT name FROM sqlite_master WHERE type='table'")}

    def live(self) -> dict:
        """Latest per-second reading of every component, in watts."""
        tables = self._tables()
        out: dict = {}
        ts = None
        for key, table in COMPONENT_TABLES.items():
            if table not in tables:
                continue
            row = self._query(f"SELECT timestamp, duration_ms, total_energy_uj FROM {table} "
                              "WHERE duration_ms < ? ORDER BY timestamp DESC LIMIT 1", (HOUR_MS,))
            if row and row[0][2] is not None:
                t, dur, uj = row[0]
                out[key] = uj / max(dur, 1) / 1000
                ts = max(ts or 0, t)
        if "gpu_data" in tables:
            row = self._query("SELECT timestamp, MAX(duration_ms), SUM(total_energy_uj) FROM gpu_data "
                              "WHERE timestamp = (SELECT MAX(timestamp) FROM gpu_data WHERE duration_ms < ?)",
                              (HOUR_MS,))
            if row and row[0][2] is not None:
                out["gpu"] = row[0][2] / max(row[0][1], 1) / 1000
        row = self._query("SELECT usage_percent FROM cpu_data WHERE duration_ms < ? ORDER BY timestamp DESC LIMIT 1",
                          (HOUR_MS,))
        out["cpu_usage"] = row[0][0] if row else None
        apps = self._query(
            """SELECT a.name, p.process_energy_uj, p.duration_ms, p.process_cpu_usage, p.process_mem_usage,
                      p.subprocess_count
               FROM process_data p JOIN apps a ON a.id = p.app_id
               WHERE p.duration_ms < ? AND p.timestamp = (SELECT MAX(timestamp) FROM process_data WHERE duration_ms < ?)
               ORDER BY p.process_energy_uj DESC LIMIT 12""", (HOUR_MS, HOUR_MS))
        out["apps"] = [{"name": n, "w": (uj or 0) / max(dur, 1) / 1000, "cpu": cpu, "mem": mem, "procs": procs}
                       for n, uj, dur, cpu, mem, procs in apps]
        out["ts"] = ts / 1000 if ts else None
        return out

    def app_windows(self) -> dict:
        """Per-app energy (uJ) and WattSeal's total energy over rolling windows."""
        now_ms = int(time.time() * 1000)
        result = {"_ts": time.time()}
        for name, seconds in APP_WINDOWS.items():
            since = now_ms - seconds * 1000
            total = self._query("SELECT SUM(total_energy_uj) FROM total_data WHERE timestamp >= ?", (since,))
            rows = self._query(
                """SELECT a.name, SUM(p.process_energy_uj) AS e, AVG(p.process_cpu_usage), COUNT(*)
                   FROM process_data p JOIN apps a ON a.id = p.app_id
                   WHERE p.timestamp >= ? GROUP BY a.name ORDER BY e DESC LIMIT 25""", (since,))
            result[name] = {
                "total_uj": total[0][0] or 0,
                "apps": [{"name": n, "uj": e or 0, "cpu": cpu, "samples": cnt} for n, e, cpu, cnt in rows],
            }
        return result


def main() -> None:
    OUT.mkdir(mode=0o755, exist_ok=True)
    domains = rapl_domains()
    prev = {n: int(p.read_text()) for n, (p, _) in domains.items()}
    prev_t = time.monotonic()
    next_smart = 0.0
    next_apps = 0.0
    wattseal = WattSeal()
    while True:
        time.sleep(1)
        now = time.monotonic()
        dt = now - prev_t
        watts = {"ts": time.time()}
        for name, (path, max_range) in domains.items():
            try:
                e = int(path.read_text())
            except OSError:
                continue
            delta = e - prev[name]
            if delta < 0:  # counter wrapped
                delta += max_range
            watts[name] = delta / dt / 1e6
            prev[name] = e
        prev_t = now
        out = {"ts": watts.pop("ts"), "rapl": watts, "wattseal": None, "wattseal_error": None}
        try:
            out["wattseal"] = wattseal.live()
        except (OSError, sqlite3.Error) as e:
            out["wattseal_error"] = str(e)
        write("power.json", out)
        if time.time() >= next_apps:
            try:
                write("apps.json", wattseal.app_windows())
            except (OSError, sqlite3.Error):
                pass
            next_apps = time.time() + APPS_EVERY
        if time.time() >= next_smart:
            write("smart.json", smart())
            next_smart = time.time() + SMART_EVERY


if __name__ == "__main__":
    main()

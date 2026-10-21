import json
import sqlite3
import threading
import time

from .config import DATA_DIR, DB_PATH, DEFAULT_SETTINGS, RETENTION_DAYS

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS samples (
    ts INTEGER PRIMARY KEY,      -- minute start, unix seconds UTC
    cpu REAL, mem REAL, swap REAL, load1 REAL,
    cpu_temp REAL, gpu_temp REAL, nvme_temp REAL,
    net_rx REAL, net_tx REAL,    -- bytes/s averaged over the minute
    disk_r REAL, disk_w REAL,    -- bytes/s
    watts REAL, watts_max REAL,
    rapl_pkg REAL, rapl_dram REAL,
    wh REAL,                     -- energy consumed during this minute
    seconds INTEGER,             -- seconds actually sampled in the minute
    p_cpu REAL, p_ram REAL, p_gpu REAL, p_disk REAL, p_net REAL, p_overhead REAL,  -- component watts
    ws_raw REAL,                 -- WattSeal's own (uncorrected) total, for scaling per-app energy
    gpu_util REAL, gpu_vram REAL, -- dGPU load % and VRAM % (0 while asleep)
    gpu_awake REAL,              -- fraction of the minute the dGPU was powered on
    fan_cpu REAL, fan_gpu REAL   -- RPM
);
CREATE TABLE IF NOT EXISTS speedtests (
    ts INTEGER PRIMARY KEY,
    down_mbps REAL, up_mbps REAL, ping_ms REAL, jitter_ms REAL, loss REAL,
    server TEXT, isp TEXT, url TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.executescript(SCHEMA)
        _migrate(_conn)
    return _conn


ADDED_COLUMNS = ("p_cpu", "p_ram", "p_gpu", "p_disk", "p_net", "p_overhead", "ws_raw",
                 "gpu_util", "gpu_vram", "gpu_awake", "fan_cpu", "fan_gpu")


def _migrate(c: sqlite3.Connection) -> None:
    have = {r[1] for r in c.execute("PRAGMA table_info(samples)")}
    for col in ADDED_COLUMNS:
        if col not in have:
            c.execute(f"ALTER TABLE samples ADD COLUMN {col} REAL")
    c.commit()


def query(sql: str, params: tuple = ()) -> list[dict]:
    with _lock:
        return [dict(r) for r in conn().execute(sql, params).fetchall()]


def execute(sql: str, params: tuple = ()) -> None:
    with _lock:
        c = conn()
        c.execute(sql, params)
        c.commit()


def insert(table: str, row: dict) -> None:
    cols = ",".join(row)
    marks = ",".join("?" * len(row))
    execute(f"INSERT OR REPLACE INTO {table} ({cols}) VALUES ({marks})", tuple(row.values()))


def prune() -> None:
    execute("DELETE FROM samples WHERE ts < ?", (int(time.time()) - RETENTION_DAYS * 86400,))


def get_settings() -> dict:
    stored = {r["key"]: json.loads(r["value"]) for r in query("SELECT key, value FROM settings")}
    return {**DEFAULT_SETTINGS, **stored}


def save_settings(values: dict) -> dict:
    for key, value in values.items():
        if key in DEFAULT_SETTINGS:
            execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, json.dumps(value)))
    return get_settings()

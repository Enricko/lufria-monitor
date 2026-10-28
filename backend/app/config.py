import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "monitor.db"
UPLOAD_DIR = DATA_DIR / "uploads"  # files sent to the terminal, pasted as paths (Claude Code attaches images)
BIN_DIR = ROOT / "bin"
FRONTEND_DIST = ROOT / "frontend" / "dist"

# Written by the root helper (deploy/lufria-monitor-helper.py)
HELPER_DIR = Path("/run/lufria-monitor")
POWER_FILE = HELPER_DIR / "power.json"
SMART_FILE = HELPER_DIR / "smart.json"
APPS_FILE = HELPER_DIR / "apps.json"

CLOUDFLARED_CONFIG = Path("/etc/cloudflared/config.yml")

# Passkeys only work on this origin (HTTPS, through the tunnel). Other ways in, like the LAN IP,
# sign in with the QR code, which the phone approves here.
PUBLIC_ORIGIN = os.environ.get("MONITOR_ORIGIN", "https://monitor.lufria.tech")

SAMPLE_INTERVAL = 1.0  # seconds between live samples
RETENTION_DAYS = 400   # per-minute samples kept for long-term energy stats

# PLN residential tariffs (Rp/kWh). Tariffs are set quarterly by the government;
# update via Settings if PLN changes them.
TARIFF_PRESETS = {
    "R1-450-subsidi": {"label": "R-1/450 VA (subsidi)", "rate": 415.0},
    "R1-900-subsidi": {"label": "R-1/900 VA (subsidi)", "rate": 605.0},
    "R1-900-RTM": {"label": "R-1/900 VA RTM", "rate": 1352.0},
    "R1-1300": {"label": "R-1/1300 VA", "rate": 1444.70},
    "R1-2200": {"label": "R-1/2200 VA", "rate": 1444.70},
    "R2-3500-5500": {"label": "R-2/3500-5500 VA", "rate": 1699.53},
    "R3-6600": {"label": "R-3/6600 VA ke atas", "rate": 1699.53},
    "custom": {"label": "Custom", "rate": None},
}

DEFAULT_SETTINGS = {
    "tariff_preset": "R1-1300",
    "tariff_rp_per_kwh": 1444.70,
    "ppj_percent": 0.0,          # Pajak Penerangan Jalan, varies per region (0-10%)
    "overhead_watts": 8.0,       # board, fans, Wi-Fi, idle dGPU, adapter loss - not modelled by WattSeal
    "timezone": "Asia/Jakarta",
    "speedtest_interval_hours": 3,
    "watched_services": [
        "ssh", "docker", "cloudflared", "wattseal", "lufria-monitor", "lufria-monitor-helper",
    ],
}

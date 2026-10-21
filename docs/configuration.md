# Configuration

Most settings live in the dashboard (**Settings** page, stored in SQLite). A few are fixed at install time or
in code.

## Settings page

Stored in the `settings` table of `data/monitor.db`. Unset keys fall back to the defaults in
`backend/app/config.py` (`DEFAULT_SETTINGS`). Also editable with `PUT /api/settings` (see [api.md](api.md)).

| Key | Default | Meaning |
|---|---|---|
| `tariff_preset` | `R1-1300` | PLN tariff group, or `custom`. Picking a preset also sets the rate |
| `tariff_rp_per_kwh` | `1444.70` | Rp per kWh used for every cost figure |
| `ppj_percent` | `0` | Pajak Penerangan Jalan (street-lighting tax), added on top of the energy cost. Varies by region, 0-10 % |
| `overhead_watts` | `8.0` | Constant watts for what no sensor sees: board, fans, Wi-Fi, idle dGPU, charger loss. A plug-in meter gives the real figure. See [power-model.md](power-model.md) |
| `timezone` | `Asia/Jakarta` | Time zone for hour/day/week/month energy buckets |
| `speedtest_interval_hours` | `3` | Hours between scheduled Ookla tests. `0` turns the schedule off (manual tests still work) |
| `watched_services` | `ssh, docker, cloudflared, wattseal, lufria-monitor, lufria-monitor-helper` | systemd units pinned at the top of the Services page |

PLN presets (Rp/kWh) are in `TARIFF_PRESETS` in `config.py`. Tariffs are set quarterly; if PLN changes them,
pick **Custom** and type the new rate, or update the table.

## Environment

| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `MONITOR_ORIGIN` | `https://monitor.lufria.tech` | dashboard | Public HTTPS origin. Passkeys are bound to it (WebAuthn relying party ID = its hostname) and QR codes link to it. **Set this when you deploy under your own domain** |
| `PORT` | `8090` | `deploy/install.sh` | Port the dashboard listens on |
| `HOST` | `0.0.0.0` | `deploy/install.sh` | Address to bind. `127.0.0.1` keeps it off the LAN (tunnel only) |
| `APP_USER` | the user who ran `sudo` | `deploy/install.sh` | Non-root user the dashboard (and its terminal) runs as |

`deploy/install.sh` doesn't write `MONITOR_ORIGIN`. Set it with a drop-in, which survives reinstalls:

```bash
sudo systemctl edit lufria-monitor
# add:
#   [Service]
#   Environment=MONITOR_ORIGIN=https://monitor.example.com
sudo systemctl restart lufria-monitor
```

Changing the origin later invalidates existing passkeys (they belong to the old hostname). Use the recovery
link (`python -m app.auth enroll`, see [authentication.md](authentication.md#recovery-every-device-lost)) to add
one for the new origin.

## Constants in code

`backend/app/config.py`:

| Constant | Value | Meaning |
|---|---|---|
| `SAMPLE_INTERVAL` | 1 s | Live sampling and WebSocket push interval |
| `RETENTION_DAYS` | 400 | Per-minute samples older than this are deleted |
| `CLOUDFLARED_CONFIG` | `/etc/cloudflared/config.yml` | Read (never written) to list tunnel routes on the Services page |
| `HELPER_DIR` | `/run/lufria-monitor` | Where the root helper publishes `power.json`, `apps.json`, `smart.json` |

`backend/app/terminal.py`: `MAX_SESSIONS` 8 shells, `SCROLLBACK` 512 KB replay per shell.

`backend/app/auth.py`: session 30 days, lockout after 5 failures in 5 minutes, passkey challenges and QR
requests 2 minutes, enrolment links 15 minutes.

## Files and services

| Path | Owner | What |
|---|---|---|
| `data/monitor.db` | dashboard user | SQLite: per-minute samples, speed tests, settings. Back this up to keep history |
| `data/auth.json` | dashboard user, mode 600 | Bootstrap password hash, session key, passkeys. **Missing = no sign-in required** |
| `bin/speedtest` | dashboard user | Ookla CLI from `deploy/install-speedtest.sh` (not redistributable, so not in git) |
| `/run/lufria-monitor/*.json` | root | Root helper output, rewritten every 1 s (power), 2 min (apps), 30 min (SMART) |
| `/opt/lufria-monitor/` | root | Installed copy of the root helper |
| `/opt/wattseal/` | root | WattSeal binary and its database |
| `/etc/systemd/system/lufria-monitor.service` | root | Generated from `deploy/lufria-monitor.service.in` |
| `/etc/systemd/system/lufria-monitor-helper.service` | root | Root helper |
| `/etc/systemd/system/wattseal.service` | root | WattSeal, headless |

`data/` and `bin/` are git-ignored.

## Backups

```bash
sqlite3 ~/monitor/data/monitor.db ".backup '/path/to/monitor-$(date +%F).db'"
cp ~/monitor/data/auth.json /path/to/auth.json   # keep it private: it can sign sessions
```

Use `.backup` (or stop the service first) rather than copying the live database file.

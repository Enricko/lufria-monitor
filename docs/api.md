# API

Everything under `/api/` and `/ws/` needs the session cookie (`lufria_monitor_session`, 30 days), which a
passkey sign-in, an approved QR sign-in or an enrolment link sets. The only exceptions are the `/api/auth/*`
routes. Without a valid cookie you get a 401, or the WebSocket closes.

Passkeys are bound to `MONITOR_ORIGIN` (default `https://monitor.lufria.tech`). The password only exists to
bootstrap: once one passkey is stored, `POST /api/auth/login` returns 403 and older sessions end.
Passkey bodies are WebAuthn JSON (binary fields base64url); `{flow, options}` comes from the matching
`options` route and the challenge is single use (2 min). Failed passkey/QR/enrol attempts count toward the
same 5-in-5-minutes lockout as the password.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/auth/status` | `{enabled, authenticated, password, passkeys, origin}`: `password` is true only while no passkey exists |
| POST | `/api/auth/login` | Body `{password}`. Sets the cookie. 401 wrong password, 403 once passkeys exist, 429 after 5 failures in 5 min |
| POST | `/api/auth/passkey/options` | `{flow, options}` for a discoverable-passkey sign-in (user verification required) |
| POST | `/api/auth/passkey` | Body `{flow, credential}`. Sets the cookie. 401 if the passkey isn't accepted |
| POST | `/api/auth/qr` | New QR sign-in: `{id, poll, code, url, qr, expires_in}`. `qr` is an SVG data URI of `url` (`/approve/{id}`), valid 2 min. 409 before any passkey exists |
| POST | `/api/auth/qr/{id}/poll` | Body `{poll}`. `{status}`: `pending`, `approved` (sets the cookie, once), `denied` or `expired` |
| GET | `/api/auth/qr/{id}` | For the phone: `{code, ip, device, country, created, expires}`. 404 once used or expired |
| POST | `/api/auth/qr/{id}/options` | `{flow, options}` for approving with a passkey |
| POST | `/api/auth/qr/{id}/approve` | Body `{flow, credential}`. Marks the request approved |
| POST | `/api/auth/qr/{id}/deny` | Marks the request denied |
| POST | `/api/auth/enroll/options` | Body `{token}` from `python -m app.auth enroll`. `{flow, options}` to create a passkey. 404 for a used or expired token |
| POST | `/api/auth/enroll` | Body `{token, flow, credential, name}`. Stores the passkey, uses up the token, sets the cookie |
| POST | `/api/auth/logout` | Clears the cookie |
| GET | `/api/passkeys` | `[{id, name, synced, created, last_used}]` |
| POST | `/api/passkeys/options` | `{flow, options}` to add a passkey from a signed-in browser |
| POST | `/api/passkeys` | Body `{flow, credential, name}`. Adds it; the first one turns password sign-in off and replaces this browser's cookie |
| DELETE | `/api/passkeys/{id}` | Removes one. 400 for the last passkey |
| GET | `/api/specs` | Hostname, machine, OS, kernel, CPU, memory, GPUs + drivers, disks, NICs |
| GET | `/api/live` | The latest 1-second snapshot (same shape as the WebSocket messages) |
| WS | `/ws/live` | One snapshot per second: `cpu`, `mem`, `swap`, `temps`, `fans`, `net`, `disk`, `gpu`, `power`, `uptime`, `profile` |
| GET | `/api/history?range=1h\|6h\|24h\|7d\|30d` | About 360 averaged points: cpu/mem/temps/net/disk, watts and `p_*` component watts, gpu_util/vram/awake, fans |
| GET | `/api/processes` | Top processes by CPU and by memory |
| GET | `/api/storage` | Filesystems, disks, partitions, SMART |
| GET | `/api/services` | Watched systemd units, all units, Docker containers, Cloudflare Tunnel routes |
| GET | `/api/power/summary` | kWh and cost for this hour, today, week, month, all time, plus a projection and the effective rate |
| GET | `/api/power/buckets?period=hour\|day\|week\|month` | Per-bucket kWh, cost, average and peak W, coverage, and the per-component kWh split |
| GET | `/api/power/apps?window=1h\|24h\|7d\|30d` | Per-app kWh, cost and share (scaled, see [power-model.md](power-model.md#per-app-energy)) |
| GET | `/api/speedtest` | `{running, history[]}` |
| POST | `/api/speedtest` | Starts a test (409 if one is already running) |
| GET | `/api/settings` | Current settings + PLN tariff presets |
| GET | `/api/terminal` | `{user, max, sessions: [{id, created}]}`: the open terminal sessions |
| POST | `/api/terminal` | Body `{cols, rows}` (optional). Starts a login shell, returns `{id, created}`. 409 when `max` (8) are open |
| DELETE | `/api/terminal/{id}` | Hangs up that shell |
| WS | `/ws/terminal/{id}?since=N` | Binary frames are terminal bytes both ways. Client text frame: `{"type":"resize","cols","rows"}`. Server text frames: `{"type":"attach","offset","reset"}` first (output resumes at byte `offset`; `reset` means clear the screen, the buffer no longer reaches `since`), then `{"type":"exit","code"}` when the shell ends. Closes with 4404 for an unknown id |
| PUT | `/api/settings` | Partial update: `tariff_preset`, `tariff_rp_per_kwh`, `ppj_percent`, `overhead_watts`, `timezone`, `speedtest_interval_hours`, `watched_services` |

The terminal and `/api/passkeys` routes refuse requests whose `Origin` doesn't match `Host` (403). A sibling subdomain
counts as same-site, so its pages would otherwise get the session cookie.

Example:

```bash
curl -b 'lufria_monitor_session=<cookie from the browser>' localhost:8090/api/power/summary
```

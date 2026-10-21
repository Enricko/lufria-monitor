# Development

## Run it locally

Backend (FastAPI on :8090, auto-reload):

```bash
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --reload --port 8090
```

Frontend (Vite dev server with hot reload; `/api` and `/ws` are proxied to :8090, see `vite.config.ts`):

```bash
cd frontend
npm ci
npm run dev          # http://localhost:5173, also on the LAN (host: true)
```

Notes:
- **Sign-in in development.** With no `data/auth.json` the dashboard is open, which is the easiest way to work
  locally. To test passkeys, run the backend with `MONITOR_ORIGIN=http://localhost:5173` (WebAuthn allows
  `localhost` without HTTPS) and set a bootstrap password with `python -m app.auth set`.
- **Never point a dev instance at the production `data/`.** Run from a separate checkout: `data/` lives next to
  the code (`config.py`: `ROOT/data`), so every checkout has its own database and sign-in.
- Without the root helper (`/run/lufria-monitor/*.json`) the power figures fall back or show offline;
  everything else works. Run `sudo deploy/install.sh` on a dev box to get them.
- Terminal sessions belong to the uvicorn process: `--reload` restarts it and closes every shell.

## Build and deploy

```bash
cd frontend && npm run build      # tsc -b (type check) + vite build -> frontend/dist
```

The backend serves `frontend/dist` straight from disk, so a frontend-only change goes live with the build, no
restart (open pages pick it up on reload). Backend changes need `sudo systemctl restart lufria-monitor`, which
also **ends every terminal session**, including one you're typing in.

## Project layout

```
backend/app/
  main.py            FastAPI routes (REST + WebSockets), auth checks, serves the SPA
  auth.py            passkeys (WebAuthn), QR sign-in, enrolment, bootstrap password, session cookies, CLI
  terminal.py        PTY sessions, replay buffer, backpressure, /ws/terminal protocol
  sampler.py         1 s live sampler -> WebSocket + per-minute rows in SQLite
  energy.py          kWh / Rp buckets, projections, per-app scaling
  db.py              SQLite schema (self-migrating), settings
  config.py          paths, defaults, PLN tariff presets
  collectors/        system (psutil), power (helper JSON + models), gpu (sysfs/NVML), services, speedtest
deploy/
  bootstrap.sh       venv + frontend build (as your user)
  install.sh         root helper + systemd units (as root)
  lufria-monitor-helper.py   root-only readers (RAPL, WattSeal DB, smartctl) -> /run/lufria-monitor/*.json
  install-wattseal.sh, install-speedtest.sh, setup-nvidia.sh, check-gpu.sh
frontend/src/
  App.tsx            hash routing (#overview, #power, …), /approve/{id} and /enroll/{token} pages
  api.ts             fetch + WebSocket helpers; a 401 raises "auth-required" -> sign-in page
  components/Shell.tsx   sidebar / phone header, NAV list of pages
  components/ui.tsx      Card, Button, Kpi, Meter, Segmented, Skeleton, Empty, …
  components/TerminalView.tsx   one xterm.js session: reconnects, copy/paste, OSC 52, text size
  pages/*.tsx        one file per page; Terminal is lazy-loaded (xterm.js is large)
  index.css          design tokens (@theme), palette.ts = chart colors
tools/               stress-test.sh, gpu_burn.py
docs/                these guides + screenshots
```

## Conventions

- **Colors:** UI colors come from the tokens in `frontend/src/index.css` (`bg`, `surface`, `line`, `fg`,
  `muted`, `accent`, `good`, `warn`, `bad`). Chart colors come only from `frontend/src/palette.ts`, a validated
  palette in a fixed order. Don't add ad-hoc hex values.
- **Fonts:** Fira Sans (UI) and Fira Code (numbers, terminal), self-hosted through `@fontsource`.
- **Privileges:** the web app never runs as root. Anything that needs root (RAPL counters, SMART, WattSeal's
  database) goes in the root helper, which publishes JSON to `/run/lufria-monitor/`.
- **Don't wake the dGPU:** no `lspci`, and no NVML/`nvidia-smi` unless sysfs says the GPU is already awake. See
  [nvidia-gpu.md](nvidia-gpu.md).
- **Power totals:** WattSeal's own disk/network totals double-count; use the model in
  [power-model.md](power-model.md), never WattSeal's raw total.
- **Anything that runs commands** (terminal, passkey management) must keep the `Origin` == `Host` check
  (`auth.same_origin`).
- Python: standard library first, small modules, type hints on public functions. TypeScript: `strict`, no
  unused locals (`tsc -b` fails the build).

## Adding things

**A page:** add `pages/MyPage.tsx`, an entry in `NAV` (`components/Shell.tsx`, gives the `#id` route and the
sidebar link), and render it in `App.tsx`. Use `Card`/`PageHeader` from `components/ui.tsx`.

**A metric in the live stream:** collect it in `backend/app/collectors/`, add it to the snapshot in
`sampler.py`; it then appears in `/api/live` and `/ws/live`. If it needs history, add a column in `db.py`
(columns are added automatically on start) and to the per-minute row.

**A root-only reading:** add it to `deploy/lufria-monitor-helper.py`, write it into a JSON file under
`/run/lufria-monitor/`, read that file from a collector. Reinstall with `sudo deploy/install.sh`.

## Testing

There is no automated test suite yet. Before deploying:

1. `npm run build` (type check + build) and start the backend: both must come up clean.
2. Try the change in a browser on a desktop and a phone-width window, and check the console for errors.
3. For the terminal, check: typing, resize, reload (the shell and its output come back), copy/paste
   (see the table in [terminal.md](terminal.md)), and a full-screen app (`htop`).
4. For sign-in changes, use a separate checkout with its own `data/`, so you can't lock yourself out of
   the real dashboard. Chrome DevTools → **WebAuthn** can emulate a passkey authenticator.

To see every chart move under load: `tools/stress-test.sh 180` (needs `stress-ng`).

# Lufria Monitor

A self-hosted monitoring dashboard for a single Linux home server: live CPU, memory, GPU, temperatures,
fans, storage health, network and internet speed, service health, and **how much electricity the box
uses, in kWh and Indonesian Rupiah** (PLN tariffs), per hour, day, week and month, down to the app.

Built for an old gaming laptop turned server (ASUS ROG Strix, i7-9750H + GTX 1660 Ti), but nothing in it
is specific to that machine.

![Overview](docs/screenshots/desktop-overview.png)

| Power and cost | Graphics, thermals and fans |
|---|---|
| ![Power](docs/screenshots/desktop-power.png) | ![System](docs/screenshots/desktop-system.png) |
| **Terminal** | **Sign-in: passkey or QR** |
| ![Terminal](docs/screenshots/desktop-terminal.png) | ![Sign-in](docs/screenshots/login.png) |

### Claude Code

![Claude Code](docs/screenshots/desktop-claude.png)

| Folder and folder lock | Models: official and custom | Usage and cost history |
|---|---|---|
| ![Folder picker](docs/screenshots/desktop-claude-folder.png) | ![Model picker](docs/screenshots/desktop-claude-models.png) | ![Usage history](docs/screenshots/desktop-claude-usage.png) |

<img src="docs/screenshots/mobile-claude.png" alt="Claude Code on a phone" width="260">

Screenshots are generated from the real build with fake data by [tools/screenshots.mjs](tools/screenshots.mjs).

## Features

- **Live dashboard** over WebSocket, refreshed every second, with per-minute history kept for 400 days.
- **Power and cost**
  - Live watts split by component: CPU (measured with RAPL), RAM, storage, network, GPU and a configurable platform overhead.
  - kWh and Rupiah for this hour, today, this week and this month, plus hourly, daily, weekly and monthly charts and day/month/year projections.
  - PLN tariff presets (R-1 450 VA to R-3), a custom rate and PPJ tax.
  - **Per-app energy**, using [WattSeal](https://github.com/Daminoup88/WattSeal) as the power collector.
- **GPU**
  - NVIDIA dGPU power, load, VRAM, temperature, clocks and the processes using it, plus Intel iGPU busy % and clocks.
  - The monitor never wakes a sleeping dGPU. [Why that matters](docs/nvidia-gpu.md).
- **System:** per-core CPU, memory and swap, temperatures, fan RPM, ASUS power profile, top processes.
- **Storage:** filesystem usage and SMART health (wear, power-on hours, reallocated sectors) for every disk.
- **Network:** per-interface throughput and scheduled Ookla speed tests with history.
- **Services:** watched systemd units, Docker containers, and Cloudflare Tunnel routes with backend checks.
- **Terminal:** a login shell in the browser (xterm.js). [Details](docs/terminal.md).
  - Up to 8 tabs; sessions keep running across page reloads and dropped connections, and replay what you missed.
  - Copy and paste everywhere: Ctrl+C/Ctrl+V (⌘C/⌘V on a Mac), Copy/Paste buttons for phones, a selectable
    scrollback view, and OSC 52 so drag-to-copy works inside apps like Claude Code, tmux and vim.
  - Adjustable text size, and extra keys (Esc, Tab, Ctrl, arrows) for phone keyboards.
  - Paste or drop a screenshot or file: it is uploaded to the server and its path is typed into the shell.
  - It runs as the dashboard's user, so anyone who can sign in gets that user's shell.
- **Claude Code:** chat with the real Claude Code CLI on the server. [Details](docs/claude-code.md).
  - Its slash commands, skills and agents, `@` file mentions, `!` bash, `#` memory, plan mode with approval.
  - Official Claude or any custom provider, switchable mid-session; turns keep running when you leave the page.
  - Tokens (input, output, cache read and write) and cost under the message box.
  - The official Claude plan's 5-hour and weekly limits, live, before you send anything and whatever model you use.
  - Pick the folder it works in, and lock it so Claude can only change files there (sandboxed Bash).
- **Login:** passkeys only (Touch ID, Face ID, or any phone/security key), or a QR code on the login screen that
  you approve with a passkey on your phone. A password (PBKDF2) only bootstraps the first passkey and is refused
  after that. Signed session cookie, brute-force lockout and a one-time recovery link from the server's CLI.
  [Details](docs/authentication.md).
- **Responsive:** dark UI with phone and desktop layouts; on desktop the sidebar can be dragged wider or
  narrower, or folded to icons.

## How it fits together

```
wattseal.service (root, headless)
  WattSeal -> /opt/wattseal/power_monitoring.db  (per second: CPU/RAM/disk/net energy + per-app)
        |
lufria-monitor-helper.service (root)            lufria-monitor.service (your user, :8090)
  RAPL + WattSeal live  -> power.json  (1 s)  ->  FastAPI sampler (1 s) -> WebSocket /ws/live
  WattSeal per-app      -> apps.json   (2 min)    per-minute rows -> data/monitor.db (SQLite)
  smartctl              -> smart.json  (30 min)   REST /api/*, serves the React build
  /run/lufria-monitor/                            speed test scheduler, GPU reader (sysfs + nvidia-smi)
```

Root-only data (RAPL energy counters, SMART, WattSeal's database) is read by a small root helper and
published as world-readable JSON. The web app itself runs as an unprivileged user.

**Stack:**
- Backend: Python 3.12+ (FastAPI, psutil, SQLite).
- Frontend: React 19, Vite, TypeScript, Tailwind CSS 4, Recharts, xterm.js, Lucide icons, Fira Sans and Fira Code (self-hosted).

## Security

This dashboard can start a shell on the machine it runs on. Treat it like SSH access:

- Only expose it over HTTPS (for example through Cloudflare Tunnel) and add a passkey before you rely on it.
- The terminal and Claude Code run as the dashboard's user. If that user has passwordless `sudo`, anyone who
  can sign in has root. Remove that `sudo` rule if you don't need it.
- Don't put it on the open internet without the passkey step. The LAN address works only with the QR sign-in.

Report security problems privately through a GitHub security advisory rather than a public issue.

## Quick start

On Ubuntu 24.04 or newer:

```bash
sudo apt install python3-venv nodejs npm smartmontools
git clone https://github.com/Enricko/lufria-monitor.git ~/monitor && cd ~/monitor

deploy/bootstrap.sh                          # sets up .env, example data, backend venv + frontend build
(cd backend && .venv/bin/python -m app.auth set)   # bootstrap password, only until the first passkey
deploy/install-speedtest.sh                  # optional: Ookla CLI into ./bin
sudo deploy/install-wattseal.sh              # recommended: power collector (+ GTK3 runtime libs)
sudo deploy/install.sh                       # root helper + dashboard as systemd services
```

Then open `http://<server-ip>:8090` and sign in with the bootstrap password. Expose it over HTTPS, set
`MONITOR_ORIGIN` to your own domain (the default points to the author's), and add a passkey in
**Settings → Sign-in**: from then on the password is refused.
The full walkthrough is in [docs/setup.md](docs/setup.md). It covers Cloudflare Tunnel, passkeys, NVIDIA
laptops, updating, uninstalling and troubleshooting.

## Documentation

| | |
|---|---|
| [docs/setup.md](docs/setup.md) | Install, expose through Cloudflare Tunnel, add a passkey, update, uninstall, troubleshooting |
| [docs/configuration.md](docs/configuration.md) | Settings, environment variables, files, services, backups |
| [docs/authentication.md](docs/authentication.md) | Passkeys, QR sign-in, recovery, sessions, lockout, hardening |
| [docs/claude-code.md](docs/claude-code.md) | The Claude Code page: models and providers, commands, shortcuts, permission modes |
| [docs/terminal.md](docs/terminal.md) | The browser terminal: sessions, copy and paste, OSC 52, text size, security |
| [docs/power-model.md](docs/power-model.md) | How watts, kWh, Rupiah and per-app energy are computed |
| [docs/nvidia-gpu.md](docs/nvidia-gpu.md) | NVIDIA laptop GPUs: making them sleep at 0 W, and not waking them |
| [docs/api.md](docs/api.md) | REST and WebSocket API |
| [docs/development.md](docs/development.md) | Running locally, project layout, conventions, adding pages and metrics |

## Repository layout

```
backend/    FastAPI app (app/main.py), sign-in (auth.py), terminal (terminal.py), collectors, energy math
frontend/   React app (src/pages, src/components, palette.ts = validated chart colors)
deploy/     systemd units, root helper, installers (bootstrap, install, WattSeal, speedtest, NVIDIA)
tools/      stress-test.sh + gpu_burn.py (full-load test), screenshots.mjs (README screenshots, fake data)
docs/       guides and screenshots
```

## Credits

- [WattSeal](https://github.com/Daminoup88/WattSeal) (GPL-3.0) collects the power data. It is installed
  from its official release and is not bundled here. This project re-applies WattSeal's published
  disk, network and GPU power formulas and cites them in [docs/power-model.md](docs/power-model.md).
- [Ookla Speedtest CLI](https://www.speedtest.net/apps/cli) runs the internet speed tests. It is downloaded
  by `deploy/install-speedtest.sh` because Ookla's license does not allow redistributing it.

## Contributing

Issues and pull requests are welcome. Run the backend tests (`cd backend && .venv/bin/python -m unittest discover -s tests`)
and build the frontend (`cd frontend && npm run build`) before you open a PR. The project layout and conventions
are in [docs/development.md](docs/development.md).

## License

[MIT](LICENSE)

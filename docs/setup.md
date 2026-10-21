# Setup

Tested on Ubuntu 26.04 (kernel 7.0) on an ASUS ROG Strix G731GU laptop running as a headless server.
Any recent systemd distro should work with small changes to the `apt` lines.

## Requirements

| | |
|---|---|
| OS | Linux with systemd. Ubuntu/Debian commands are shown |
| Python | 3.12+ with `venv` |
| Node.js | 20+ with npm (only to build the frontend) |
| CPU power | A CPU that exposes `/sys/class/powercap/intel-rapl:*` (Intel, and recent AMD) |
| Optional | `smartmontools` (disk health), Docker (container list), cloudflared (tunnel routes), an NVIDIA GPU |

## 1. Get the code and build it

```bash
sudo apt install python3-venv nodejs npm smartmontools
git clone https://github.com/Enricko/lufria-monitor.git ~/monitor
cd ~/monitor
deploy/bootstrap.sh
```

`bootstrap.sh` does two things:
- Creates `backend/.venv` and installs `backend/requirements.txt`.
- Runs `npm ci && npm run build` in `frontend/`. The backend serves `frontend/dist`.

## 2. Set the bootstrap password

```bash
cd ~/monitor/backend
.venv/bin/python -m app.auth set
```

This password only exists to add your first passkey (step 6). After that, password sign-in is refused.
Only a salted PBKDF2-SHA256 hash and a random session-signing key are stored, in `data/auth.json` (mode 600).
To reuse a password that already lives in an env file, pipe it in so it never shows on screen:

```bash
sudo sed -n 's/^SOME_PASSWORD=//p' /path/to/app.env | .venv/bin/python -m app.auth set --stdin
```

If `data/auth.json` doesn't exist, the dashboard is **open to anyone who can reach it**.

## 3. Optional extras

```bash
deploy/install-speedtest.sh          # Ookla Speedtest CLI -> ./bin/speedtest
sudo deploy/install-wattseal.sh      # WattSeal power collector (recommended)
sudo deploy/setup-nvidia.sh          # NVIDIA Turing+ laptop GPU: driver that powers off when idle
```

- **WattSeal**
  - Installs the pinned v1.0.6 release (SHA-256 checked) to `/opt/wattseal` as `wattseal.service`.
  - Its Linux build links GTK3 even in `--headless` mode, so the script installs `libgtk-3-0t64` (no desktop, about 20 small packages).
  - Without WattSeal, power still works from the helper's own RAPL reading. You lose the per-app breakdown.
- **NVIDIA:** read [nvidia-gpu.md](nvidia-gpu.md) first. It switches to the closed kernel module and needs a module reload or a reboot.

## 4. Install the services

```bash
sudo deploy/install.sh
# or: sudo PORT=9000 HOST=127.0.0.1 APP_USER=alice deploy/install.sh
```

This installs and starts:

| Unit | Runs as | What |
|---|---|---|
| `lufria-monitor-helper.service` | root | Reads RAPL, SMART and WattSeal, and writes JSON to `/run/lufria-monitor/` |
| `lufria-monitor.service` | `APP_USER` (default: whoever ran sudo) | The dashboard on `HOST:PORT` (default `0.0.0.0:8090`) |

The dashboard unit is generated from `deploy/lufria-monitor.service.in`. If a `docker` group exists, the
dashboard gets it as a supplementary group so it can list containers. **Membership in the docker group is
root-equivalent.** Remove that line from the generated unit if you'd rather not see containers.

Open `http://<server-ip>:8090`, sign in with the bootstrap password, then go to **Settings** and set:
- **Tariff group:** your PLN power class (VA), or Custom with your own Rp/kWh.
- **PPJ %:** the street-lighting tax shown on your bill or token receipt.
- **Platform overhead:** whatever no sensor measures, such as motherboard, fans, Wi-Fi and charger loss. The default is 8 W. A plug-in power meter tells you the real number.

## 5. Expose it on the internet (Cloudflare Tunnel)

Add an ingress rule **above** the catch-all `http_status:404` in `/etc/cloudflared/config.yml`:

```yaml
ingress:
  - hostname: monitor.example.com
    service: http://localhost:8090
  - service: http_status:404
```

Then do three things:
- Restart the tunnel with `sudo systemctl restart cloudflared`.
- Create the DNS route: a `CNAME monitor -> <tunnel-id>.cfargotunnel.com`, proxied, or the tunnel's
  **Public Hostname** page in Cloudflare Zero Trust.
- Tell the dashboard its public origin, which passkeys are bound to:
  ```bash
  sudo systemctl edit lufria-monitor      # add: [Service]  Environment=MONITOR_ORIGIN=https://monitor.example.com
  sudo systemctl restart lufria-monitor
  ```

Login cookies are marked `Secure` automatically behind HTTPS, and failed logins are rate-limited per
`CF-Connecting-IP`. For a second lock, put a Cloudflare Access policy in front.

The Services page reads the same `config.yml` to list the routes and check that each backend port answers.

## 6. Add a passkey (and turn the password off)

On the public HTTPS address, go to **Settings → Sign-in → Add passkey** and confirm with Touch ID, Face ID,
Windows Hello or your phone. The first passkey turns password sign-in off and signs out every other browser.
Add a second passkey on another device, and prefer synced ones (iCloud Keychain, Google Password Manager).

From then on, sign in with the passkey, or scan the QR code on the sign-in page with your phone (that also
works on the LAN address, where browsers don't allow passkeys). If every device is lost:
`cd backend && .venv/bin/python -m app.auth enroll` prints a one-time recovery link.
Details in [authentication.md](authentication.md).

## Updating

```bash
cd ~/monitor && git pull
deploy/bootstrap.sh
sudo deploy/install.sh
```

The SQLite schema migrates itself. New columns are added on start.

## Uninstall

```bash
sudo systemctl disable --now lufria-monitor lufria-monitor-helper wattseal
sudo rm /etc/systemd/system/{lufria-monitor,lufria-monitor-helper,wattseal}.service
sudo rm -rf /opt/lufria-monitor /opt/wattseal
sudo systemctl daemon-reload
rm -rf ~/monitor        # includes data/monitor.db (your history) and data/auth.json
```

## Stress test

To watch every chart move:

```bash
sudo apt install stress-ng
tools/stress-test.sh 180          # CPU (all threads) + 70% of free RAM + disk I/O (+ GPU if pyopencl is installed)
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Dashboard not running after a reboot; `journalctl -b` says `Found ordering cycle ... multi-user.target` | A unit has `After=multi-user.target` while being `WantedBy` it. The shipped units use `After=local-fs.target`. Reinstall with `sudo deploy/install.sh` |
| Power page says "WattSeal offline · RAPL only" | `systemctl status wattseal`. Its log is `/opt/wattseal/*.log` |
| Per-app numbers look too high | They are scaled to the corrected total. See [power-model.md](power-model.md#per-app-energy) |
| NVIDIA GPU never sleeps (`/proc/driver/nvidia/gpus/*/power` says *Not supported*) | See [nvidia-gpu.md](nvidia-gpu.md). On Turing it is the GSP firmware |
| dGPU wakes every time a page loads | Something runs `lspci` or `nvidia-smi` on it. The monitor avoids both while it sleeps. Check your own cron jobs and scripts |
| "Docker is not accessible" | The dashboard user isn't in the `docker` group (see step 4) |
| SMART shows "No SMART" for a USB stick | Many USB bridges don't pass SMART through. That's expected |
| Speed test fails | Run `bin/speedtest --accept-license --accept-gdpr` once by hand to see the error |
| "Sign in with passkey" fails or no passkey is offered | You're not on `MONITOR_ORIGIN` (passkeys are tied to that hostname), or on plain http. Use the QR code, or set `MONITOR_ORIGIN` (step 5) |
| Locked out after a few tries (HTTP 429) | 5 failed attempts in 5 minutes from one IP. Wait 5 minutes |
| Lost every passkey | `cd backend && .venv/bin/python -m app.auth enroll` on the server: one-time link, 15 minutes |
| Terminal: every shell is gone | The dashboard service restarted. See [terminal.md](terminal.md) |
| Terminal: can't copy in Claude Code, tmux or vim | Those apps take the mouse. See [terminal.md](terminal.md#apps-that-grab-the-mouse-claude-code-tmux-vim) |

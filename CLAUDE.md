# Lufria Monitor

Self-hosted monitoring dashboard for this server (ASUS ROG Strix G731GU, Ubuntu 26.04).
This project is independent of the migration notes in ~/CLAUDE.md.

## Layout
- `backend/` FastAPI (Python 3.14, venv at `backend/.venv`). Entry: `app.main:app`, port 8090.
- `frontend/` React + Vite + TypeScript + Tailwind + Recharts. `npm run build` -> `frontend/dist`, served by the backend.
- `deploy/` systemd units + root helper (reads RAPL, WattSeal DB & SMART, writes JSON to /run/lufria-monitor/).
- WattSeal v1.0.6 runs headless as `wattseal.service` from /opt/wattseal (DB next to the binary).
- `data/monitor.db` SQLite: per-minute samples, speedtests, settings.

## Notes
- RAPL (`/sys/class/powercap/*/energy_uj`) and smartctl need root -> done by `lufria-monitor-helper.service`, never run the web app as root.
- Total watts = WattSeal CPU (RAPL) + RAM model + disk/NIC model on *physical devices only* + `overhead_watts`.
  WattSeal's own disk/net totals double-count mounts & virtual NICs; never use its raw total directly.
- Never open WattSeal's WAL DB from the web app (different user) - go through the root helper.
- GPU: GTX 1660 Ti on NVIDIA 595 **closed** headless module (Canonical-signed, Secure Boot on) with
  NVreg_EnableGpuFirmware=0 + NVreg_DynamicPowerManagement=0x02 (/etc/modprobe.d/nvidia-runtime-pm.conf, see
  deploy/setup-nvidia.sh). The open module forces GSP firmware -> "Runtime D3: Not supported" -> ~7 W idle forever;
  closed without GSP -> "Enabled (fine-grained)", D3cold ~13 s after the last GPU work. Check: deploy/check-gpu.sh
- Never wake the sleeping dGPU from the monitor: no lspci (PCI config reads resume it; use sysfs IDs + pci.ids),
  no NVML/nvidia-smi unless sysfs runtime_status is already active (`collectors/gpu.py`, with a 30 s idle backoff),
  and wattseal.service keeps PrivateDevices=yes. nvidia-powerd stays disabled (Dynamic Boost is Ampere+ only).
- UI: tokens in `frontend/src/index.css`, chart colors only from `frontend/src/palette.ts` (validated, fixed order).
- Energy buckets (hour/day/week/month) are computed in the configured timezone (default Asia/Jakarta).
- Tariff presets = PLN residential Rp/kWh; editable in Settings.
- Terminal (`backend/app/terminal.py`, `/ws/terminal/{id}`): login shells on PTYs as the service user, held in the
  uvicorn process with a 512 KB replay buffer. They live in lufria-monitor.service's cgroup, so restarting the
  service ends every shell (including one running the restart). The user has passwordless sudo here, so a
  dashboard login is a root shell. Terminal routes must keep the `auth.same_origin` check: sibling
  *.lufria.tech sites are same-site and would otherwise ride the session cookie.
- Sign-in (`backend/app/auth.py`): passkeys (WebAuthn via `webauthn`, rp id from `MONITOR_ORIGIN`, default
  https://monitor.lufria.tech) or a QR code (`/approve/{id}`) a phone approves with its passkey. The password is
  bootstrap only: refused once `data/auth.json` has a passkey, and the first passkey rotates the session secret.
  Passkeys can't work on the LAN IP over http (not a secure context): sign in there with the QR code.
  Recovery when every device is lost: `cd backend && .venv/bin/python -m app.auth enroll` (one-time link, 15 min).
  Challenges and QR requests live in the uvicorn process memory, so a restart cancels pending ones.
- File viewer (`frontend/src/claude/FileViewer.tsx`, `/api/claude/dir|file|file/raw|file/stat`): reads anything the
  service user can read (no root allowlist; a login is already a root shell). Routes check Origin *and* Sec-Fetch-Site
  (`<img>` sends no Origin). Non-regular files are refused before open; PCI config/rom/resource is refused (wakes the dGPU).
  `raw` serves images/video/audio inline (Range via FileResponse) and anything with `download=1` (octet-stream).
- Attachments: every turn gets `SYSTEM_APPEND` (`claude_chat.py`, `--append-system-prompt`): give file paths in inline
  code, never scp. The CLI records the system prompt on a conversation's first request and replays it on resume
  (`--system-prompt-snapshot`, on by default), so the appended text must be identical for every model/combo: a
  changed text only reaches new (or compacted) conversations. Replies' inline-code paths open the viewer (`claude/paths.ts`); deliverable ones (media, docs,
  archives) that exist show under the message (`claude/Attachments.tsx`).
- Claude Code's dialogs (tool permission, AskUserQuestion, plan approval): turns run with `--permission-prompt-tool stdio`;
  the CLI's `can_use_tool` control requests become `prompt` events (`Run.control`), drawn by `claude/PromptCard.tsx`, and
  the page's pick goes back on stdin (`Run.answer`) within the same turn. `_permission_result` keeps the tool input the
  CLI's own and grants only the CLI's `permission_suggestions` (or a session mode from ExitPlanMode): keep it that way.
  Open prompts live in the uvicorn process (`Run.prompts`), so a restart cancels them along with the turn.

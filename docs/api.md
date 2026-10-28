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
| POST | `/api/terminal/upload?name=<file name>` | Body: the raw file bytes, streamed to `data/uploads/<date>-<time>-<random>-<name>` (name cut down to letters, digits, `.`, `_`, `-`; a PNG, JPEG, GIF or WebP image gets the extension of its content). Returns `{path}` for the page to paste into a shell. 413 over 100 MB. Uploads older than 7 days are deleted on the way |
| WS | `/ws/terminal/{id}?since=N` | Binary frames are terminal bytes both ways. Client text frame: `{"type":"resize","cols","rows"}`. Server text frames: `{"type":"attach","offset","reset"}` first (output resumes at byte `offset`; `reset` means clear the screen, the buffer no longer reaches `since`), then `{"type":"exit","code"}` when the shell ends. Closes with 4404 for an unknown id |
| PUT | `/api/settings` | Partial update: `tariff_preset`, `tariff_rp_per_kwh`, `ppj_percent`, `overhead_watts`, `timezone`, `speedtest_interval_hours`, `watched_services` |

## Claude Code

The [Claude Code page](claude-code.md). Session ids are the CLI's UUIDs; transcripts are the CLI's own
files under `~/.claude/projects/`.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/claude/sessions` | `[{id, title, model, provider, provider_id, cwd, locked, created_at, updated_at, message_count, size_bytes, project, running}]`, newest 50 across every folder. `running` is true while a turn is in progress |
| GET | `/api/claude/sessions/{id}` | `{id, title, messages, usage, model, provider, provider_id, cwd, locked}`. `messages` are `{role, model, parts}`; a part is `text`, `thinking`, `tool` (with its `output`), `command`, `command_output`, `bash`, `image` or `notice`. `usage`: `{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, total_cost_usd, estimated, unpriced, context_tokens, models: [{model, …tokens, cost_usd, estimated}]}` |
| DELETE | `/api/claude/sessions/{id}` | Deletes the transcript |
| GET | `/api/claude/usage` | Tokens and cost for today, this week, this month and all time, plus history |
| GET | `/api/claude/limits?refresh=` | The official Claude login's plan limits, whatever model a chat uses (Claude Code's `get_usage` control request, no model call): `{available, subscription, windows: [{key, label, percent, resets_at, severity, active}], fetched_at, source, error}`. `percent` is 0-100 and can pass 100, `resets_at` and `fetched_at` are unix seconds, `severity` is the server's `normal`/`warning`/`critical`, `available` is false for an API-key login. One answer is shared for 30 s, `refresh=1` asks again after 10 s; if Claude Code can't answer, the last reading comes back with `error` set |
| GET | `/api/claude/capabilities?cwd=&refresh=` | What the installed CLI reports in that folder (default home): `{version, commands: [{name, description, argument_hint, aliases, builtin}], agents, models: [{value, display_name, description, effort_levels}], output_style, account, cwd, home, memory, sandbox: {available, missing}}`. Cached 10 min per folder; 503 if the CLI can't be asked |
| GET | `/api/claude/folders?path=` | Folder picker: `{path, parent, home, writable, dirs: [{name, path}], truncated}` (sub-folders, hidden ones left out, up to 500). 400 for a path that isn't a readable folder |
| GET | `/api/claude/files?q=&cwd=` | Up to 40 `{path, dir}` in the folder for `@` mentions; a `q` with `/` lists that folder |
| GET | `/api/claude/memory?cwd=` | `[{scope, path, exists, content}]` for `project` (`CLAUDE.md` in the folder) and `user` (`~/.claude/CLAUDE.md`) |
| POST | `/api/claude/memory` | Body `{scope, text, cwd}`. Appends `- text` (1 to 2000 characters) |
| PUT | `/api/claude/memory/{scope}?cwd=` | Body `{content}`. Replaces the file (512 KB max) |

### `WS /ws/claude`

JSON text frames. One socket follows one session at a time.

Client:

| Message | Does |
|---|---|
| `{"type":"resume","session_id"}` | Follow a session (`null` for a new one) |
| `{"type":"user","client_id","text","images","model","provider_id","permission_mode","effort","cwd","locked"}` | Start a turn. `images`: `[{data, mime}]` base64. `model`/`provider_id` apply from this turn (`provider_id: null` = official Claude). `permission_mode`: `bypassPermissions`, `acceptEdits` or `plan`. `effort`: `low` to `max`, or left out. `cwd`: folder of a new chat (default home); a session keeps its own and refuses another. `locked: true` keeps the turn's writes inside the folder |
| `{"type":"bash","client_id","command","cwd"}` | Run a command in the chat's folder (5 min limit) |
| `{"type":"interrupt"}` | Stop the running turn or command |

Server:

| Message | Means |
|---|---|
| `history` | Reply to `resume`: the session as in `GET /api/claude/sessions/{id}`, cut where a running turn's replay starts |
| `attached` | `{session_id, running}`. Sent after `history` and the replay of a running turn |
| `session` | `{session_id}`: the CLI assigned or confirmed the id |
| `turn_start` | `{client_id, text, model, provider, provider_id, permission_mode, effort, cwd, locked}` |
| `status` | `{state: thinking\|idle\|error, msg}` |
| `system`, `assistant`, `user`, `stream_event`, `result` | The CLI's own stream-json lines, passed through |
| `tool_start`, `tool_done` | A tool call (`part`) started; `{id, output, is_error}` when its result came back |
| `turn_usage` | One turn's usage, same shape as the session's `usage` plus `model` |
| `plan_limits` | Sent during an official turn when its response headers move the 5-hour or weekly window: same shape as `GET /api/claude/limits`, with `source: "turn"` |
| `bash_start`, `bash_result` | `{client_id, command}`, then `{stdout, stderr, code}` |

A turn belongs to the server: when the socket closes it keeps running, and a later `resume` replays it.
A `user` message for a session that is still working gets `status: error`.

The terminal, `/api/passkeys`, `/api/claude/*` (except sessions and usage) and `/ws/claude` routes refuse requests
whose `Origin` doesn't match `Host` (403; `/ws/claude` closes with 4403). A sibling subdomain counts as same-site,
so its pages would otherwise get the session cookie.

Example:

```bash
curl -b 'lufria_monitor_session=<cookie from the browser>' localhost:8090/api/power/summary
```

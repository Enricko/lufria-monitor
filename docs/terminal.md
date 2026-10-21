# Terminal

The **Terminal** page is a login shell in the browser, built on [xterm.js](https://xtermjs.org/). Use it to
run commands on the server without SSH, from a desktop browser or a phone.

![Terminal](screenshots/desktop-terminal.png)

## What you get

- **Login shell** for the user the dashboard runs as (their shell from `/etc/passwd`, started with `-l` in
  their home directory), on its own PTY with `TERM=xterm-256color` and truecolor.
- **Tabs:** up to 8 shells at once. The tab title follows the shell's window title.
- **Sessions survive the page.** Shells live in the dashboard process, not in the browser. Reloading, closing
  the tab, switching pages or losing the connection detaches; coming back reattaches to the same shell and
  replays the output you missed (the last 512 KB per shell).
- **Phone keys:** a key bar with Esc, Tab, a sticky Ctrl, arrows, ^C and `| ~ / -`, which phone keyboards lack.
- **Copy and paste** with the keyboard, the mouse, the toolbar buttons and in apps that grab the mouse, like
  Claude Code, tmux or vim (see below).
- **Text size:** A↓ / A↑ in the toolbar.

A shell ends when you close its tab, type `exit`, or when `lufria-monitor.service` restarts. The shells run
inside that service's cgroup, so **restarting the service kills every shell**, including the one you ran the
restart from. Use `tmux` or `nohup` for jobs that must outlive a restart.

## Copy and paste

| | Windows / Linux | macOS |
|---|---|---|
| Copy the selection | **Ctrl+C** (with text selected), Ctrl+Shift+C, right-click → Copy | **⌘C** |
| Interrupt (^C) | Ctrl+C with nothing selected | Ctrl+C |
| Paste | **Ctrl+V**, Ctrl+Shift+V, Shift+Insert, right-click → Paste | **⌘V** |
| Select in an app that uses the mouse | **Shift**+drag | **Option**+drag |

- After Ctrl+C copies, the selection is cleared, so the next Ctrl+C interrupts again.
- On Windows and Linux, Ctrl+V pastes instead of sending ^V (bash's "insert next key literally").
  On macOS, Ctrl keeps its terminal meaning.

### Toolbar buttons (phones and desktop)

| Button | What it does |
|---|---|
| **Copy** | With a selection: copies it. Without one: opens the scrollback as plain text, where you can select with the mouse or long-press on a phone, then **Copy selection** or **Copy all**. Lines the terminal wrapped are joined back together. Esc closes it. |
| **Paste** | Reads the clipboard and pastes it into the shell. If the browser refuses (no permission, or plain-http access), a **Paste here** box opens: paste into it with the system menu, then **Send**. Ctrl/⌘+Enter also sends. |
| **A↓ / A↑** | Text size from 8 to 28 px (default 14, or 12 on phones). Applies to every tab and to the Copy view, and is remembered per browser (`localStorage["terminal.fontSize"]`). The shell is resized to fit. |

### Apps that grab the mouse (Claude Code, tmux, vim)

Full-screen apps that turn on mouse tracking receive your clicks and drags themselves, so a plain drag doesn't
make a browser selection. Many of them, Claude Code included, select the text themselves and then ask the
terminal to copy it with an **OSC 52** escape sequence (`ESC ] 52 ; c ; <base64> BEL`). The dashboard handles it:

1. You drag across text in the app and release the mouse.
2. The app sends OSC 52; the dashboard decodes it and writes it to your clipboard. A **Copied** notice shows.
3. If the browser refuses the write, the notice says **Press ⌘C (Ctrl+Shift+C) or click here to copy**. Do
   either within a minute. Safari does this: it only allows clipboard writes during a click or key press, and
   the copy arrives a moment after you release the mouse.

Two safety rules apply:
- OSC 52 is honored only within 3 seconds of a click or key press in the terminal. Output replayed after a
  reload contains old OSC 52 sequences; this keeps them from overwriting your clipboard.
- Requests to **read** the clipboard (`ESC ] 52 ; c ; ?`) are ignored. Programs on the server never see your clipboard.

To select with the browser instead, hold **Shift** (Windows/Linux) or **Option** (macOS) while dragging.

### Plain-http access

The browser Clipboard API only exists on HTTPS (and `localhost`). On `http://<server-ip>:8090`:
- Copying still works (it falls back to `document.execCommand("copy")`).
- Ctrl/⌘+V still works (it's the browser's own paste).
- The **Paste** button opens the **Paste here** box instead of reading the clipboard directly.

## Security

- The shell runs as the dashboard's user, **never root**. But if that user has passwordless `sudo`, a
  dashboard login is a root shell. Protect sign-in accordingly (see [authentication.md](authentication.md)).
- The terminal routes check that `Origin` matches `Host`. Sibling subdomains (`*.example.com`) are
  *same-site*, so the browser would send them the session cookie. Without this check, a page on one of them
  could open a shell.
- The shell's environment is rebuilt from scratch (`HOME`, `USER`, `SHELL`, `PATH`, `LANG`, `TERM`,
  `XDG_RUNTIME_DIR`). systemd variables like `INVOCATION_ID` don't leak in; the login shell sources the rest.

## How it works

```
browser (xterm.js)  <-- WebSocket /ws/terminal/{id}?since=N -->  uvicorn (backend/app/terminal.py)
  bytes typed       ---------------- binary frames ------------->  PTY master  ->  bash -l
  screen output     <--------------- binary frames --------------  512 KB ring buffer + live output
  {"type":"resize"} ---------------- text frame ---------------->  TIOCSWINSZ
                    <-- {"type":"attach","offset","reset"} ------  sent first on every connect
                    <-- {"type":"exit","code"} ------------------  when the shell ends
```

- Each browser tab counts the output bytes it has received and reconnects with `?since=<count>`, so it only
  gets what it missed. If the buffer no longer reaches back that far, the server says `reset` and replays the
  whole buffer.
- Several browsers can watch the same shell at once. If one of them falls more than 1 MB behind, the server
  stops reading the PTY (backpressure) until every client is under 256 KB.
- On a dropped connection the page retries with backoff (1 s, doubling, up to 10 s), checking first that the
  shell still exists. An expired login sends you to the sign-in page.

The full wire format and the REST routes are in [api.md](api.md).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Dragging in Claude Code / tmux / vim selects nothing in the browser | The app has the mouse. Release the mouse to let the app copy (OSC 52), or Shift/Option+drag to select with the browser |
| "Press ⌘C or click here to copy" after selecting | The browser refused a clipboard write outside a click or key press (Safari). Press ⌘C or click the notice |
| Paste button opens a box instead of pasting | No clipboard permission, or plain-http access. Paste into the box and press Send |
| Ctrl+C copies instead of stopping a program | Text is selected. Press Ctrl+C again, or click once to clear the selection |
| Every shell vanished | `lufria-monitor.service` restarted (an update, a crash, or `systemctl restart`) |
| "At most 8 terminals" | Close a tab, or `exit` a shell you don't need |
| Garbled lines near the top after a reload | Output written at a different terminal width is replayed at the current width. `clear` or Ctrl+L redraws |

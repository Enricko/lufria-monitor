# Claude Code

The **Claude Code** page is a chat front end for the real Claude Code CLI on this server. Every message
runs `claude --print` with the stream-json protocol in the chat's folder (your home unless you pick
another), as the dashboard's user, so it gets the same tools, `CLAUDE.md` memory, skills, agents, MCP
servers and session files as `claude` in the terminal. Sessions show up in both places: `claude --resume`
in that folder can pick up a conversation started on the page, and the sidebar lists the sessions of
every folder, including ones started in a terminal.

## Models: official and custom in one session

The model picker has two groups:

- **Claude · official** uses the CLI's own login (subscription or API key). The list comes from the
  installed CLI, so new models appear without a dashboard update.
- **Custom providers** (Settings → Providers) run the same CLI with `ANTHROPIC_BASE_URL` and the
  provider's key pointed at an Anthropic-compatible endpoint.

The choice applies from the next message, and a session can switch as often as you like: ask Claude, try
the same thread on a router model, come back to Claude. A divider marks each switch and every reply
shows which model wrote it. The CLI removes the previous model's thinking signatures before it sends the
history to a different provider, so switching back doesn't fail on them.

## Composer

Typing anywhere on the page goes into the message box, no click needed (so does Ctrl/⌘+V). On a
computer the box also has the caret whenever you open the page or a conversation.

| Key | Does |
|---|---|
| `/` | Commands and skills. `Tab` completes, `Enter` runs |
| `@` | Mention a file or folder (`@path`, searched in the chat's folder) or an agent (`@agent-name`) |
| `!` | Bash mode: runs the command in the chat's folder; its output goes into your next message |
| `#` | Adds a line to memory: pick project (`CLAUDE.md` in the chat's folder) or user (`~/.claude/CLAUDE.md`) |
| `Shift+Tab` | Cycles the permission mode: bypass → accept edits → plan |
| `Esc` | Stops the running turn (the CLI gets an interrupt, then SIGINT, then SIGKILL) |
| `↑` / `↓` | Previous prompts |

Paste or attach images. While a turn runs you can type the next message: it waits as **Queued** (edit or
remove it) and goes out when the turn ends.

## Tokens and cost

The line under the message box adds up the conversation:

- **context**: tokens the model read on its latest call, i.e. how full the context window is.
- **in** / **out**: uncached input and output tokens.
- **cache read** / **cache write**: input served from, and written to, the prompt cache (about 10% and 125%
  of the input price).
- **cost**: official Claude models use Claude Code's own price for each model. Custom models are priced
  from the table in `backend/app/pricing.py` (marked `≈ … est.`), because Claude Code only guesses for
  models it doesn't know. With a Claude subscription the figure is what the API would charge, not a bill.

Click it for the split per model. The numbers come from the CLI's running totals in the transcript
(`cost-state`), so they include subagents. Each reply also shows its own tokens and cost underneath.

## Plan limits

The sidebar's **Plan limits** panel shows the official Claude login's 5-hour and weekly windows (and any
per-model weekly window your plan has): how much is used and when each resets. It's there as soon as the
page opens, without sending a message. It always shows the official account, even while the chat uses a
custom model. Close the sidebar and the same numbers sit in the toolbar (`5h 73% · wk 38%`).

The numbers come from Claude Code itself (its `get_usage` control request, the data behind `/usage`, with
no model call). The page reads them when it opens, every minute while it is visible, and when you come
back to the tab; the server asks Claude Code at most every 30 seconds and shares the answer between tabs.
During an official turn they move live, from the rate-limit headers of Claude's own responses. Click the
refresh icon to ask again now. With an API-key login there are no plan limits and the panel says so.

## Folder and folder lock

The folder chip below the message box shows where the chat works. Pick another one there (browse, type a
path, or choose a recent folder). A conversation stays in its folder, because `--resume` only finds a
session in the folder it started in: picking a different folder starts a new chat.

**Lock** (the padlock next to the folder) keeps Claude from changing anything outside that folder:

- **Bash** runs inside Claude Code's own sandbox (bubblewrap). It can write only in the folder, can't
  `sudo`, and doesn't see the Docker socket or the systemd user bus. Reading files and the internet still
  work. A command can't ask to leave the sandbox.
- **Edit, Write, MultiEdit and NotebookEdit** go through a hook (`backend/app/folder_guard.py`) that refuses
  any path resolving outside the folder, symlinks included. Claude Code's plan files and the folder's
  auto-memory stay writable.

The lock applies from the next message and can be switched per message. It needs `bubblewrap` and `socat`
(`sudo apt install bubblewrap socat`). Ubuntu's AppArmor rule against nested user namespaces stops the
sandbox's seccomp helper from starting, so the lock runs without it and instead hides the Docker socket
and the user bus, the two ways a command could act outside the folder through a unix socket. It guards
against mistakes, not against a determined attacker: MCP servers, hooks and your own `!` commands run
outside the sandbox, and the sandbox still has the network.

## Commands

`/` lists everything the installed CLI reports through its `initialize` control request: built-in
commands such as `/compact`, `/context`, `/cost`, `/review` and `/init`, plus your skills, plugin
commands and `~/.claude/commands`. They run in the CLI, so their output is the CLI's own.

A few run in the page instead, because in `--print` mode they would change a global default or need
the terminal UI:

| Command | Does |
|---|---|
| `/model [model]` | Model and provider for the next message (the CLI's `/model` would save a new global default) |
| `/effort [auto\|low\|medium\|high\|xhigh\|max]` | Reasoning effort |
| `/plan [task]` | Plan mode: read-only exploration, then a plan card with **Approve plan and run** |
| `/permissions [bypass\|edits\|plan]` | Permission mode (alias `/mode`) |
| `/clear` | New conversation; the old one stays in the sidebar (aliases `/reset`, `/new`) |
| `/resume` | Focuses the session search |
| `/memory` | Edit both `CLAUDE.md` files |
| `/status` | Session, model, provider, folder and lock, mode, account, MCP servers and usage |
| `/export` | Downloads the conversation as Markdown |
| `/help` | Shortcuts and every command, with descriptions |

Commands that only make sense in the TUI (`/color`, `/focus`, `/doctor`, `/heapdump` and similar) are
left out of the list.

## Permission modes

There is no one at the CLI to answer a permission prompt, so the page picks a mode per message instead:

- **Bypass** (default): tools run without asking, like `--dangerously-skip-permissions`.
- **Accept edits**: file edits go through, other tools that would ask are denied and shown as a notice.
- **Plan**: read-only. Claude ends with a plan; **Approve plan and run** switches back to the mode you had
  before (bypass if that was plan too) and tells Claude to go ahead.

## Turns keep running

A turn belongs to the server, not the browser tab. Close the tab, switch sessions or lose the connection
and it carries on; open the session again and the page shows the transcript plus everything the turn
streamed since, then follows it live. Sessions with a turn in progress have a dot in the sidebar.

Turns run inside `lufria-monitor.service`, so restarting the service stops them (and every terminal
shell). The transcript keeps everything up to that point.

## Security

Anyone who can sign in to the dashboard can make Claude run any command as the dashboard's user, who has
passwordless sudo here. Treat a dashboard login like a root shell, as with the [terminal](terminal.md).

The WebSocket and the memory, file-search and limits routes check `Origin` against `Host`, so a sibling
`*.lufria.tech` page can't use your session cookie for them. Model output is escaped before the page
renders its Markdown, and links only open for `http(s)` URLs.

## How it works

- `backend/app/claude_chat.py`: the WebSocket, one CLI process per turn (`--resume <session>`, started in
  the session's folder), a registry of running turns with a replay buffer, interrupt, `!` commands, the
  capabilities probe (`initialize`, cached 10 minutes per folder) and the plan limits (`get_usage`, 30 s).
- `backend/app/claude_transcript.py`: turns the CLI's JSONL transcripts in `~/.claude/projects/` into
  messages (text, thinking, tool calls with their results, commands and their output, bash, notices) and
  usage with a price per model.
- `backend/app/claude_workspace.py`: folders and the folder lock's `--settings` (sandbox + hook),
  `CLAUDE.md` memory, `@` file search, `!` bash.
- `backend/app/folder_guard.py`: the lock's PreToolUse hook. `backend/app/pricing.py`: prices for custom
  models.
- `frontend/src/pages/Claude.tsx` and `frontend/src/claude/`: the page.

The protocol is in [api.md](api.md#claude-code).

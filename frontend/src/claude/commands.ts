// Slash commands: the CLI's own list (from /api/claude/capabilities) plus the few the page
// runs itself, because in --print mode they would change global settings or need the TUI.
import type { Capabilities, CliCommand } from "./types";

export interface PaletteItem {
  key: string;
  /** Text placed in the composer when completed. */
  insert: string;
  label: string;
  hint?: string;
  description: string;
  badge: string;
  kind: "page" | "cli" | "skill" | "file" | "dir" | "agent";
  needsArgs?: boolean;
}

export interface PageCommand { name: string; aliases?: string[]; hint?: string; description: string }

export const PAGE_COMMANDS: PageCommand[] = [
  { name: "model", hint: "[model]", description: "Choose the model and provider for the next message; official and custom models can share a session" },
  { name: "effort", hint: "[auto|low|medium|high|xhigh|max]", description: "Set reasoning effort for the next messages" },
  { name: "plan", hint: "[task]", description: "Plan mode: read-only exploration, then a plan for you to approve" },
  { name: "permissions", aliases: ["mode"], hint: "[ask|edits|plan|bypass]", description: "Switch permission mode (also Shift+Tab)" },
  { name: "clear", aliases: ["reset", "new"], description: "Start a new conversation; this one stays in the sidebar" },
  { name: "resume", description: "Open the session list to continue another conversation" },
  { name: "memory", description: "Edit CLAUDE.md memory files (# note adds a line)" },
  { name: "files", hint: "[path]", description: "Browse and preview files on the server (this chat's folder by default)" },
  { name: "status", description: "Session, model, provider, permission mode, account and MCP servers" },
  { name: "export", description: "Download this conversation as Markdown" },
  { name: "help", description: "Commands and shortcuts" },
];

// CLI commands the page replaces, or that only make sense in the terminal UI or a live process.
const HIDDEN = new Set(["model", "effort", "clear", "color", "focus", "heapdump", "doctor", "reload-plugins",
  "fast", "loop", "workflow-launch-exec", "design-consent", "design-revoke"]);

export function cliCommands(caps: Capabilities | null): CliCommand[] {
  return (caps?.commands ?? []).filter((c) =>
    !HIDDEN.has(c.name) && !/^\((removed)\)|^Renamed to/i.test(c.description));
}

export function findPageCommand(name: string): PageCommand | undefined {
  const n = name.replace(/^\//, "").toLowerCase();
  return PAGE_COMMANDS.find((c) => c.name === n || c.aliases?.includes(n));
}

export function findCliCommand(caps: Capabilities | null, name: string): CliCommand | undefined {
  const n = name.replace(/^\//, "").toLowerCase();
  return cliCommands(caps).find((c) => c.name.toLowerCase() === n || c.aliases.includes(n));
}

export function slashItems(caps: Capabilities | null, query: string): PaletteItem[] {
  const q = query.replace(/^\//, "").toLowerCase();
  const items: (PaletteItem & { rank: number })[] = [];
  const add = (name: string, aliases: string[], hint: string, description: string, badge: string,
               kind: PaletteItem["kind"]) => {
    const n = name.toLowerCase();
    const rank = !q ? 0 : n.startsWith(q) ? 0 : aliases.some((a) => a.startsWith(q)) ? 1
      : n.includes(q) ? 2 : description.toLowerCase().includes(q) ? 3 : -1;
    if (rank < 0) return;
    items.push({ key: `${kind}:${name}`, insert: `/${name} `, label: `/${name}`, hint, description, badge, kind,
      needsArgs: /^</.test(hint) && !/optional/i.test(hint), rank });
  };
  for (const c of PAGE_COMMANDS) add(c.name, c.aliases ?? [], c.hint ?? "", c.description, "page", "page");
  for (const c of cliCommands(caps)) {
    if (findPageCommand(c.name)) continue;
    add(c.name, c.aliases, c.argument_hint, c.description, c.builtin ? "cli" : "skill", c.builtin ? "cli" : "skill");
  }
  return items.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
}

export function helpMarkdown(caps: Capabilities | null): string {
  const row = (name: string, hint: string, desc: string) =>
    `| \`/${name}\`${hint ? ` ${hint.replace(/\|/g, "\\|")}` : ""} | ${desc.replace(/\|/g, "\\|").slice(0, 140)} |`;
  const cli = cliCommands(caps);
  const builtin = cli.filter((c) => c.builtin && !findPageCommand(c.name));
  const skills = cli.filter((c) => !c.builtin);
  return [
    "### Claude Code in the dashboard",
    "Every message runs the real Claude Code CLI on this server, with any model: **Claude (official)** through its own login, or a **custom provider** from Settings. Switch with `/model` at any point; the session continues.",
    "",
    "#### Shortcuts",
    "| Key | Does |", "|---|---|",
    "| `/` | Commands and skills |",
    "| `@` | Mention a file or folder (`@path`) or an agent (`@agent-name`) |",
    "| `!` | Bash mode: run a command here; its output goes into your next message |",
    "| `#` | Add a note to memory (CLAUDE.md) |",
    "| `Shift+Tab` | Cycle permission mode: ask permissions → accept edits → plan → bypass |",
    "| `Esc` | Stop the running turn |",
    "| `1`–`9`, `↑` / `↓`, `Enter` | Answer when Claude asks: a permission, a question or a plan (`Esc` says no) |",
    "| `↑` / `↓` | Previous prompts |",
    "",
    "#### Page commands", "| Command | Does |", "|---|---|",
    ...PAGE_COMMANDS.map((c) => row(c.name, c.hint ?? "", c.description)),
    "",
    `#### Claude Code commands (${builtin.length})`, "| Command | Does |", "|---|---|",
    ...builtin.map((c) => row(c.name, c.argument_hint, c.description)),
    ...(skills.length ? ["", `#### Skills and custom commands (${skills.length})`, "| Command | Does |", "|---|---|",
      ...skills.map((c) => row(c.name, c.argument_hint, c.description))] : []),
  ].join("\n");
}

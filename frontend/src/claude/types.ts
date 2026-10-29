// Chat model for the Claude Code page. Messages are typed parts, never HTML strings:
// transcripts and model output are untrusted text.

export interface Todo { content: string; status: string }

/** One AskUserQuestion question (the CLI adds "Other"; the page shows it as "Type something."). */
export interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
}

export type Part =
  | { kind: "text"; text: string; is_error?: boolean }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool"; id: string; name: string; summary: string; output: string; is_error: boolean; done: boolean;
      plan?: string; todos?: Todo[]; diff?: string; path?: string;
      /** AskUserQuestion: what was asked and, once answered, {question: answer}. */
      questions?: Question[]; answers?: Record<string, string>;
    }
  | { kind: "command"; name: string; args: string }
  | { kind: "command_output"; text: string; is_error?: boolean }
  | { kind: "bash"; command: string | null; stdout: string | null; stderr: string | null; code?: number | null; running?: boolean }
  | { kind: "image"; preview?: string }
  | { kind: "notice"; text: string; level: "info" | "warn" | "error"; detail?: string };

export type Role = "user" | "assistant" | "system";

export interface ChatMsg {
  id: string;
  role: Role;
  parts: Part[];
  model?: string;
  /** Text arriving token by token, replaced by the final text part. */
  streaming?: string;
  /** Waiting for the first output of this turn. */
  pending?: boolean;
  clientId?: string;
  /** Shown by the page only (/help, /status, …); not in the transcript. */
  local?: boolean;
}

export interface UsageCounts {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** Per model: official Claude costs come from Claude Code, custom models are estimated by the server. */
export interface ModelUsage extends UsageCounts {
  model: string;
  cost_usd: number | null;
  estimated: boolean;
}

export interface SessionUsage extends UsageCounts {
  total_cost_usd: number;
  estimated: boolean;
  unpriced: boolean;
  /** Prompt size of the latest model call: what the context window holds now. */
  context_tokens: number;
  models: ModelUsage[];
}

export interface TurnUsage extends SessionUsage {
  model: string;
}

export interface CliCommand {
  name: string;
  description: string;
  argument_hint: string;
  aliases: string[];
  builtin: boolean;
}

export interface NativeModel {
  value: string;
  display_name: string;
  description: string;
  effort_levels: string[];
  /** A shortcut to a router model: choosing it selects this model of this provider. */
  route?: { model: string; provider_id: string };
}

export interface Capabilities {
  version: string | null;
  commands: CliCommand[];
  agents: { name: string; description: string }[];
  models: NativeModel[];
  output_style: string | null;
  output_styles: string[];
  account: { subscription: string | null; provider: string | null };
  cwd: string;
  home: string;
  memory: { project: string; user: string };
  sandbox: { available: boolean; missing: string[] };
}

/** One plan window of the official Claude login: 5-hour, weekly, or a scoped weekly. */
export interface PlanWindow {
  key: string;
  label: string;
  /** 0-100, can pass 100 */
  percent: number;
  /** Unix seconds */
  resets_at: number | null;
  /** The server's reading: "normal" | "warning" | "critical" */
  severity: string;
  active: boolean;
}

export interface PlanLimits {
  /** False when the CLI signs in with an API key or a cloud provider: no plan limits apply. */
  available: boolean;
  subscription: string | null;
  windows: PlanWindow[];
  /** Unix seconds; null before the first answer */
  fetched_at: number | null;
  /** "usage" = asked Claude Code, "turn" = a running official turn's response headers */
  source: "usage" | "turn" | null;
  error: string | null;
}

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
/** Shift+Tab order, as in the terminal. */
export const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** A permission rule change the CLI suggests ("don't ask again"), or a session mode switch. */
export interface PermissionUpdate {
  type: string;
  destination?: string;
  mode?: string;
  behavior?: string;
  rules?: { toolName: string; ruleContent?: string }[];
  directories?: string[];
}

/** The CLI waits for the user (can_use_tool): a tool permission, AskUserQuestion or a plan to approve. */
export interface PromptRequest {
  request_id: string;
  tool_name: string;
  display_name?: string;
  title?: string;
  description?: string;
  input: Record<string, unknown>;
  tool_use_id?: string;
  permission_suggestions?: PermissionUpdate[];
  decision_reason?: string;
  blocked_path?: string;
  agent_id?: string;
  /** Open on "No" and take no digit shortcut: one stray key must not approve this. */
  default_to_no?: boolean;
  /** Offer no "don't ask again" row: the rule it would write is broader than this ask. */
  suppress_always_allow_rule?: boolean;
}

export type PromptAnswer =
  | { behavior: "allow"; answers?: Record<string, string>; permissions?: PermissionUpdate[] }
  /** interrupt: the turn stops, as after Esc in the terminal. */
  | { behavior: "deny"; message?: string; interrupt?: boolean };

/** What the latest system/init line said about the running CLI (for /status). */
export interface InitInfo {
  model?: string;
  cwd?: string;
  permissionMode?: string;
  claude_code_version?: string;
  tools?: string[];
  mcp_servers?: { name: string; status: string }[];
  output_style?: string;
}

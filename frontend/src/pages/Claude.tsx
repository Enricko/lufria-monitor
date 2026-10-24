import {
  ArrowDown,
  BarChart2,
  Bot,
  Coins,
  Image,
  Loader,
  Menu,
  MessageSquare,
  Pin,
  PinOff,
  Plus,
  Send,
  Search,
  Square,
  Trash2,
  TrendingUp,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "../api";
import { ModelPicker } from "../components/ModelPicker";
import { CommandPalette, CLAUDE_SLASH_COMMANDS, type SlashCommand } from "../components/CommandPalette";
import { FeedbackSuggestions } from "../components/FeedbackSuggestions";
import type { AgentModel, Provider, ProviderCatalog, ModelSelection } from "../provider-types";

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

const SESSION_KEY = "claude.chat.session_id";
const MSGS_KEY = "claude.chat.messages";
const PINS_KEY = "claude.chat.pinned";
const MODEL_KEY = "chat.selected_model";
const PROVIDER_KEY = "chat.selected_provider";

// Source is retained only to read and manage historical conversations.
type SessionSource = "claude" | "router";
type Role = "user" | "assistant";

interface ImageAttach {
  id: string;
  mime: string;
  data: string;
  preview: string;
  name: string;
}

interface ChatMsg {
  id: string;
  role: Role;
  text: string;
  images?: { mime: string; preview: string }[];
  error?: boolean;
  thinking?: boolean;
}

type ConnState = "connecting" | "idle" | "thinking" | "error" | "closed";

interface TurnUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  total_cost_usd: number;
  model: string;
}

interface RateLimitWindow {
  utilization: number;
  resets_at: number;
}

interface RateLimit {
  five_hour: RateLimitWindow;
  seven_day: RateLimitWindow;
}

interface UnifiedSession {
  provider_id?: string | null;
  provider?: string;
  id: string;
  engine: SessionSource;
  title: string;
  model?: string;
  created_at: number;
  updated_at: number;
  message_count: number;
  size_bytes?: number;
  total_tokens?: number;
  total_cost_usd?: number;
  project?: string;
}

interface ClaudeSession {
  provider_id?: string | null;
  provider?: string;
  model?: string;
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  message_count: number;
  size_bytes: number;
  project: string;
}

interface RouterSession {
  id: string;
  model: string;
  title: string;
  created_at: number;
  updated_at: number;
  total_tokens: number;
  total_cost_usd: number;
  message_count: number;
}

interface SessionDetail {
  provider_id?: string | null;
  provider?: string;
  id: string;
  title: string;
  model?: string;
  messages: { role: Role; text: string; ts: number }[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    total_cost_usd: number;
  };
}

type UsagePeriod = "today" | "week" | "month" | "all_time";

interface UsageBucket {
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

interface UsageHistoryItem {
  date: string;
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

interface UsageResponse {
  summary: {
    today: UsageBucket;
    week: UsageBucket;
    month: UsageBucket;
    all_time: UsageBucket;
  };
  history: UsageHistoryItem[];
  models: Record<string, { cost_usd: number; input_tokens: number; output_tokens: number }>;
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function toolCard(tool: string, command: string, output: string): string {
  const body = output.trim()
    ? `<pre><code>${escapeHtml(output.trimEnd())}</code></pre>`
    : '<p class="tool-empty-output">Tidak ada output.</p>';
  return `<details class="tool-call"><summary><span class="tool-call-left"><span class="tool-call-arrow" aria-hidden="true">▶</span><span class="tool-call-name">${escapeHtml(tool)}:</span><code class="tool-call-cmd" title="${escapeHtml(command).replace(/"/g, "&quot;")}">${escapeHtml(command)}</code></span><span class="tool-call-badge-done">✓ Selesai</span></summary><div class="tool-call-body">${body}</div></details>`;
}

function renderMarkdown(text: string): string {
  // 1. Convert legacy bash tool outputs (> ⚙️ **Bash:** `cmd` ... ```text output ```)
  // so existing history automatically collapses!
  const legacyToolPattern = />\s*⚙️\s*\*\*Bash:\*\*\s*`([^`]+)`\s*(?:```[\w]*\n?([\s\S]*?)```)?/g;
  text = text.replace(legacyToolPattern, (_, cmd, output) => {
    return toolCard("Bash", cmd.trim(), (output || "").trim());
  });

  // 2. Extract all <details> blocks to avoid breaking HTML inside paragraphs
  const detailsBlocks: string[] = [];
  text = text.replace(/<details[\s\S]*?<\/details>/gi, (match) => {
    // Cached cards can contain an empty pre; make that state explicit and compact.
    detailsBlocks.push(match.replace(/<pre[^>]*>\s*<code>\s*<\/code>\s*<\/pre>/gi,
      '<p class="tool-empty-output">Tidak ada output.</p>'));
    return `@@DETAILSBLOCK${detailsBlocks.length - 1}@@`;
  });

  // 3. Extract code blocks
  const codeBlocks: string[] = [];
  text = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) => {
    const escaped = escapeHtml(code);
    codeBlocks.push(`<pre class="md-pre"><code>${escaped.trimEnd()}</code></pre>`);
    return `@@CODEBLOCK${codeBlocks.length - 1}@@`;
  });

  // 4. Inline code
  text = text.replace(/`([^`\n]+)`/g, (_, c) => {
    return `<code class="md-code">${escapeHtml(c)}</code>`;
  });

  // 5. Bold & Italic
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*(.+?)\*/g, "<em>$1</em>");
  text = text.replace(/_(.+?)_/g, "<em>$1</em>");

  // 6. Line by line processing
  // Blank lines separate Markdown blocks; they are not visual empty rows.
  const lines = text.trim().split("\n");
  const out: string[] = [];
  let inList = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("@@DETAILSBLOCK") || trimmed.startsWith("@@CODEBLOCK")) {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(trimmed);
      continue;
    }
    if (!trimmed) {
      if (inList) { out.push("</ul>"); inList = false; }
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push('<hr class="md-rule"/>');
      continue;
    }
    const h3 = line.match(/^### (.+)/);
    const h2 = line.match(/^## (.+)/);
    const h1 = line.match(/^# (.+)/);
    const li = line.match(/^[-*] (.+)/);
    const num = line.match(/^\d+\. (.+)/);
    if (h3) { if (inList) { out.push("</ul>"); inList = false; } out.push(`<h3 class="md-h3">${h3[1]}</h3>`); }
    else if (h2) { if (inList) { out.push("</ul>"); inList = false; } out.push(`<h2 class="md-h2">${h2[1]}</h2>`); }
    else if (h1) { if (inList) { out.push("</ul>"); inList = false; } out.push(`<h1 class="md-h1">${h1[1]}</h1>`); }
    else if (li || num) {
      if (!inList) { out.push("<ul class='md-ul'>"); inList = true; }
      out.push(`<li>${li ? li[1] : num![1]}</li>`);
    } else {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(`<p class="md-p">${line}</p>`);
    }
  }
  if (inList) out.push("</ul>");

  let html = out.join("");
  html = html.replace(/@@CODEBLOCK(\d+)@@/g, (_, idx) => codeBlocks[Number(idx)]);
  html = html.replace(/@@DETAILSBLOCK(\d+)@@/g, (_, idx) => detailsBlocks[Number(idx)]);
  return html;
}

function MarkdownMsg({ text }: { text: string }) {
  const html = renderMarkdown(text);
  const toolOnly = html.includes('<details') && !html.replace(/<details[\s\S]*?<\/details>/gi, "").trim();
  return (
    <div
      className={`md-body text-sm leading-relaxed${toolOnly ? " md-tools-only" : ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// ---------------------------------------------------------------------------
// Small UI components
// ---------------------------------------------------------------------------

function StatusPill({ state }: { state: ConnState }) {
  if (state === "idle") return null;
  const map: Record<ConnState, { label: string; cls: string }> = {
    connecting: { label: "Connecting…", cls: "bg-surface-2 text-muted" },
    thinking: {
      label: "Sedang Berjalan…",
      cls: "bg-accent/20 text-accent border border-accent/40 shadow-sm shadow-accent/20 animate-pulse",
    },
    error: { label: "Error", cls: "bg-bad/10 text-bad" },
    closed: { label: "Disconnected", cls: "bg-bad/10 text-bad" },
    idle: { label: "", cls: "" },
  };
  const { label, cls } = map[state];
  return (
    <span role="status" data-connection-status className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${cls}`}>
      {state === "thinking" ? (
        <span className="relative flex size-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75"></span>
          <span className="relative inline-flex size-2 rounded-full bg-accent"></span>
        </span>
      ) : (
        state === "connecting" && <Loader size={10} className="animate-spin" />
      )}
      {label}
    </span>
  );
}

function RateLimitBar({ label, utilization, resetsAt }: {
  label: string; utilization: number; resetsAt: number;
}) {
  const pct = Math.min(100, Math.round(utilization * 100));
  const color = pct >= 85 ? "#ef4444" : pct >= 50 ? "#f59e0b" : "#22c55e";
  const resetsIn = resetsAt > 0 ? formatRelative(resetsAt) : null;
  return (
    <div className="mb-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-muted">{label}</span>
        <span className="text-xs font-mono text-fg-2">{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      {resetsIn && <p className="mt-0.5 text-right text-[10px] text-muted/60">Resets {resetsIn}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _mid = 0;
const uid = () => String(++_mid);

function formatRelative(ts: number): string {
  const now = Date.now() / 1000;
  const diff = ts - now;
  if (diff <= 0) return "soon";
  const h = Math.floor(diff / 3600);
  const d = Math.floor(diff / 86400);
  if (d > 0) return `in ${d}d`;
  if (h > 0) return `in ${h}h`;
  const m = Math.floor(diff / 60);
  return m > 0 ? `in ${m}m` : "soon";
}

function formatAgo(ts: number): string {
  const now = Date.now() / 1000;
  const diff = now - ts;
  if (diff < 60) return "just now";
  const m = Math.floor(diff / 60);
  const h = Math.floor(diff / 3600);
  const d = Math.floor(diff / 86400);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  return `${m}m ago`;
}

function formatTokens(n: number): string {
  if (!n) return "0";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd >= 100) return `$${usd.toFixed(2)}`;
  if (usd >= 10) return `$${usd.toFixed(2)}`;
  if (usd >= 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

function formatModelBadge(m: string): string {
  if (!m || m === "default" || m === "Claude Code") return "Default model";
  let clean = m.includes("/") ? m.split("/").pop()! : m;
  clean = clean.replace(/-flash|-preview|-turbo|-chat|-pro/gi, "");
  return clean
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .slice(0, 18);
}

function loadSavedMessages(key: string = MSGS_KEY): ChatMsg[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveMessages(msgs: ChatMsg[], key: string = MSGS_KEY) {
  try {
    const sanitized = msgs.slice(-50).map((m) => ({
      ...m, thinking: false,
      images: m.images?.map((i) => ({ mime: i.mime, preview: "" })),
    }));
    localStorage.setItem(key, JSON.stringify(sanitized));
  } catch {}
}

// ---------------------------------------------------------------------------
// Usage Components (Realtime & History)
// ---------------------------------------------------------------------------

function UsageHistoryModal({
  usage,
  onClose,
}: {
  usage: UsageResponse;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const controls = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex="0"]') || []);
    controls()[0]?.focus();
    const keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      if (e.key !== "Tab") return;
      const items = controls();
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    dialog?.addEventListener("keydown", keydown);
    return () => { dialog?.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="usage-history-title"
        className="flex max-h-[88vh] w-full max-w-4xl flex-col rounded-2xl border border-line bg-surface shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line px-4 sm:px-6 py-3.5 sm:py-4 bg-surface-2/30">
          <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
            <Coins className="text-accent size-5 shrink-0" />
            <div className="min-w-0">
              <h2 id="usage-history-title" className="text-sm sm:text-base font-semibold text-fg truncate">Usage & Cost History</h2>
              <p className="text-[11px] sm:text-xs text-muted truncate">Token & cost breakdown across conversations</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close usage history"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-3.5 sm:p-6 space-y-4 sm:space-y-6">
          {/* Summary Cards Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: "Today (Hari Ini)", data: usage.summary.today, highlight: false },
              { label: "This Week (7 Hari)", data: usage.summary.week, highlight: false },
              { label: "This Month (30 Hari)", data: usage.summary.month, highlight: false },
              { label: "All Time (Total)", data: usage.summary.all_time, highlight: true },
            ].map(({ label, data, highlight }) => (
              <div
                key={label}
                className={`rounded-xl border p-3.5 flex flex-col justify-between ${
                  highlight
                    ? "border-accent/40 bg-accent/5"
                    : "border-line bg-surface-2/40"
                }`}
              >
                <div>
                  <span className="text-[11px] font-medium text-muted uppercase tracking-wider">{label}</span>
                  <p className="text-xl font-bold font-mono text-fg mt-1">
                    {formatCost(data.cost_usd)}
                  </p>
                </div>
                <div className="mt-3 pt-2.5 border-t border-line/60 flex items-center justify-between text-xs">
                  <span className="text-muted">{data.sessions} sesi</span>
                  <span className="font-mono text-fg-2">{formatTokens(data.total_tokens)} tok</span>
                </div>
              </div>
            ))}
          </div>

          {/* Daily History Table */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <BarChart2 size={16} className="text-accent" />
                <h3 className="text-sm font-semibold text-fg">Riwayat Harian (Daily History)</h3>
              </div>
              <span className="text-xs text-muted">{usage.history.length} hari tercatat</span>
            </div>

            <div className="rounded-xl border border-line overflow-hidden bg-bg/50">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-surface-2/60 text-muted border-b border-line text-[11px] font-semibold uppercase tracking-wider">
                    <tr>
                      <th className="px-4 py-3">Tanggal</th>
                      <th className="px-3 py-3 text-center">Sesi</th>
                      <th className="px-3 py-3 text-right">Input Tok</th>
                      <th className="px-3 py-3 text-right">Output Tok</th>
                      <th className="px-3 py-3 text-right">Cache Read</th>
                      <th className="px-3 py-3 text-right">Total Tok</th>
                      <th className="px-4 py-3 text-right">Est. Biaya</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/60 font-mono">
                    {usage.history.map((row) => (
                      <tr key={row.date} className="hover:bg-surface-2/40 transition-colors">
                        <td className="px-4 py-2.5 font-sans font-medium text-fg flex items-center gap-2">
                          <span>{row.date}</span>
                        </td>
                        <td className="px-3 py-2.5 text-center text-muted">{row.sessions}</td>
                        <td className="px-3 py-2.5 text-right text-muted">{formatTokens(row.input_tokens)}</td>
                        <td className="px-3 py-2.5 text-right text-muted">{formatTokens(row.output_tokens)}</td>
                        <td className="px-3 py-2.5 text-right text-muted">{formatTokens(row.cache_read_tokens)}</td>
                        <td className="px-3 py-2.5 text-right text-fg-2 font-medium">{formatTokens(row.total_tokens)}</td>
                        <td className="px-4 py-2.5 text-right text-accent font-semibold">{formatCost(row.cost_usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* AI Model Breakdown */}
          {Object.keys(usage.models).length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <TrendingUp size={16} className="text-accent" />
                <h3 className="text-sm font-semibold text-fg">Breakdown Model AI</h3>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
                {Object.entries(usage.models).map(([model, info]) => (
                  <div key={model} className="rounded-xl border border-line bg-surface-2/30 p-3">
                    <p className="text-xs font-semibold text-fg truncate">{model}</p>
                    <p className="text-base font-bold font-mono text-accent mt-1">{formatCost(info.cost_usd)}</p>
                    <div className="mt-2 text-[10px] text-muted space-y-0.5 font-mono">
                      <p>In: {formatTokens(info.input_tokens)} tok</p>
                      <p>Out: {formatTokens(info.output_tokens)} tok</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function UsageWidget({
  usage,
  activePeriod,
  onChangePeriod,
  onOpenHistory,
}: {
  usage: UsageResponse | null;
  activePeriod: UsagePeriod;
  onChangePeriod: (p: UsagePeriod) => void;
  onOpenHistory: () => void;
}) {
  if (!usage) return null;
  const bucket = usage.summary[activePeriod] || usage.summary.today;

  const periods: { id: UsagePeriod; label: string }[] = [
    { id: "today", label: "Today" },
    { id: "week", label: "Week" },
    { id: "month", label: "Month" },
    { id: "all_time", label: "All" },
  ];

  return (
    <div className="px-4 py-3 border-b border-line shrink-0 bg-surface">
      {/* Header with History Button */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <Coins size={13} className="text-accent" />
          <span className="text-[11px] font-semibold tracking-wide text-fg-2 uppercase">Usage & Cost</span>
        </div>
        <button
          type="button"
          onClick={onOpenHistory}
          title="Lihat riwayat lengkap"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-accent hover:bg-accent/10 transition-colors cursor-pointer"
        >
          <BarChart2 size={12} />
          <span>History</span>
        </button>
      </div>

      {/* Interval Selector Tabs */}
      <div className="grid grid-cols-4 gap-1 p-0.5 bg-surface-2 rounded-lg mb-2">
        {periods.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onChangePeriod(p.id)}
            className={`py-1 text-[10px] font-medium rounded transition-all text-center cursor-pointer ${
              activePeriod === p.id
                ? "bg-surface text-fg font-semibold shadow-xs"
                : "text-muted hover:text-fg-2"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Main Metrics */}
      <div className="flex items-baseline justify-between">
        <div>
          <span className="text-[10px] text-muted block leading-none mb-1">Est. Price</span>
          <span className="text-base font-bold font-mono text-accent">
            {formatCost(bucket.cost_usd)}
          </span>
        </div>
        <div className="text-right">
          <span className="text-[10px] text-muted block leading-none mb-1">Total Tokens</span>
          <span className="text-xs font-semibold font-mono text-fg">
            {formatTokens(bucket.total_tokens)}
          </span>
        </div>
      </div>

      {/* Breakdown Details */}
      <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted font-mono pt-1.5 border-t border-line/40">
        <span>↑{formatTokens(bucket.input_tokens)}</span>
        <span className="opacity-30">·</span>
        <span>↓{formatTokens(bucket.output_tokens)}</span>
        <span className="opacity-30">·</span>
        <span>cache {formatTokens(bucket.cache_read_tokens)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

interface ContextMenuState {
  x: number;
  y: number;
  sessionId: string;
}

function Sidebar({
  sessions,
  loading,
  activeSessionId,
  isThinking,
  pinnedIds,
  rateLimit,
  usage,
  activePeriod,
  onChangePeriod,
  onOpenHistory,
  onNewChat,
  onSelect,
  onDelete,
  onTogglePin,
}: {
  sessions: UnifiedSession[];
  loading: boolean;
  activeSessionId: string | null;
  isThinking?: boolean;
  pinnedIds: Set<string>;
  rateLimit: RateLimit | null;
  usage: UsageResponse | null;
  activePeriod: UsagePeriod;
  onChangePeriod: (p: UsagePeriod) => void;
  onOpenHistory: () => void;
  onNewChat: () => void;
  onSelect: (s: UnifiedSession) => void;
  onDelete: (s: UnifiedSession) => void;
  onTogglePin: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // Close context menu on outside click or scroll
  useEffect(() => {
    const close = () => setCtxMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, []);

  const handleContextMenu = (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, sessionId });
  };

  // One conversation list, searchable by title or model; pinned items stay first.
  const filteredSessions = sessions.filter((s) =>
    `${s.title} ${s.model || ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()),
  );

  const sortedSessions = [...filteredSessions].sort((a, b) => {
    const aPin = pinnedIds.has(a.id);
    const bPin = pinnedIds.has(b.id);
    if (aPin && !bPin) return -1;
    if (!aPin && bPin) return 1;
    return b.updated_at - a.updated_at;
  });

  const ctxSession = sessions.find((s) => s.id === ctxMenu?.sessionId);
  const isCtxPinned = ctxMenu ? pinnedIds.has(ctxMenu.sessionId) : false;

  return (
    <div className="flex h-full flex-col bg-surface select-none">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <MessageSquare size={15} className="text-muted" />
          <h2 className="text-sm font-semibold text-fg">Sessions</h2>
          <span className="text-[11px] text-muted tabular-nums">{sessions.length}</span>
        </div>
        <button type="button" onClick={onNewChat} title="New chat" aria-label="New chat"
          className="agent-icon-button text-accent hover:bg-accent/10">
          <Plus size={18} />
        </button>
      </div>
      <div className="px-3 pt-3 pb-2 shrink-0">
        <label className="agent-session-search">
          <Search size={15} aria-hidden="true" />
          <input value={query} onChange={(e) => setQuery(e.target.value)}
            aria-label="Search sessions" name="session-search" autoComplete="off" placeholder="Search sessions…" type="search" />
        </label>
      </div>

      {/* Rate limit bars */}
      {rateLimit && (
        <div className="px-4 pt-3 pb-2 border-b border-line shrink-0">
          <RateLimitBar
            label="5h window"
            utilization={rateLimit.five_hour.utilization}
            resetsAt={rateLimit.five_hour.resets_at}
          />
          <RateLimitBar
            label="7d window"
            utilization={rateLimit.seven_day.utilization}
            resetsAt={rateLimit.seven_day.resets_at}
          />
        </div>
      )}

      {/* Realtime Usage & Cost Widget */}
      <UsageWidget
        usage={usage}
        activePeriod={activePeriod}
        onChangePeriod={onChangePeriod}
        onOpenHistory={onOpenHistory}
      />

      {/* Session list — scrollable */}
      <div
        className="flex-1 overflow-y-auto min-h-0 py-1"
        onScroll={() => setCtxMenu(null)}
      >
        {loading && sessions.length === 0 && (
          <div className="px-4 py-3 space-y-2">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-10 rounded-lg bg-surface-2 animate-pulse" />
            ))}
          </div>
        )}
        {!loading && sortedSessions.length === 0 && (
          <div className="flex flex-col items-center py-10 text-muted px-4 text-center">
            <MessageSquare size={24} className="mb-2 opacity-40" />
            <p className="text-xs">{query ? "No matching sessions" : "No sessions yet"}</p>
          </div>
        )}
        {sortedSessions.map((session) => {
          const isActive = session.id === activeSessionId;
          const isPinned = pinnedIds.has(session.id);
          const isConfirming = deleteConfirmId === session.id;

          return (
            <div
              key={session.id}
              className={`relative flex min-h-16 flex-col mx-2 my-1 rounded-lg px-3 py-2.5 cursor-pointer transition-colors
                ${isActive ? "bg-surface-2" : "hover:bg-surface-2/50"}`}
              onClick={() => {
                if (!isConfirming) onSelect(session);
              }}
              role="button"
              tabIndex={0}
              aria-label={session.title}
              aria-current={isActive ? "true" : undefined}
              onKeyDown={(e) => {
                if (!isConfirming && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  onSelect(session);
                }
              }}
              onContextMenu={(e) => handleContextMenu(e, session.id)}
            >
              {isConfirming ? (
                // Inline confirmation dialog
                <div
                  className="flex flex-col gap-1.5 py-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <p className="text-xs font-medium text-bad">Hapus sesi ini?</p>
                  <p className="text-[10px] text-muted truncate">"{session.title}"</p>
                  <div className="flex items-center gap-2 mt-1">
                    <button
                      type="button"
                      onClick={() => {
                        onDelete(session);
                        setDeleteConfirmId(null);
                      }}
                      className="px-2 py-0.5 rounded bg-bad text-bg text-[11px] font-medium hover:bg-bad/80"
                    >
                      Hapus
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteConfirmId(null)}
                      className="px-2 py-0.5 rounded bg-surface border border-line text-muted text-[11px] hover:text-fg"
                    >
                      Batal
                    </button>
                  </div>
                </div>
              ) : (
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {isPinned && (
                      <Pin size={11} className="text-accent shrink-0 -rotate-45" />
                    )}
                    <p
                      className={`text-xs font-medium truncate ${
                        isActive ? "text-fg" : "text-fg-2"
                      }`}
                    >
                      {session.title}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 mt-1.5">
                    {isActive && isThinking && (
                      <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-semibold bg-accent/20 text-accent border border-accent/40 animate-pulse">
                        <span className="relative flex size-1.5">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75"></span>
                          <span className="relative inline-flex size-1.5 rounded-full bg-accent"></span>
                        </span>
                        Aktif
                      </span>
                    )}
                    {session.model && (
                      <span className="min-w-0 max-w-[110px] truncate text-[10px] text-muted" title={session.model}>
                        {formatModelBadge(session.model)}
                      </span>
                    )}
                    {session.engine === "router" && (
                      <span className="text-[9px] text-muted border border-line rounded px-1">Archive</span>
                    )}
                    <span className="text-[10px] text-muted">
                      {formatAgo(session.updated_at)}
                    </span>
                    <span className="text-[10px] text-muted/60 bg-surface-2 rounded px-1">
                      {session.message_count}
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Floating Context Menu */}
      {ctxMenu && ctxSession && (
        <div
          className="fixed z-50 min-w-[140px] rounded-lg border border-line bg-surface-2 p-1 shadow-xl text-xs backdrop-blur animate-in fade-in zoom-in-95 duration-100"
          style={{
            top: Math.min(ctxMenu.y, window.innerHeight - 90),
            left: Math.min(ctxMenu.x, window.innerWidth - 150),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              onTogglePin(ctxMenu.sessionId);
              setCtxMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-fg-2 hover:bg-surface hover:text-fg transition-colors"
          >
            {isCtxPinned ? (
              <>
                <PinOff size={13} className="text-muted" />
                <span>Unpin</span>
              </>
            ) : (
              <>
                <Pin size={13} className="text-muted" />
                <span>Pin ke atas</span>
              </>
            )}
          </button>
          <div className="my-1 border-t border-line" />
          <button
            type="button"
            onClick={() => {
              setDeleteConfirmId(ctxMenu.sessionId);
              setCtxMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-bad hover:bg-bad/10 transition-colors"
          >
            <Trash2 size={13} />
            <span>Hapus sesi…</span>
          </button>
        </div>
      )}
    </div>
  );
}

function mergeUsage(c: UsageResponse | null, r: UsageResponse | null): UsageResponse | null {
  if (!c && !r) return null;
  if (!c) return r;
  if (!r) return c;

  const mergeBucket = (b1: UsageBucket, b2?: UsageBucket): UsageBucket => ({
    sessions: (b1?.sessions || 0) + (b2?.sessions || 0),
    input_tokens: (b1?.input_tokens || 0) + (b2?.input_tokens || 0),
    output_tokens: (b1?.output_tokens || 0) + (b2?.output_tokens || 0),
    cache_read_tokens: (b1?.cache_read_tokens || 0) + (b2?.cache_read_tokens || 0),
    cache_creation_tokens: (b1?.cache_creation_tokens || 0) + (b2?.cache_creation_tokens || 0),
    total_tokens: (b1?.total_tokens || 0) + (b2?.total_tokens || 0),
    cost_usd: Number(((b1?.cost_usd || 0) + (b2?.cost_usd || 0)).toFixed(4)),
  });

  const mergedSummary = {
    today: mergeBucket(c.summary.today, r.summary.today),
    week: mergeBucket(c.summary.week, r.summary.week),
    month: mergeBucket(c.summary.month, r.summary.month),
    all_time: mergeBucket(c.summary.all_time, r.summary.all_time),
  };

  const histMap = new Map<string, UsageHistoryItem>();
  for (const h of c.history) histMap.set(h.date, { ...h });
  for (const h of r.history) {
    const existing = histMap.get(h.date);
    if (existing) {
      existing.sessions += h.sessions;
      existing.input_tokens += h.input_tokens;
      existing.output_tokens += h.output_tokens;
      existing.total_tokens += h.total_tokens;
      existing.cost_usd = Number((existing.cost_usd + h.cost_usd).toFixed(4));
    } else {
      histMap.set(h.date, { ...h });
    }
  }
  const mergedHistory = Array.from(histMap.values()).sort((a, b) => b.date.localeCompare(a.date));

  const mergedModels: Record<string, { cost_usd: number; input_tokens: number; output_tokens: number }> = {
    ...c.models,
  };
  for (const [m, info] of Object.entries(r.models)) {
    if (mergedModels[m]) {
      mergedModels[m] = {
        cost_usd: Number((mergedModels[m].cost_usd + info.cost_usd).toFixed(4)),
        input_tokens: mergedModels[m].input_tokens + info.input_tokens,
        output_tokens: mergedModels[m].output_tokens + info.output_tokens,
      };
    } else {
      mergedModels[m] = info;
    }
  }

  return {
    summary: mergedSummary,
    history: mergedHistory,
    models: mergedModels,
  };
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function Claude({ active }: { active: boolean }) {
  // All active conversations use Claude Code. Legacy conversations are read-only.
  const [sessionSource, setSessionSource] = useState<SessionSource>("claude");
  const isArchived = sessionSource === "router";
  const [sessionModel, setSessionModel] = useState<string | null>(null);

  const [selectedModel, setSelectedModel] = useState<string>(() => {
    try {
      return localStorage.getItem(MODEL_KEY) || "default";
    } catch {
      return "default";
    }
  });

  const [selectedProvider, setSelectedProvider] = useState<string | null>(() => {
    try { return localStorage.getItem(PROVIDER_KEY); } catch { return null; }
  });
  const [agentModels, setAgentModels] = useState<AgentModel[]>([]);
  const [modelProviders, setModelProviders] = useState<Provider[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const manualSelectionRef = useRef<string | null>(null);
  const selectionGenerationRef = useRef(0);
  const detailGenerationRef = useRef(0);

  const [sessionId, setSessionId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(SESSION_KEY);
    } catch {
      return null;
    }
  });

  const initialSessionRef = useRef(sessionId);
  const [bindingReady, setBindingReady] = useState(!sessionId);
  const bindingReadyRef = useRef(!sessionId);
  const [bindingError, setBindingError] = useState<string | null>(null);
  const bindingTargetRef = useRef<Pick<UnifiedSession, "id" | "engine" | "model"> | null>(null);

  const [messages, setMessages] = useState<ChatMsg[]>(() => {
    try {
      return loadSavedMessages();
    } catch {
      return [];
    }
  });

  const [input, setInput] = useState("");
  const [images, setImages] = useState<ImageAttach[]>([]);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [commandIndex, setCommandIndex] = useState(0);

  const [claudeConnState, setClaudeConnState] = useState<ConnState>("connecting");
  const connState = claudeConnState;
  const connStateRef = useRef(connState);
  connStateRef.current = connState;

  const claudeWsRef = useRef<WebSocket | null>(null);
  const claudeReconnRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Combined sessions
  const [claudeSessions, setClaudeSessions] = useState<ClaudeSession[]>([]);
  const [routerSessions, setRouterSessions] = useState<RouterSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 1024);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(PINS_KEY);
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch { return new Set(); }
  });

  // Rate limit & usage
  const [rateLimit, setRateLimit] = useState<RateLimit | null>(null);
  const [turnUsages, setTurnUsages] = useState<Map<number, TurnUsage>>(new Map());
  const [activeTool, setActiveTool] = useState<{ id: string; tool: string; command: string } | null>(null);
  const assistantIndexRef = useRef<number>(-1);

  // Active session cumulative stats from turnUsages
  const sessionTotalCost = Array.from(turnUsages.values()).reduce((sum, u) => sum + u.total_cost_usd, 0);
  const sessionTotalTokens = Array.from(turnUsages.values()).reduce(
    (sum, u) => sum + u.input_tokens + u.output_tokens + u.cache_read_input_tokens,
    0
  );

  // Global usage & history stats
  const [claudeUsage, setClaudeUsage] = useState<UsageResponse | null>(null);
  const [routerUsage, setRouterUsage] = useState<UsageResponse | null>(null);
  const [usagePeriod, setUsagePeriod] = useState<UsagePeriod>("all_time");
  const [historyModalOpen, setHistoryModalOpen] = useState(false);

  // Auto-scroll state
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const isAtBottomRef = useRef(true);

  // Save messages whenever they change
  useEffect(() => {
    if (!isArchived) saveMessages(messages);
  }, [messages, isArchived]);

  // Load models list
  const loadModels = useCallback(async (refresh = false) => {
    setModelsLoading(true);
    setModelsError(null);
    try {
      const data = await api<ProviderCatalog>(refresh ? "/api/providers/refresh" : "/api/providers", refresh ? {method:"POST"} : undefined);
      setAgentModels(data.models);
      setModelProviders(data.providers);
      const failed = data.providers.filter((p) => p.enabled && p.error);
      if (failed.length) setModelsError(`Could not refresh ${failed.map((p) => p.name).join(", ")}. Last known models remain available.`);
    } catch {
      setModelsError("Unable to load model catalog. Check provider settings and try again.");
    } finally { setModelsLoading(false); }
  }, []);

  useEffect(() => {
    const reload = () => { void loadModels(); };
    window.addEventListener("providers-updated", reload);
    return () => window.removeEventListener("providers-updated", reload);
  }, [loadModels]);

  const selectModel = useCallback((selection: ModelSelection) => {
    if (connStateRef.current === "thinking") return;
    selectionGenerationRef.current++;
    setSelectedModel(selection.model);
    setSelectedProvider(selection.provider_id);
    setSessionModel(selection.model);
    manualSelectionRef.current = bindingTargetRef.current?.id || sessionId || "new";
    try {
      localStorage.setItem(MODEL_KEY, selection.model);
      if (selection.provider_id) localStorage.setItem(PROVIDER_KEY, selection.provider_id);
      else localStorage.removeItem(PROVIDER_KEY);
    } catch {}
  }, [sessionId]);

  // Load usage stats
  const loadUsage = useCallback(async () => {
    try {
      const [c, r] = await Promise.allSettled([
        api<UsageResponse>("/api/claude/usage"),
        api<UsageResponse>("/api/router/usage"),
      ]);
      if (c.status === "fulfilled") setClaudeUsage(c.value);
      if (r.status === "fulfilled") setRouterUsage(r.value);
    } catch {}
  }, []);

  // Load sessions from both engines
  const loadSessions = useCallback(async () => {
    try {
      const [c, r] = await Promise.allSettled([
        api<ClaudeSession[]>("/api/claude/sessions"),
        api<RouterSession[]>("/api/router/sessions"),
      ]);
      if (c.status === "fulfilled") setClaudeSessions(c.value);
      if (r.status === "fulfilled") setRouterSessions(r.value);
    } catch {}
    setSessionsLoading(false);
  }, []);

  useEffect(() => {
    loadSessions();
    loadUsage();
    loadModels();
  }, [loadSessions, loadUsage, loadModels]);

  // Combined unified sessions
  const unifiedSessions: UnifiedSession[] = [
    ...claudeSessions.map((s): UnifiedSession => ({
      id: s.id,
      engine: "claude",
      model: s.model,
      provider_id: s.provider_id,
      provider: s.provider,
      title: s.title,
      created_at: s.created_at,
      updated_at: s.updated_at,
      message_count: s.message_count,
      size_bytes: s.size_bytes,
      project: s.project,
    })),
    ...routerSessions.map((s): UnifiedSession => ({
      id: s.id,
      engine: "router",
      title: s.title,
      model: s.model,
      created_at: s.created_at,
      updated_at: s.updated_at,
      message_count: s.message_count,
      total_tokens: s.total_tokens,
      total_cost_usd: s.total_cost_usd,
    })),
  ];

  // Sidebar summaries are not authoritative bindings: only canonical detail or
  // an explicit picker choice may change the active model/provider pair.

  const usageData = mergeUsage(claudeUsage, routerUsage);

  // Update browser document title while AI is thinking/running
  useEffect(() => {
    if (connState === "thinking") {
      const prev = document.title;
      document.title = "● Sedang Berjalan… | Lufria Monitor";
      return () => {
        document.title = prev || "Lufria Monitor";
      };
    }
  }, [connState]);

  // Scroll helpers
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior });
    });
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    isAtBottomRef.current = gap < 80;
    setShowScrollBtn(gap > 200);
  }, []);

  useEffect(() => {
    if (isAtBottomRef.current) {
      scrollToBottom("instant");
    }
  }, [messages, scrollToBottom]);

  const appendMsg = useCallback((msg: ChatMsg) => {
    setMessages((prev) => {
      const next = [...prev, msg];
      if (msg.role === "assistant") assistantIndexRef.current = next.length - 1;
      return next;
    });
  }, []);

  const patchLastAssistant = useCallback((patch: Partial<ChatMsg>) => {
    setMessages((prev) => {
      const idx = [...prev].reverse().findIndex((m) => m.role === "assistant");
      if (idx === -1) return prev;
      const real = prev.length - 1 - idx;
      const updated = [...prev];
      updated[real] = { ...updated[real], ...patch };
      return updated;
    });
  }, []);

  const appendDeltaText = useCallback((delta: string) => {
    setMessages((prev) => {
      const idx = [...prev].reverse().findIndex((m) => m.role === "assistant");
      if (idx === -1) {
        return [...prev, { id: uid(), role: "assistant", text: delta, thinking: false }];
      }
      const real = prev.length - 1 - idx;
      const updated = [...prev];
      const cur = updated[real];
      updated[real] = {
        ...cur,
        text: (cur.text || "") + delta,
        thinking: false,
      };
      return updated;
    });
  }, []);

  // Claude WebSocket message handler
  const handleClaudeWsMessage = useCallback(
    (raw: string) => {
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(raw); } catch { return; }
      const type = obj.type as string;

      if (type === "turn_usage") {
        const usage: TurnUsage = {
          input_tokens: (obj.input_tokens as number) || 0,
          output_tokens: (obj.output_tokens as number) || 0,
          cache_read_input_tokens: (obj.cache_read_input_tokens as number) || 0,
          total_cost_usd: (obj.total_cost_usd as number) || 0,
          model: (obj.model as string) || "",
        };
        const turnIdx = assistantIndexRef.current;
        if (turnIdx >= 0) {
          setTurnUsages((prev) => { const next = new Map(prev); next.set(turnIdx, usage); return next; });
        }
        return;
      }

      if (type === "rate_limit") {
        setRateLimit({ five_hour: obj.five_hour as RateLimitWindow, seven_day: obj.seven_day as RateLimitWindow });
        return;
      }

      if (type === "session") {
        const sid = obj.session_id as string;
        if (sid) {
          setSessionId(sid);
          try { localStorage.setItem(SESSION_KEY, sid); } catch {}
          setTimeout(loadSessions, 500);
        }
        return;
      }

      if (type === "status") {
        const state = obj.state as ConnState;
        setClaudeConnState(state);
        if (state === "error") {
          setActiveTool(null);
          patchLastAssistant({ text: String(obj.msg || "Unable to complete the request. Try again."), thinking: false, error: true });
        }
        if (state === "thinking") appendMsg({ id: uid(), role: "assistant", text: "", thinking: true });
        if (state === "idle") {
          setActiveTool(null);
          setTimeout(loadSessions, 1000);
          setTimeout(loadUsage, 1000);
        }
        return;
      }

      if (type === "tool_start") {
        setActiveTool({
          id: (obj.id as string) || "tool_call",
          tool: (obj.tool as string) || "Bash",
          command: (obj.command as string) || "",
        });
        return;
      }

      if (type === "tool_done") {
        setActiveTool(null);
        const toolName = (obj.tool as string) || "Bash";
        const cmd = (obj.command as string) || "";
        const output = (obj.output as string) || "";
        const detailsBlock = `\n\n${toolCard(toolName, cmd || "completed", output)}\n\n`;
        appendDeltaText(detailsBlock);
        return;
      }

      if (type === "system" && (obj as { subtype?: string }).subtype === "init") {
        // init announces the session, not turn completion: keep the composer locked.
        const model = obj.model as string | undefined;
        if (model) setSessionModel(model);
        const sid = (obj as { session_id?: string }).session_id;
        if (sid) { setSessionId(sid); try { localStorage.setItem(SESSION_KEY, sid); } catch {} }
        return;
      }

      if (type === "assistant") {
        if (obj.error || obj.is_api_error_message) {
          patchLastAssistant({ text: String(obj.error || "API error"), thinking: false, error: true });
          return;
        }
        const msg = obj.message as { content?: unknown[] };
        const content = msg?.content ?? [];
        const text = (content as { type?: string; text?: string }[])
          .filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
        if (text) {
          appendDeltaText(text);
        }
        return;
      }

      if (type === "result") {
        setClaudeConnState("idle");
        setActiveTool(null);
        patchLastAssistant({ thinking: false });
      }
    },
    [appendMsg, patchLastAssistant, appendDeltaText, loadSessions, loadUsage],
  );

  // Connect Claude WS
  const connectClaude = useCallback(() => {
    setClaudeConnState("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/claude`);
    claudeWsRef.current = ws;
    ws.onopen = () => {
      setClaudeConnState("idle");
      try {
        const saved = localStorage.getItem(SESSION_KEY);
        if (saved) ws.send(JSON.stringify({ type: "resume", session_id: saved }));
      } catch {}
    };
    ws.onmessage = (ev) => { if (typeof ev.data === "string") handleClaudeWsMessage(ev.data); };
    ws.onclose = () => { setClaudeConnState("closed"); claudeReconnRef.current = setTimeout(connectClaude, 5000); };
  }, [handleClaudeWsMessage]);

  useEffect(() => {
    connectClaude();
    return () => {
      clearTimeout(claudeReconnRef.current);
      const ws = claudeWsRef.current;
      if (ws) { ws.onclose = null; ws.close(); }
    };
  }, [connectClaude]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  const newChat = useCallback(() => {
    if (connStateRef.current === "thinking") return;
    if (window.innerWidth < 1024) setSidebarOpen(false);
    setSessionSource("claude");
    detailGenerationRef.current++;
    bindingTargetRef.current = null;
    bindingReadyRef.current = true;
    setBindingReady(true);
    setBindingError(null);
    setSessionModel(null);
    manualSelectionRef.current = null;
    try { localStorage.removeItem(SESSION_KEY); localStorage.removeItem(MSGS_KEY); } catch {}
    const ws = claudeWsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resume", session_id: "" }));
    setSessionId(null);
    setMessages([]);
    setInput("");
    setImages((prev) => { prev.forEach((i) => URL.revokeObjectURL(i.preview)); return []; });
    setTurnUsages(new Map());
    assistantIndexRef.current = -1;
  }, [connState]);

  const send = useCallback((overrideText?: string | React.MouseEvent) => {
    const raw = (typeof overrideText === "string" ? overrideText : input).trim();
    if (!raw && images.length === 0) return;
    if (connStateRef.current !== "idle" || !bindingReady || !bindingReadyRef.current) return;

    if (isArchived) return;

    const lower = raw.toLowerCase();

    // Client-side slash commands
    if (lower === "/model" || lower.startsWith("/model ")) {
      setInput("");
      setCommandPaletteOpen(false);
      document.querySelector<HTMLButtonElement>('button[aria-label="Choose model"]')?.click();
      return;
    }
    if (lower === "/cost" || lower.startsWith("/cost ")) {
      setInput("");
      setCommandPaletteOpen(false);
      setHistoryModalOpen(true);
      return;
    }
    if (lower === "/clear") {
      setCommandPaletteOpen(false);
      newChat();
      return;
    }
    if (lower === "/status") {
      setInput("");
      setCommandPaletteOpen(false);
      const provName = modelProviders.find((p) => p.id === selectedProvider)?.name || selectedProvider || "Claude native";
      const totalTokensStr = sessionTotalTokens.toLocaleString();
      const statusMd = `### ⚡ Status Sesi & Lingkungan Claude Code\n\n| Komponen | Status / Nilai |\n|:---|:---|\n| **🤖 Model AI** | \`${selectedModel || "default"}\` |\n| **🌐 AI Provider** | \`${provName}\` |\n| **💬 Sesi Aktif** | \`${sessionId ? sessionId.slice(0, 16) + "…" : "New Chat"}\` |\n| **📂 Direktori Proyek** | \`/home/lufria\` |\n| **⚙️ Runtime Bridge** | \`Claude Code CLI Agent (Print Mode)\` |\n| **💰 Total Biaya Sesi** | \`$${sessionTotalCost.toFixed(4)}\` (${totalTokensStr} tokens) |\n\n*Gunakan \`/model\` untuk mengganti model atau klik ikon statistik untuk riwayat lengkap.*`;
      appendMsg({ id: uid(), role: "user", text: "/status" });
      setTimeout(() => {
        appendMsg({ id: uid(), role: "assistant", text: statusMd });
      }, 50);
      return;
    }
    if (lower === "/help") {
      setInput("");
      setCommandPaletteOpen(false);
      const helpMd = `### 📖 Panduan Perintah & Shortcut Claude Code\n\n#### Perintah Chat di Dashboard:\n- **\`/model\`** : Buka dialog pemilih model & provider AI\n- **\`/status\`** : Tampilkan status sesi, resource, dan model aktif\n- **\`/cost\`** : Buka modal rincian token & biaya\n- **\`/clear\`** : Bersihkan percakapan dan mulai sesi baru\n- **\`/plan\`** : Mode perencanaan tugas bertahap (Plan Mode)\n- **\`/review\`** : Review perubahan kode (git status & diff) terbaru\n- **\`/security-review\`** : Audit keamanan kode terhadap celah kerentanan\n- **\`/context\`** : Estimasi penggunaan context window sesi ini\n- **\`/compact\`** : Kompres percakapan untuk menghemat context window\n\n#### Shortcut Terminal (\`claude-session resume\`):\n- **\`!\`** : Eksekusi command Bash langsung tanpa Claude AI\n- **\`@\`** : Panggil agent atau file tertentu (\`@security-reviewer\`)\n- **\`#\`** : Simpan catatan langsung ke \`CLAUDE.md\`\n- **\`Shift + Tab\`** : Toggle mode izin interaktif (Auto-Accept vs Normal)`;
      appendMsg({ id: uid(), role: "user", text: "/help" });
      setTimeout(() => {
        appendMsg({ id: uid(), role: "assistant", text: helpMd });
      }, 50);
      return;
    }

    // Command expansion for agent workflows
    let text = raw;
    if (lower === "/plan" || lower.startsWith("/plan ")) {
      const task = raw.slice(5).trim();
      text = task
        ? `[Plan Mode] Buat rencana bertahap (step-by-step plan) yang jelas dan terstruktur sebelum mengeksekusi: ${task}`
        : `[Plan Mode] Rancang rencana kerja bertahap (step-by-step plan) yang jelas dan terstruktur sebelum melakukan perubahan.`;
    } else if (lower === "/review" || lower.startsWith("/review ")) {
      const target = raw.slice(7).trim();
      text = target
        ? `[Code Review] Lakukan review menyeluruh pada kode atau file berikut: ${target}. Cek potensi bug, keandalan, dan performa.`
        : `[Code Review] Review perubahan kode (git status & diff) terbaru di direktori kerja saat ini, laporkan temuan atau potensi bug.`;
    } else if (lower === "/security-review" || lower.startsWith("/security-review ")) {
      const target = raw.slice(16).trim();
      text = target
        ? `[Security Audit] Jalankan audit keamanan mendalam pada: ${target}. Cek celah OWASP, sanitasi input, SQLi, dan credential leak.`
        : `[Security Audit] Jalankan audit keamanan terhadap kode dan endpoint saat ini. Periksa celah OWASP, SQLi, command injection, path traversal, dan secret leakage.`;
    }

    const ws = claudeWsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const imgPayload = images.map((img) => ({ mime: img.mime, data: img.data }));
    appendMsg({ id: uid(), role: "user", text, images: images.map((i) => ({ mime: i.mime, preview: i.preview })) });
    // Lock immediately, including the interval before the server's thinking event.
    connStateRef.current = "thinking";
    setClaudeConnState("thinking");
    setCommandPaletteOpen(false);
    ws.send(JSON.stringify({
      type: "user", text, images: imgPayload,
      model: !selectedProvider && (selectedModel === "default" || selectedModel === "claude") ? null : selectedModel,
      provider_id: selectedProvider,
    }));

    setInput("");
    images.forEach((i) => URL.revokeObjectURL(i.preview));
    setImages([]);
    isAtBottomRef.current = true;
    scrollToBottom("instant");
  }, [input, images, connState, bindingReady, isArchived, selectedModel, selectedProvider, modelProviders, sessionId, sessionTotalCost, sessionTotalTokens, appendMsg, scrollToBottom, newChat]);

  const executeCommand = useCallback((cmd: SlashCommand) => {
    if (cmd.name === "/model") {
      setInput("");
      setCommandPaletteOpen(false);
      document.querySelector<HTMLButtonElement>('button[aria-label="Choose model"]')?.click();
      return;
    }
    if (cmd.name === "/cost") {
      setInput("");
      setCommandPaletteOpen(false);
      setHistoryModalOpen(true);
      return;
    }
    if (cmd.name === "/clear") {
      setInput("");
      setCommandPaletteOpen(false);
      newChat();
      return;
    }
    if (
      cmd.name === "/status" ||
      cmd.name === "/help" ||
      cmd.name === "/context" ||
      cmd.name === "/compact" ||
      cmd.name === "/plan" ||
      cmd.name === "/review" ||
      cmd.name === "/security-review"
    ) {
      setCommandPaletteOpen(false);
      send(cmd.name);
      return;
    }
    setInput(cmd.name + " ");
    setCommandPaletteOpen(false);
    textareaRef.current?.focus();
  }, [newChat, send]);

  const interrupt = useCallback(() => {
    setActiveTool(null);
    if (claudeWsRef.current?.readyState === WebSocket.OPEN) {
      claudeWsRef.current.send(JSON.stringify({ type: "interrupt" }));
    }
  }, []);

  const loadSessionDetail = useCallback(async (session: Pick<UnifiedSession, "id" | "engine" | "model">) => {
    if (connStateRef.current === "thinking") return;
    const changingSession = bindingTargetRef.current?.id !== session.id || bindingTargetRef.current.engine !== session.engine;
    const requestGeneration = ++detailGenerationRef.current;
    const selectionGeneration = selectionGenerationRef.current;
    if (changingSession) manualSelectionRef.current = null;
    bindingTargetRef.current = session;
    bindingReadyRef.current = false;
    setBindingReady(false);
    setBindingError(null);
    setSessionId(session.id);
    setSessionSource(session.engine);
    if (changingSession) {
      setMessages([]);
      setSessionModel(null);
      setTurnUsages(new Map());
      assistantIndexRef.current = -1;
    }
    try {
      if (session.engine === "claude") localStorage.setItem(SESSION_KEY, session.id);
      else localStorage.removeItem(SESSION_KEY);
    } catch {}
    if (window.innerWidth < 1024) setSidebarOpen(false);
    try {
      const endpoint = session.engine === "claude"
        ? `/api/claude/sessions/${session.id}`
        : `/api/router/sessions/${session.id}`;

      const detail = await api<SessionDetail>(endpoint);
      // Switching sessions/new chat invalidates both history and binding writes.
      if (requestGeneration !== detailGenerationRef.current) return;
      if (detail.id !== session.id || !Array.isArray(detail.messages)) throw new Error("Invalid session detail");
      const applyBinding = selectionGeneration === selectionGenerationRef.current && manualSelectionRef.current !== session.id;
      if (applyBinding) setSessionModel(detail.model || null);
      if (session.engine === "claude") {
        // A picker choice made while this request was pending wins, but history
        // still hydrates and Send remains gated until that hydration succeeds.
        if (applyBinding) {
          const model = detail.model && detail.model !== "Claude Code" ? detail.model : "default";
          const providerId = detail.provider_id ?? null;
          setSelectedModel(model);
          setSelectedProvider(providerId);
          try {
            localStorage.setItem(MODEL_KEY, model);
            if (providerId) localStorage.setItem(PROVIDER_KEY, providerId);
            else localStorage.removeItem(PROVIDER_KEY);
          } catch {}
        }
        const ws = claudeWsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resume", session_id: session.id }));
      }
      const converted: ChatMsg[] = detail.messages.map((m) => ({ id: uid(), role: m.role, text: m.text }));
      setMessages(converted);

      if (detail.usage && (detail.usage.input_tokens > 0 || detail.usage.total_cost_usd > 0)) {
        const initialMap = new Map<number, TurnUsage>();
        initialMap.set(converted.length - 1, {
          input_tokens: detail.usage.input_tokens,
          output_tokens: detail.usage.output_tokens,
          cache_read_input_tokens: detail.usage.cache_read_input_tokens,
          total_cost_usd: detail.usage.total_cost_usd,
          model: session.model || "",
        });
        setTurnUsages(initialMap);
      } else {
        setTurnUsages(new Map());
      }
      assistantIndexRef.current = -1;
      if (session.engine === "claude") saveMessages(converted);
      bindingReadyRef.current = true;
      setBindingReady(true);
      isAtBottomRef.current = true;
      setTimeout(() => scrollToBottom("instant"), 50);
    } catch {
      if (requestGeneration !== detailGenerationRef.current) return;
      setBindingError("Unable to restore this conversation. Retry or start a new chat before sending.");
    }
  }, [scrollToBottom]);

  // Global last-used picker values may belong to an unrelated conversation.
  useEffect(() => {
    const id = initialSessionRef.current;
    if (id) void loadSessionDetail({ id, engine: "claude" });
    return () => { detailGenerationRef.current++; };
  }, [loadSessionDetail]);

  const deleteSession = useCallback(async (session: UnifiedSession) => {
    try {
      const endpoint = session.engine === "claude"
        ? `/api/claude/sessions/${session.id}`
        : `/api/router/sessions/${session.id}`;

      await api(endpoint, { method: "DELETE" });

      if (session.engine === "claude") {
        setClaudeSessions((prev) => prev.filter((s) => s.id !== session.id));
      } else {
        setRouterSessions((prev) => prev.filter((s) => s.id !== session.id));
      }

      setPinnedIds((prev) => {
        const next = new Set(prev);
        next.delete(session.id);
        try { localStorage.setItem(PINS_KEY, JSON.stringify(Array.from(next))); } catch {}
        return next;
      });

      if (session.id === sessionId) newChat();
    } catch (e) { console.error("Failed to delete session", e); }
  }, [sessionId, newChat]);

  const togglePin = useCallback((id: string) => {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try { localStorage.setItem(PINS_KEY, JSON.stringify(Array.from(next))); } catch {}
      return next;
    });
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (commandPaletteOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCommandIndex((i) => i + 1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCommandIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const q = commandQuery.toLowerCase().trim();
        const clean = q.startsWith("/") ? q : `/${q}`;
        const filtered = CLAUDE_SLASH_COMMANDS.filter(
          (c) =>
            !q ||
            q === "/" ||
            c.name.toLowerCase().includes(clean) ||
            c.description.toLowerCase().includes(q) ||
            c.syntax.toLowerCase().includes(q)
        );
        if (filtered.length > 0) {
          const selected = filtered[commandIndex % filtered.length];
          executeCommand(selected);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setCommandPaletteOpen(false);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const pickImages = () => fileRef.current?.click();

  const onFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    files.forEach((f) => {
      const reader = new FileReader();
      reader.onload = () => {
        const full = reader.result as string;
        const data = full.split(",")[1] ?? "";
        setImages((prev) => [...prev, { id: uid(), mime: f.type || "image/jpeg", data, preview: URL.createObjectURL(f), name: f.name }]);
      };
      reader.readAsDataURL(f);
    });
  };

  const removeImage = (id: string) => {
    setImages((prev) => {
      const target = prev.find((i) => i.id === id);
      if (target) URL.revokeObjectURL(target.preview);
      return prev.filter((i) => i.id !== id);
    });
  };

  const canSend = bindingReady && !isArchived && connState === "idle" && (input.trim().length > 0 || images.length > 0);
  const activeSession = unifiedSessions.find((s) => s.id === sessionId);
  const chatTitle = activeSession?.title ?? (sessionId ? `Session ${sessionId.slice(0, 8)}…` : "New Chat");

  // =========================================================================
  // RENDER
  // =========================================================================

  return (
    <div className="relative flex h-full w-full overflow-hidden" style={{ display: active ? undefined : "none" }}>

      {/* ── Usage History Modal ── */}
      {historyModalOpen && usageData && (
        <UsageHistoryModal
          usage={usageData}
          onClose={() => setHistoryModalOpen(false)}
        />
      )}

      {/* ── Mobile Sidebar Backdrop ── */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ── Sidebar ── */}
      <div inert={!sidebarOpen} className={`claude-sidebar-wrapper border-r border-line ${sidebarOpen ? "" : "claude-sidebar-closed"}`}>
        <Sidebar
          sessions={unifiedSessions}
          loading={sessionsLoading}
          activeSessionId={sessionId}
          isThinking={connState === "thinking"}
          pinnedIds={pinnedIds}
          rateLimit={rateLimit}
          usage={usageData}
          activePeriod={usagePeriod}
          onChangePeriod={setUsagePeriod}
          onOpenHistory={() => setHistoryModalOpen(true)}
          onNewChat={newChat}
          onSelect={loadSessionDetail}
          onDelete={deleteSession}
          onTogglePin={togglePin}
        />
      </div>

      {/* ── Chat column ── */}
      <div className="flex flex-1 min-w-0 flex-col h-full overflow-hidden bg-bg">

        {/* Claude Code is the agent; model selection is independent of its transport. */}
        <header className="agent-toolbar">
          <div className="agent-toolbar-heading">
            <button type="button" onClick={() => setSidebarOpen((o) => !o)} title="Toggle sessions"
              aria-label="Toggle sessions" aria-expanded={sidebarOpen}
              className="agent-icon-button text-muted hover:bg-surface-2 hover:text-fg">
              <Menu size={18} />
            </button>
            <div className="min-w-0 flex-1">
              <h1 className="text-sm font-semibold text-fg truncate">{isArchived ? "Conversation archive" : "Claude Code"}</h1>
              <p className="text-[11px] text-muted truncate">{chatTitle}</p>
            </div>
          </div>
          <div className="agent-toolbar-actions">
            <StatusPill state={connState} />
            <button type="button" onClick={() => setHistoryModalOpen(true)}
              title="Riwayat Penggunaan & Biaya" aria-label="Usage history"
              className="agent-icon-button text-muted hover:bg-surface-2 hover:text-fg">
              <BarChart2 size={17} />
            </button>
            <button type="button" onClick={newChat} title="New chat" aria-label="New chat" disabled={connState === "thinking"}
              className="agent-icon-button text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40">
              <Plus size={19} />
            </button>
          </div>
          <div className="agent-toolbar-context">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0 text-[10px] text-muted uppercase tracking-wider">Model</span>
              {!isArchived ? (
                <ModelPicker models={agentModels} providers={modelProviders}
                  value={{model:selectedModel,provider_id:selectedProvider}}
                  disabled={connState === "thinking"} loading={modelsLoading} error={modelsError}
                  onSelect={selectModel} onRefresh={() => loadModels(true)} />
              ) : <span className="truncate text-xs text-fg-2">{formatModelBadge(sessionModel || activeSession?.model || selectedModel)}</span>}
            </div>
            {sessionTotalTokens > 0 && (
              <button type="button" onClick={() => setHistoryModalOpen(true)} title="Session usage"
                className="agent-session-usage shrink-0 font-mono text-[10px] sm:text-[11px] text-muted tabular-nums">
                {sessionTotalCost > 0 && <span>{formatCost(sessionTotalCost)} · </span>}
                {formatTokens(sessionTotalTokens)} tok
              </button>
            )}
          </div>
        </header>

        {/* Messages — scrollable */}
        <div className="relative flex-1 min-h-0">
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="absolute inset-0 overflow-y-auto overscroll-contain px-3 sm:px-5 py-4"
          >
            {messages.length === 0 && connState !== "connecting" && (
              <div className="flex h-full items-center justify-center px-2 sm:px-6">
                <div className="w-full max-w-md text-left">
                  <div className="mb-4 flex items-center gap-2 text-xs font-medium text-accent">
                    <Bot size={18} /> Claude Code Agent
                  </div>
                  <h2 className="text-xl sm:text-2xl font-semibold tracking-tight text-fg">What are we working on?</h2>
                  <p className="mt-3 text-sm leading-relaxed text-muted">
                    Inspect files, run commands, and build in one conversation. Choose a model, then describe the task below.
                  </p>
                </div>
              </div>
            )}

            {messages.map((msg, idx) => {
              const usage = turnUsages.get(idx);
              return (
                <div key={msg.id} className={`mb-3 flex gap-2.5 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
                  {/* Avatar */}
                  <div className={`mt-1 flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                    msg.role === "user"
                      ? "bg-accent text-bg"
                      : "bg-surface-2 text-accent"
                  }`}>
                    {msg.role === "user" ? "U" : <Bot size={14} />}
                  </div>

                  {/* Bubble + usage */}
                  <div className={`flex min-w-0 flex-col max-w-[85%] ${msg.role === "user" ? "items-end" : "items-start"}`}>
                    <div className={`chat-message-bubble rounded-xl px-3 py-2.5 ${
                      msg.role === "user"
                        ? "rounded-tr-sm bg-accent/15 text-fg"
                        : msg.error
                        ? "rounded-tl-sm border border-bad/30 bg-bad/10 text-fg-2"
                        : "rounded-tl-sm border border-line bg-surface text-fg"
                    }`}>
                      {msg.images && msg.images.length > 0 && (
                        <div className="mb-2 flex flex-wrap gap-2">
                          {msg.images.map((img, i) => (
                            <img key={i} src={img.preview} alt="" className="max-h-40 max-w-full rounded-lg object-contain border border-line" />
                          ))}
                        </div>
                      )}
                      {msg.thinking && !msg.text && !activeTool ? (
                        <div className="flex items-center gap-2 text-sm text-accent font-medium">
                          <Loader size={14} className="animate-spin text-accent" />
                          <span>Sedang memproses & menganalisis…</span>
                        </div>
                      ) : msg.role === "assistant" ? (
                        <>
                          {msg.text && <MarkdownMsg text={msg.text} />}
                          {/* Realtime active tool execution card */}
                          {activeTool && idx === messages.length - 1 && (
                            <div className="my-2.5 flex items-center justify-between rounded-xl border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-accent shadow-sm animate-in fade-in duration-200">
                              <div className="flex items-center gap-2 min-w-0 font-mono">
                                <Loader size={13} className="animate-spin text-accent shrink-0" />
                                <span className="font-semibold text-fg shrink-0">⚙️ {activeTool.tool || "Bash"}:</span>
                                <code className="text-accent truncate font-normal max-w-[190px] sm:max-w-md">{activeTool.command}</code>
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0 pl-2">
                                <span className="relative flex size-2">
                                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75"></span>
                                  <span className="relative inline-flex size-2 rounded-full bg-accent"></span>
                                </span>
                                <span className="font-semibold text-[10px] text-accent tracking-wide uppercase">
                                  Sedang Berjalan…
                                </span>
                              </div>
                            </div>
                          )}
                          {idx === messages.length - 1 && connState === "thinking" && !activeTool && (
                            <div className="mt-2.5 pt-2 border-t border-line/40 flex items-center gap-2 text-xs text-accent font-medium animate-pulse">
                              <span className="relative flex size-2">
                                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75"></span>
                                <span className="relative inline-flex size-2 rounded-full bg-accent"></span>
                              </span>
                              <span>Sedang menulis respons…</span>
                            </div>
                          )}
                        </>
                      ) : (
                        <p className="whitespace-pre-wrap text-sm">{msg.text}</p>
                      )}
                    </div>

                    {msg.role === "assistant" && !msg.thinking && usage && (
                      <div className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-muted tabular-nums">
                        <span>↑{usage.input_tokens.toLocaleString()}</span>
                        <span className="opacity-40">·</span>
                        <span>↓{usage.output_tokens.toLocaleString()}</span>
                        {usage.total_cost_usd > 0 && (
                          <>
                            <span className="opacity-40">·</span>
                            <span>${usage.total_cost_usd.toFixed(4)}</span>
                          </>
                        )}
                        {usage.model && (
                          <>
                            <span className="opacity-40">·</span>
                            <span className="text-muted/60">{formatModelBadge(usage.model)}</span>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Scroll to bottom button */}
          {showScrollBtn && (
            <button
              type="button"
              onClick={() => { isAtBottomRef.current = true; scrollToBottom(); }}
              className="absolute bottom-3 right-4 z-10 flex size-9 cursor-pointer items-center justify-center rounded-full border border-line bg-surface shadow-lg text-muted transition-all hover:bg-surface-2 hover:text-fg"
              title="Scroll to bottom" aria-label="Scroll to bottom"
            >
              <ArrowDown size={16} />
            </button>
          )}
        </div>

        {/* Compose area — pinned at bottom */}
        <div className="agent-compose-panel border-t border-line bg-bg px-2.5 py-2 sm:px-4 sm:py-3 shrink-0">
          {!bindingReady && (
            <div role={bindingError ? "alert" : "status"} className="mb-2 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-muted">
              <p>{bindingError || "Restoring conversation binding…"}</p>
              {bindingError && <div className="mt-2 flex gap-3">
                <button type="button" onClick={() => { if (bindingTargetRef.current) void loadSessionDetail(bindingTargetRef.current); }} className="text-accent">Retry session</button>
                <button type="button" onClick={newChat} className="text-accent">Start new chat</button>
              </div>}
            </div>
          )}
          {/* Live conversation running banner */}
          {connState === "thinking" && (
            <div className="mb-2 flex items-center justify-between rounded-xl border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs text-accent shadow-sm animate-in fade-in duration-200">
              <div className="flex items-center gap-2 font-medium min-w-0">
                <span className="relative flex size-2 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75"></span>
                  <span className="relative inline-flex size-2 rounded-full bg-accent"></span>
                </span>
                <span className="truncate">Percakapan sedang berjalan · Jangan kirim pesan baru</span>
              </div>
              <button
                type="button"
                onClick={interrupt}
                className="shrink-0 flex items-center gap-1 rounded-md bg-bad/20 hover:bg-bad/30 text-bad px-2 py-0.5 font-medium transition-colors cursor-pointer text-[11px]"
                title="Hentikan percakapan saat ini"
              >
                <Square size={10} /> Stop
              </button>
            </div>
          )}

          {images.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {images.map((img) => (
                <div key={img.id} className="relative">
                  <img src={img.preview} alt={img.name} className="h-14 w-14 sm:h-16 sm:w-16 rounded-lg object-cover border border-line" />
                  <button type="button" onClick={() => removeImage(img.id)}
                    className="absolute -right-1.5 -top-1.5 grid size-5 cursor-pointer place-items-center rounded-full bg-surface-2 border border-line text-muted hover:text-fg">
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {isArchived && (
            <div className="mb-2 rounded-lg border border-line bg-surface px-3 py-2 text-xs leading-relaxed text-muted">
              This conversation is read-only. Start a new chat to work with Claude Code.
            </div>
          )}
          {/* Feedback Suggestions when assistant asks a question or gives choices */}
          <FeedbackSuggestions
            lastMessageText={connState === "idle" && messages.length > 0 && messages[messages.length - 1]?.role === "assistant" ? messages[messages.length - 1]?.text : undefined}
            disabled={connState === "thinking" || isArchived || !bindingReady}
            onSelect={(suggestion) => {
              send(suggestion);
            }}
          />

          <div className="agent-composer relative flex items-end gap-1.5 sm:gap-2">
            <CommandPalette
              open={commandPaletteOpen && !isArchived && connState !== "thinking"}
              query={commandQuery}
              selectedIndex={commandIndex}
              onSelect={executeCommand}
              onClose={() => setCommandPaletteOpen(false)}
            />

            {!isArchived && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setCommandPaletteOpen((prev) => !prev);
                    setCommandQuery("/");
                    setCommandIndex(0);
                    textareaRef.current?.focus();
                  }}
                  title="Perintah Claude Code (/)"
                  aria-label="Claude Code commands"
                  disabled={connState === "thinking"}
                  className="mb-0.5 grid size-9 shrink-0 cursor-pointer place-items-center rounded-lg text-muted font-mono font-bold text-sm transition-colors hover:bg-surface-2 hover:text-accent"
                >
                  /
                </button>
                <button type="button" onClick={pickImages} title="Attach image" aria-label="Attach image" disabled={connState === "thinking"}
                  className="mb-0.5 grid size-9 shrink-0 cursor-pointer place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg">
                  <Image size={18} />
                </button>
                <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={onFiles} />
              </>
            )}

            <textarea
              ref={textareaRef}
              value={input}
              disabled={isArchived || connState === "thinking"}
              aria-label="Message Claude Code" name="message" autoComplete="off"
              onChange={(e) => {
                const val = e.target.value;
                setInput(val);
                if (val.startsWith("/")) {
                  setCommandPaletteOpen(true);
                  setCommandQuery(val);
                  setCommandIndex(0);
                } else {
                  setCommandPaletteOpen(false);
                }
              }}
              onKeyDown={onKeyDown}
              placeholder={
                isArchived ? "Archived conversation"
                  : connState === "thinking" ? "Claude Code is working…"
                  : "Message Claude Code…"
              }
              rows={1}
              className={`flex-1 resize-none rounded-xl border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none transition-opacity ${
                connState === "thinking" ? "opacity-60 cursor-not-allowed bg-surface/50" : ""
              }`}
              style={{ maxHeight: 160 }}
            />

            {connState === "thinking" ? (
              <button type="button" onClick={interrupt} title="Stop generation" aria-label="Stop generation"
                className="mb-0.5 grid size-9 shrink-0 cursor-pointer place-items-center rounded-lg bg-bad/10 text-bad transition-colors hover:bg-bad/20">
                <Square size={16} />
              </button>
            ) : (
              <button type="button" onClick={send} disabled={!canSend} title="Send (Enter)" aria-label="Send message"
                className="mb-0.5 grid size-9 shrink-0 cursor-pointer place-items-center rounded-lg bg-accent text-bg transition-colors hover:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-40">
                <Send size={16} />
              </button>
            )}
          </div>
          <p className="mt-1 text-center text-[10px] text-muted truncate">
            {isArchived ? "Saved conversation · read-only" : "Claude Code · Ketik / untuk perintah · Enter to send · Shift+Enter for a new line"}
          </p>
        </div>
      </div>
    </div>
  );
}

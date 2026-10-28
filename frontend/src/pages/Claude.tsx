import { ArrowDown, BarChart2, Bot, Folder, Image, Loader, Lock, LockOpen, Menu, PanelRight, Plus, Send, Square, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { CommandPalette } from "../components/CommandPalette";
import { FeedbackSuggestions } from "../components/FeedbackSuggestions";
import { ModelPicker } from "../components/ModelPicker";
import type { AgentModel, ModelSelection, Provider, ProviderCatalog } from "../provider-types";
import { findPageCommand, helpMarkdown, slashItems, type PaletteItem } from "../claude/commands";
import { FolderPicker, type FolderChoice } from "../claude/FolderPicker";
import { formatCost, formatModelBadge, formatTokens, shortPath } from "../claude/format";
import { legacyTextToParts, partsToText } from "../claude/markdown";
import { MemoryModal } from "../claude/MemoryModal";
import { ModelLivePanel } from "../claude/ModelLivePanel";
import { MessageParts, NoticeRow } from "../claude/MessageView";
import { Sidebar, type SessionSource, type UnifiedSession } from "../claude/Sidebar";
import { PlanLimitsChip, usePlanLimits } from "../claude/PlanLimits";
import { UsageHistoryModal, mergeUsage, type UsagePeriod, type UsageResponse } from "../claude/Usage";
import { EMPTY_USAGE, UsageBar, addUsage, toUsage } from "../claude/UsageBar";
import {
  EFFORT_LEVELS, PERMISSION_MODES,
  type Capabilities, type ChatMsg, type InitInfo, type Part, type PermissionMode, type SessionUsage, type TurnUsage,
} from "../claude/types";

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

const SESSION_KEY = "claude.chat.session_id";
const LEGACY_MSGS_KEY = "claude.chat.messages";
const PINS_KEY = "claude.chat.pinned";
const MODEL_KEY = "chat.selected_model";
const PROVIDER_KEY = "chat.selected_provider";
const MODE_KEY = "claude.chat.permission_mode";
const EFFORT_KEY = "claude.chat.effort";
const PROMPTS_KEY = "claude.chat.prompt_history";
const FOLDER_KEY = "claude.chat.folder";
const LOCK_KEY = "claude.chat.locked";
const PANEL_KEY = "claude.chat.model_panel";

type ConnState = "connecting" | "idle" | "thinking" | "error" | "closed";

interface ImageAttach { id: string; mime: string; data: string; preview: string; name: string }

interface ClaudeSession {
  id: string; title: string; model?: string; provider_id?: string | null; provider?: string;
  created_at: number; updated_at: number; message_count: number; size_bytes: number; project: string; running?: boolean;
  cwd?: string; locked?: boolean;
}

interface RouterSession {
  id: string; model: string; title: string; created_at: number; updated_at: number;
  total_tokens: number; total_cost_usd: number; message_count: number;
}

interface HistoryEvent {
  session_id: string;
  title?: string;
  messages: { role: ChatMsg["role"]; parts: Part[]; model?: string }[];
  usage?: SessionUsage;
  model?: string;
  provider_id?: string | null;
  cwd?: string | null;
  locked?: boolean;
  missing?: boolean;
}

interface RouterDetail { id: string; model?: string; messages: { role: "user" | "assistant"; text: string }[] }

const MODE_INFO: Record<PermissionMode, { label: string; icon: string; cls: string }> = {
  bypassPermissions: { label: "bypass permissions", icon: "⏵⏵", cls: "text-bad" },
  acceptEdits: { label: "accept edits", icon: "⏵⏵", cls: "text-accent" },
  plan: { label: "plan mode", icon: "⏸", cls: "text-warn" },
};
const MODE_ARGS: Record<string, PermissionMode> = {
  bypass: "bypassPermissions", bypasspermissions: "bypassPermissions", yolo: "bypassPermissions",
  edits: "acceptEdits", acceptedits: "acceptEdits", accept: "acceptEdits", plan: "plan",
};

let _mid = 0;
const uid = () => `m${++_mid}`;

function load(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function store(key: string, value: string | null) {
  try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* private mode */ }
}

function userParts(text: string, images: { preview?: string }[] = []): Part[] {
  const parts: Part[] = images.map((i) => ({ kind: "image", preview: i.preview }));
  const cmd = text.match(/^(\/[\w:.-]+)(?:\s+([\s\S]*))?$/);
  if (cmd) parts.push({ kind: "command", name: cmd[1], args: (cmd[2] ?? "").trim() });
  else if (text) parts.push({ kind: "text", text });
  return parts;
}

function modelLabel(model: string | undefined): string {
  if (!model || model === "local") return "";
  return formatModelBadge(model);
}

function StatusPill({ state }: { state: ConnState }) {
  if (state === "idle" || state === "thinking") return null;
  const map = {
    connecting: { label: "Connecting…", cls: "bg-surface-2 text-muted" },
    error: { label: "Error", cls: "bg-bad/10 text-bad" },
    closed: { label: "Disconnected", cls: "bg-bad/10 text-bad" },
  } as const;
  const { label, cls } = map[state];
  return (
    <span role="status" data-connection-status className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${cls}`}>
      {state === "connecting" && <Loader size={10} className="animate-spin" />}
      {label}
    </span>
  );
}

/** "12s" counter for the running turn, ticking without re-rendering the page. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return <>{s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`}</>;
}

function RunningDot() {
  return (
    <span className="relative flex size-2 shrink-0">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
      <span className="relative inline-flex size-2 rounded-full bg-accent" />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function Claude({ active, onRunningChange }: { active: boolean; onRunningChange?: (running: boolean) => void }) {
  // Conversations run in Claude Code; archived router chats are read-only.
  const [sessionSource, setSessionSource] = useState<SessionSource>("claude");
  const isArchived = sessionSource === "router";

  // Model, provider and how the next turn runs
  const [selectedModel, setSelectedModel] = useState<string>(() => load(MODEL_KEY) || "default");
  const [selectedProvider, setSelectedProvider] = useState<string | null>(() => load(PROVIDER_KEY));
  const [mode, setModeState] = useState<PermissionMode>(() => {
    const saved = load(MODE_KEY) as PermissionMode | null;
    return saved && PERMISSION_MODES.includes(saved) ? saved : "bypassPermissions";
  });
  const [effort, setEffortState] = useState<string>(() => load(EFFORT_KEY) || "");
  const modeBeforePlanRef = useRef<PermissionMode>("bypassPermissions");
  const [agentModels, setAgentModels] = useState<AgentModel[]>([]);
  const [modelProviders, setModelProviders] = useState<Provider[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const manualSelectionRef = useRef<string | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [initInfo, setInitInfo] = useState<InitInfo | null>(null);
  // Folder: a new chat starts in the one picked here (null = home); a session keeps its own.
  const [newFolder, setNewFolder] = useState<string | null>(() => load(FOLDER_KEY));
  const [sessionFolder, setSessionFolder] = useState<string | null>(null);
  const [locked, setLockedState] = useState(() => load(LOCK_KEY) === "1");
  const [folderOpen, setFolderOpen] = useState(false);

  // Conversation
  const [sessionId, setSessionIdState] = useState<string | null>(() => load(SESSION_KEY));
  const sessionIdRef = useRef(sessionId);
  const setSessionId = useCallback((id: string | null) => {
    sessionIdRef.current = id;
    setSessionIdState(id);
    if (sessionSourceRef.current === "claude") store(SESSION_KEY, id);
  }, []);
  const sessionSourceRef = useRef<SessionSource>("claude");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const liveIdRef = useRef<string | null>(null);
  const [historyTitle, setHistoryTitle] = useState<string | null>(null);
  const [bindingReady, setBindingReady] = useState(!sessionId);
  const bindingReadyRef = useRef(!sessionId);
  const [bindingError, setBindingError] = useState<string | null>(null);
  // After asking for another session, drop events until its history arrives (they belong to the old one).
  const resyncRef = useRef<{ target: string | null; waiting: boolean }>({ target: sessionId, waiting: true });

  // Composer
  const [input, setInput] = useState("");
  const [images, setImages] = useState<ImageAttach[]>([]);
  const [caret, setCaret] = useState(0);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [paletteDismissed, setPaletteDismissed] = useState<string | null>(null);
  const [fileItems, setFileItems] = useState<PaletteItem[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [memoryNote, setMemoryNote] = useState<string | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [bashRunning, setBashRunning] = useState(false);
  // Like the terminal: a prompt sent while a turn runs waits and goes out when it ends.
  const [queued, setQueued] = useState<string | null>(null);
  const pendingBashRef = useRef<string[]>([]);
  const promptsRef = useRef<string[]>((() => { try { return JSON.parse(load(PROMPTS_KEY) || "[]"); } catch { return []; } })());
  const promptPosRef = useRef(-1);
  const draftRef = useRef("");

  // Connection & turn state
  const [connState, setConnState] = useState<ConnState>("connecting");
  const connStateRef = useRef(connState);
  connStateRef.current = connState;
  const [turnStartedAt, setTurnStartedAt] = useState(Date.now());
  const [activity, setActivity] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const effortRef = useRef<HTMLSelectElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Sessions, usage
  const [claudeSessions, setClaudeSessions] = useState<ClaudeSession[]>([]);
  const [routerSessions, setRouterSessions] = useState<RouterSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 1024);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(load(PINS_KEY) || "[]") as string[]); } catch { return new Set(); }
  });
  const planLimits = usePlanLimits(active);
  const { accept: acceptLimits, refresh: refreshLimits } = planLimits;
  const [turnUsages, setTurnUsages] = useState<Map<string, TurnUsage>>(new Map());
  const [sessionUsage, setSessionUsage] = useState<SessionUsage>(EMPTY_USAGE);
  const [claudeUsage, setClaudeUsage] = useState<UsageResponse | null>(null);
  const [routerUsage, setRouterUsage] = useState<UsageResponse | null>(null);
  const [usagePeriod, setUsagePeriod] = useState<UsagePeriod>("all_time");
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(() => (load(PANEL_KEY) ?? (window.innerWidth >= 1280 ? "1" : "0")) === "1");
  useEffect(() => { store(PANEL_KEY, panelOpen ? "1" : "0"); }, [panelOpen]);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const isAtBottomRef = useRef(true);

  const running = connState === "thinking";
  const busy = running || bashRunning;
  const folder = sessionId ? sessionFolder : newFolder;

  useEffect(() => { onRunningChange?.(running); }, [running, onRunningChange]);
  useEffect(() => { store(LEGACY_MSGS_KEY, null); }, []);
  useEffect(() => {
    if (!running) return;
    const prev = document.title;
    document.title = "● Running… | Lufria Monitor";
    return () => { document.title = prev || "Lufria Monitor"; };
  }, [running]);

  const setMode = useCallback((next: PermissionMode) => {
    setModeState((prev) => {
      if (next === "plan" && prev !== "plan") modeBeforePlanRef.current = prev;
      return next;
    });
    store(MODE_KEY, next);
  }, []);
  const cycleMode = useCallback(() => {
    setMode(PERMISSION_MODES[(PERMISSION_MODES.indexOf(mode) + 1) % PERMISSION_MODES.length]);
  }, [mode, setMode]);
  const setEffort = useCallback((value: string) => { setEffortState(value); store(EFFORT_KEY, value || null); }, []);
  const setLocked = useCallback((value: boolean) => { setLockedState(value); store(LOCK_KEY, value ? "1" : null); }, []);

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------

  const loadModels = useCallback(async (refresh = false) => {
    setModelsLoading(true);
    setModelsError(null);
    try {
      const data = await api<ProviderCatalog>(refresh ? "/api/providers/refresh" : "/api/providers", refresh ? { method: "POST" } : undefined);
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

  const loadUsage = useCallback(async () => {
    const [c, r] = await Promise.allSettled([api<UsageResponse>("/api/claude/usage"), api<UsageResponse>("/api/router/usage")]);
    if (c.status === "fulfilled") setClaudeUsage(c.value);
    if (r.status === "fulfilled") setRouterUsage(r.value);
  }, []);

  const loadSessions = useCallback(async () => {
    const [c, r] = await Promise.allSettled([api<ClaudeSession[]>("/api/claude/sessions"), api<RouterSession[]>("/api/router/sessions")]);
    if (c.status === "fulfilled") setClaudeSessions(c.value);
    if (r.status === "fulfilled") setRouterSessions(r.value);
    setSessionsLoading(false);
  }, []);

  // Commands, skills and memory paths depend on the folder.
  const loadCaps = useCallback(async (refresh = false) => {
    const params = new URLSearchParams();
    if (folder) params.set("cwd", folder);
    if (refresh) params.set("refresh", "1");
    try { setCaps(await api<Capabilities>(`/api/claude/capabilities?${params}`)); } catch { /* palette falls back to page commands */ }
  }, [folder]);

  useEffect(() => {
    void loadSessions();
    void loadUsage();
    void loadModels();
  }, [loadSessions, loadUsage, loadModels]);
  useEffect(() => { void loadCaps(); }, [loadCaps]);

  const refreshLater = useRef<ReturnType<typeof setTimeout>>(undefined);
  const refreshLists = useCallback(() => {
    clearTimeout(refreshLater.current);
    refreshLater.current = setTimeout(() => { void loadSessions(); void loadUsage(); }, 800);
  }, [loadSessions, loadUsage]);

  const selectModel = useCallback((selection: ModelSelection) => {
    if (connStateRef.current === "thinking") return;
    setSelectedModel(selection.model);
    setSelectedProvider(selection.provider_id);
    manualSelectionRef.current = sessionIdRef.current || "new";
    store(MODEL_KEY, selection.model);
    store(PROVIDER_KEY, selection.provider_id);
  }, []);

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

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

  useEffect(() => { if (isAtBottomRef.current) scrollToBottom("instant"); }, [messages, scrollToBottom]);

  const appendMsg = useCallback((msg: ChatMsg) => setMessages((prev) => [...prev, msg]), []);

  /** Update the assistant message of the running turn, creating it if output arrives first. */
  const patchLive = useCallback((fn: (m: ChatMsg) => ChatMsg) => {
    if (!liveIdRef.current) {
      const id = uid();
      liveIdRef.current = id;
      setMessages((prev) => [...prev, { id, role: "assistant", parts: [], pending: true }]);
    }
    const id = liveIdRef.current;
    setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));
  }, []);

  const appendLocal = useCallback((command: string, markdown: string) => {
    setMessages((prev) => [...prev,
      { id: uid(), role: "user", parts: userParts(command), local: true },
      { id: uid(), role: "assistant", parts: [{ kind: "text", text: markdown }], local: true, model: "local" }]);
    isAtBottomRef.current = true;
  }, []);

  const notice = useCallback((text: string, level: "info" | "warn" | "error" = "info") => {
    setMessages((prev) => [...prev, { id: uid(), role: "system", parts: [{ kind: "notice", text, level }], local: true }]);
    isAtBottomRef.current = true;
  }, []);

  const finishTurn = useCallback(() => {
    const id = liveIdRef.current;
    liveIdRef.current = null;
    setActivity(null);
    if (!id) return;
    setMessages((prev) => prev.flatMap((m) => {
      if (m.id !== id) return [m];
      const parts = m.streaming ? [...m.parts, { kind: "text" as const, text: m.streaming }] : m.parts;
      return parts.length ? [{ ...m, parts, streaming: undefined, pending: false }] : [];
    }));
  }, []);

  // -------------------------------------------------------------------------
  // WebSocket events
  // -------------------------------------------------------------------------

  const applyHistory = useCallback((h: HistoryEvent) => {
    const converted: ChatMsg[] = h.messages.map((m) => ({ id: uid(), role: m.role, parts: m.parts, model: m.model }));
    liveIdRef.current = null;
    setMessages(converted);
    setHistoryTitle(h.title || null);
    setTurnUsages(new Map());
    setSessionUsage(toUsage(h.usage));
    setSessionFolder(h.cwd ?? null);
    if (h.session_id) setLockedState(Boolean(h.locked));
    if (h.missing) {
      // The transcript is gone (deleted elsewhere): continue as a new chat.
      sessionIdRef.current = null;
      setSessionIdState(null);
      store(SESSION_KEY, null);
    } else if (manualSelectionRef.current !== h.session_id) {
      // Continue with whatever model and provider the last turn used.
      const model = h.model && h.model !== "Claude Code" ? h.model : "default";
      setSelectedModel(model);
      setSelectedProvider(h.provider_id ?? null);
      store(MODEL_KEY, model);
      store(PROVIDER_KEY, h.provider_id ?? null);
    }
    bindingReadyRef.current = true;
    setBindingReady(true);
    setBindingError(null);
    isAtBottomRef.current = true;
    setTimeout(() => scrollToBottom("instant"), 50);
  }, [scrollToBottom]);

  const handleEvent = useCallback((raw: string) => {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(raw); } catch { return; }
    const type = obj.type as string;
    const resync = resyncRef.current;

    if (type === "history") {
      if (obj.session_id !== resync.target) return;
      resync.waiting = false;
      applyHistory(obj as unknown as HistoryEvent);
      return;
    }
    if (type === "attached") {
      if ((obj.session_id ?? null) !== resync.target) return;
      resync.waiting = false;
      bindingReadyRef.current = true;
      setBindingReady(true);
      if (!obj.running) { finishTurn(); setConnState("idle"); }
      return;
    }
    if (resync.waiting) return;

    switch (type) {
      case "status": {
        const state = obj.state as ConnState;
        if (state === "thinking") setConnState("thinking");
        else if (state === "idle") {
          if (obj.msg === "ready") { if (!liveIdRef.current) setConnState("idle"); return; }
          finishTurn();
          setConnState("idle");
          refreshLists();
        } else if (state === "error") {
          notice(String(obj.msg || "Something went wrong."), "error");
          if (!liveIdRef.current) setConnState("idle");
        }
        return;
      }
      case "session": {
        const sid = obj.session_id as string;
        if (sid) { setSessionId(sid); refreshLists(); }
        return;
      }
      case "turn_start": {
        const clientId = obj.client_id as string | null;
        const id = uid();
        liveIdRef.current = id;
        setMessages((prev) => {
          const mine = clientId && prev.some((m) => m.clientId === clientId);
          const user: ChatMsg[] = mine ? [] : [{ id: uid(), role: "user", clientId: clientId ?? undefined,
            parts: userParts(String(obj.text ?? ""), Array.from({ length: Number(obj.images) || 0 }, () => ({}))) }];
          return [...prev, ...user, { id, role: "assistant", parts: [], pending: true }];
        });
        setConnState("thinking");
        setTurnStartedAt(Date.now());
        setActivity(null);
        if (typeof obj.cwd === "string") setSessionFolder(obj.cwd);
        if (typeof obj.locked === "boolean") setLockedState(obj.locked);
        return;
      }
      case "system": {
        const sub = obj.subtype as string;
        if (sub === "init") {
          setInitInfo(obj as InitInfo);
          const sid = obj.session_id as string | undefined;
          if (sid && !sessionIdRef.current) setSessionId(sid);
        } else if (sub === "compact_boundary") {
          patchLive((m) => ({ ...m, pending: false, parts: [...m.parts, { kind: "notice", text: "Conversation compacted", level: "info" }] }));
        } else if (sub === "api_retry") {
          setActivity(`Retrying (attempt ${obj.attempt ?? "?"})`);
        } else if (sub === "status" && typeof obj.status === "string" && obj.status) {
          setActivity(obj.status.charAt(0).toUpperCase() + obj.status.slice(1));
        } else if (sub === "informational" && obj.content) {
          const text = String(obj.content);
          patchLive((m) => ({ ...m, parts: [...m.parts, { kind: "notice", text, level: "warn" }] }));
        }
        return;
      }
      case "stream_event": {
        if (obj.parent_tool_use_id) return;
        const ev = obj.event as { type?: string; delta?: { type?: string; text?: string }; content_block?: { type?: string } };
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          const t = ev.delta.text;
          patchLive((m) => ({ ...m, pending: false, streaming: (m.streaming ?? "") + t }));
          setActivity(null);
        } else if (ev?.type === "content_block_start" && ev.content_block?.type === "thinking") {
          setActivity("Thinking");
        }
        return;
      }
      case "assistant": {
        if (obj.parent_tool_use_id) return;
        if (obj.error || obj.is_api_error_message) {
          const text = String(obj.error || "API error");
          patchLive((m) => ({ ...m, pending: false, streaming: undefined, parts: [...m.parts, { kind: "text", text, is_error: true }] }));
          return;
        }
        const message = obj.message as { model?: string; content?: { type?: string; text?: string; thinking?: string }[];
          usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } | undefined;
        const synthetic = message?.model === "<synthetic>";
        const u = message?.usage;
        if (u && !synthetic) {
          const context = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          if (context) setSessionUsage((prev) => ({ ...prev, context_tokens: context }));
        }
        // The CLI's placeholder after an interrupt; the TUI doesn't show it either.
        if (synthetic && message?.content?.every((b) => b.type !== "text" || b.text?.trim() === "No response requested.")) return;
        const add: Part[] = [];
        for (const block of message?.content ?? []) {
          if (block.type === "text" && block.text?.trim()) {
            // Local command output (/context, /usage, …) comes back as a synthetic message.
            add.push(synthetic ? { kind: "command_output", text: block.text } : { kind: "text", text: block.text });
          } else if (block.type === "thinking" && block.thinking?.trim()) {
            add.push({ kind: "thinking", text: block.thinking });
          }
        }
        const model = message?.model && !synthetic ? message.model : undefined;
        if (add.length || model) {
          patchLive((m) => ({ ...m, pending: false, model: model ?? m.model ?? (synthetic ? "local" : undefined),
            streaming: add.some((p) => p.kind === "text" || p.kind === "command_output") ? undefined : m.streaming,
            parts: [...m.parts, ...add] }));
        }
        if (add.length) setActivity(null);
        return;
      }
      case "tool_start": {
        const part = (obj.part as Part | undefined) ?? { kind: "tool", id: String(obj.id), name: String(obj.tool || "Tool"),
          summary: String(obj.command || ""), output: "", is_error: false, done: false };
        patchLive((m) => ({ ...m, pending: false, parts: [...m.parts, part] }));
        setActivity(null);
        return;
      }
      case "tool_done": {
        const id = String(obj.id || "");
        setMessages((prev) => {
          for (let i = prev.length - 1; i >= 0 && i >= prev.length - 6; i--) {
            const idx = prev[i].parts.findIndex((p) => p.kind === "tool" && p.id === id);
            if (idx >= 0) {
              const next = [...prev];
              const parts = [...next[i].parts];
              parts[idx] = { ...(parts[idx] as Extract<Part, { kind: "tool" }>), output: String(obj.output ?? ""), is_error: Boolean(obj.is_error), done: true };
              next[i] = { ...next[i], parts };
              return next;
            }
          }
          return prev;
        });
        return;
      }
      case "result": {
        const denials = (obj.permission_denials as { tool_name?: string }[] | undefined) ?? [];
        const extra: Part[] = [];
        if (denials.length) {
          const names = [...new Set(denials.map((d) => d.tool_name).filter((n) => n && n !== "ExitPlanMode"))];
          if (names.length) extra.push({ kind: "notice", level: "warn", text: `Blocked by permission mode: ${names.join(", ")}` });
        }
        if (obj.is_error && obj.subtype !== "success" && obj.subtype !== "error_during_execution") {
          extra.push({ kind: "notice", level: "error", text: `Turn ended: ${String(obj.subtype).replace(/_/g, " ")}` });
        }
        if (extra.length) patchLive((m) => ({ ...m, parts: [...m.parts, ...extra] }));
        void refreshLimits(); // after an official turn the server asks Claude Code for the scoped rows too
        return;
      }
      case "turn_usage": {
        const usage: TurnUsage = { ...toUsage(obj as Partial<SessionUsage>), model: String(obj.model || "") };
        setSessionUsage((prev) => addUsage(prev, usage));
        const id = liveIdRef.current;
        if (id) setTurnUsages((prev) => new Map(prev).set(id, usage));
        return;
      }
      case "plan_limits":
        acceptLimits(obj);
        return;
      case "bash_result": {
        const clientId = obj.client_id as string;
        const result = { stdout: String(obj.stdout ?? ""), stderr: String(obj.stderr ?? ""), code: obj.code as number | null };
        setMessages((prev) => prev.map((m) => m.clientId === clientId
          ? { ...m, parts: m.parts.map((p) => (p.kind === "bash" ? { ...p, ...result, running: false } : p)) } : m));
        // Real Claude Code puts bash-mode output in the conversation; here it rides along with the next prompt.
        pendingBashRef.current.push(`<bash-input>${obj.command}</bash-input>\n<bash-stdout>${result.stdout}</bash-stdout><bash-stderr>${result.stderr}</bash-stderr>`);
        setBashRunning(false);
        return;
      }
    }
  }, [acceptLimits, applyHistory, finishTurn, notice, patchLive, refreshLimits, refreshLists, setSessionId]);

  const handleRef = useRef(handleEvent);
  handleRef.current = handleEvent;

  const resume = useCallback((id: string | null) => {
    resyncRef.current = { target: id, waiting: true };
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resume", session_id: id ?? "" }));
  }, []);

  const connect = useCallback(() => {
    setConnState("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/claude`);
    wsRef.current = ws;
    ws.onopen = () => {
      if (sessionSourceRef.current === "claude") {
        resyncRef.current = { target: sessionIdRef.current, waiting: true };
        ws.send(JSON.stringify({ type: "resume", session_id: sessionIdRef.current ?? "" }));
      } else setConnState("idle");
    };
    ws.onmessage = (ev) => { if (typeof ev.data === "string") handleRef.current(ev.data); };
    ws.onclose = () => {
      setConnState("closed");
      setBashRunning(false);
      reconnectRef.current = setTimeout(connect, 3000);
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectRef.current);
      const ws = wsRef.current;
      if (ws) { ws.onclose = null; ws.close(); }
    };
  }, [connect]);

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  const resetView = useCallback(() => {
    liveIdRef.current = null;
    pendingBashRef.current = [];
    setMessages([]);
    setTurnUsages(new Map());
    setSessionUsage(EMPTY_USAGE);
    setSessionFolder(null);
    setHistoryTitle(null);
    setActivity(null);
    setBashRunning(false);
  }, []);

  const newChat = useCallback(() => {
    if (window.innerWidth < 1024) setSidebarOpen(false);
    sessionSourceRef.current = "claude";
    setSessionSource("claude");
    manualSelectionRef.current = null;
    setSessionId(null);
    resetView();
    setLockedState(load(LOCK_KEY) === "1");
    setQueued(null);
    bindingReadyRef.current = true;
    setBindingReady(true);
    setBindingError(null);
    setInput("");
    setImages((prev) => { prev.forEach((i) => URL.revokeObjectURL(i.preview)); return []; });
    if (wsRef.current?.readyState === WebSocket.OPEN) setConnState("idle");
    resume(null);
  }, [resetView, resume, setSessionId]);

  const openSession = useCallback(async (session: Pick<UnifiedSession, "id" | "engine">) => {
    if (window.innerWidth < 1024) setSidebarOpen(false);
    if (session.id !== sessionIdRef.current) manualSelectionRef.current = null;
    sessionSourceRef.current = session.engine;
    setSessionSource(session.engine);
    resetView();
    if (session.engine === "router") {
      // Archived conversations: read-only, loaded once over REST.
      sessionIdRef.current = session.id;
      setSessionIdState(session.id);
      resume(null);
      if (wsRef.current?.readyState === WebSocket.OPEN) setConnState("idle");
      try {
        const detail = await api<RouterDetail>(`/api/router/sessions/${session.id}`);
        if (sessionIdRef.current !== session.id) return;
        setMessages(detail.messages.map((m) => ({ id: uid(), role: m.role, model: m.role === "assistant" ? detail.model : undefined,
          parts: m.role === "user" ? [{ kind: "text", text: m.text }] : legacyTextToParts(m.text) })));
        bindingReadyRef.current = true;
        setBindingReady(true);
      } catch { setBindingError("Unable to open this archived conversation."); }
      return;
    }
    setSessionId(session.id);
    bindingReadyRef.current = false;
    setBindingReady(false);
    setBindingError(null);
    setConnState(wsRef.current?.readyState === WebSocket.OPEN ? "idle" : "connecting");
    resume(session.id);
  }, [resetView, resume, setSessionId]);

  useEffect(() => {
    if (bindingReady || !sessionId) return;
    const t = setTimeout(() => { if (!bindingReadyRef.current) setBindingError("Still restoring this conversation…"); }, 8000);
    return () => clearTimeout(t);
  }, [bindingReady, sessionId]);

  const deleteSession = useCallback(async (session: UnifiedSession) => {
    try {
      await api(session.engine === "claude" ? `/api/claude/sessions/${session.id}` : `/api/router/sessions/${session.id}`, { method: "DELETE" });
      if (session.engine === "claude") setClaudeSessions((prev) => prev.filter((s) => s.id !== session.id));
      else setRouterSessions((prev) => prev.filter((s) => s.id !== session.id));
      setPinnedIds((prev) => {
        const next = new Set(prev);
        next.delete(session.id);
        store(PINS_KEY, JSON.stringify(Array.from(next)));
        return next;
      });
      if (session.id === sessionIdRef.current) newChat();
    } catch (e) { console.error("Failed to delete session", e); }
  }, [newChat]);

  const togglePin = useCallback((id: string) => {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      store(PINS_KEY, JSON.stringify(Array.from(next)));
      return next;
    });
  }, []);

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  const clearComposer = useCallback(() => {
    setInput("");
    setPaletteDismissed(null);
    promptPosRef.current = -1;
    setImages([]);  // previews stay alive: the sent message still shows them
  }, []);

  const rememberPrompt = (text: string) => {
    const list = [text, ...promptsRef.current.filter((p) => p !== text)].slice(0, 100);
    promptsRef.current = list;
    store(PROMPTS_KEY, JSON.stringify(list));
  };

  const canTalk = () => connStateRef.current === "idle" && bindingReadyRef.current && sessionSourceRef.current === "claude"
    && wsRef.current?.readyState === WebSocket.OPEN;

  const sendTurn = useCallback((text: string, opts: { mode?: PermissionMode; display?: string } = {}) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const clientId = uid();
    appendMsg({ id: uid(), role: "user", clientId, parts: userParts(opts.display ?? text, images) });
    const context = pendingBashRef.current.join("\n");
    pendingBashRef.current = [];
    ws.send(JSON.stringify({
      type: "user", client_id: clientId,
      text: context ? `${context}\n\n${text}` : text,
      images: images.map((img) => ({ mime: img.mime, data: img.data })),
      model: !selectedProvider && (selectedModel === "default" || selectedModel === "claude") ? null : selectedModel,
      provider_id: selectedProvider,
      permission_mode: opts.mode ?? mode,
      effort: effort || null,
      cwd: folder, locked,
    }));
    connStateRef.current = "thinking";
    setConnState("thinking");
    setTurnStartedAt(Date.now());
    clearComposer();
    isAtBottomRef.current = true;
    scrollToBottom("instant");
  }, [appendMsg, clearComposer, effort, folder, images, locked, mode, scrollToBottom, selectedModel, selectedProvider]);

  const runBash = useCallback((command: string) => {
    const ws = wsRef.current;
    if (!command || !ws || ws.readyState !== WebSocket.OPEN) return;
    const clientId = uid();
    appendMsg({ id: uid(), role: "user", clientId, parts: [{ kind: "bash", command, stdout: null, stderr: null, running: true }] });
    ws.send(JSON.stringify({ type: "bash", command, client_id: clientId, cwd: folder }));
    setBashRunning(true);
    clearComposer();
    isAtBottomRef.current = true;
  }, [appendMsg, clearComposer, folder]);

  const saveMemory = useCallback(async (scope: "project" | "user") => {
    const note = memoryNote;
    setMemoryNote(null);
    if (!note) return;
    try {
      const res = await api<{ path: string }>("/api/claude/memory", { method: "POST", body: JSON.stringify({ scope, text: note, cwd: folder }) });
      notice(`Saved to memory · ${res.path}`);
      clearComposer();
    } catch { notice("Could not save the memory note.", "error"); }
  }, [clearComposer, folder, memoryNote, notice]);

  const exportConversation = useCallback(() => {
    const title = historyTitle || "Claude Code conversation";
    const body = messages.filter((m) => m.parts.length)
      .map((m) => `## ${m.role === "user" ? "You" : m.role === "assistant" ? `Claude${m.model && m.model !== "local" ? ` (${m.model})` : ""}` : "—"}\n\n${partsToText(m.parts)}`)
      .join("\n\n");
    const blob = new Blob([`# ${title}\n\n${body}\n`], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${title.replace(/[^\w.-]+/g, "-").slice(0, 60) || "conversation"}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, [historyTitle, messages]);

  const providerName = selectedProvider ? modelProviders.find((p) => p.id === selectedProvider)?.name || selectedProvider : null;
  const sessionTotalCost = sessionUsage.total_cost_usd;
  const sessionTotalTokens = sessionUsage.input_tokens + sessionUsage.output_tokens
    + sessionUsage.cache_read_input_tokens + sessionUsage.cache_creation_input_tokens;
  const home = caps?.home ?? null;
  const folderPath = folder ?? home ?? "~";

  const statusMarkdown = useCallback(() => {
    const native = caps?.models.find((m) => m.value === selectedModel);
    const rows: [string, string][] = [
      ["Session", sessionId ? `\`${sessionId}\`` : "new (starts with your next message)"],
      ["Model", `${!selectedProvider && native ? native.display_name : selectedModel} \`${selectedModel}\``],
      ["Provider", providerName ? `${providerName} (custom, via ANTHROPIC_BASE_URL)` : `Claude official · ${caps?.account.subscription ?? "Claude Code login"}`],
      ["Last turn ran on", initInfo?.model ? `\`${initInfo.model}\`` : "—"],
      ["Permission mode", MODE_INFO[mode].label],
      ["Effort", effort || "auto"],
      ["Folder", `\`${folderPath}\`${locked ? " · locked: Claude can only change files inside it" : ""}`],
      ["Claude Code", caps?.version ?? initInfo?.claude_code_version ?? "—"],
      ["Memory", caps ? `\`${caps.memory.project}\`, \`${caps.memory.user}\`` : "—"],
      ["MCP servers", initInfo?.mcp_servers?.length ? initInfo.mcp_servers.map((s) => `${s.name} (${s.status})`).join(", ") : "— (shown after the first turn)"],
      ["Tools", initInfo?.tools ? String(initInfo.tools.length) : "—"],
      ["Session usage", sessionTotalTokens ? `${sessionUsage.estimated ? "≈ " : ""}${formatCost(sessionTotalCost)} · ${formatTokens(sessionTotalTokens)} tokens (in ${formatTokens(sessionUsage.input_tokens)}, out ${formatTokens(sessionUsage.output_tokens)}, cache read ${formatTokens(sessionUsage.cache_read_input_tokens)}, cache write ${formatTokens(sessionUsage.cache_creation_input_tokens)})` : "—"],
    ];
    return `### Status\n\n| | |\n|---|---|\n${rows.map(([k, v]) => `| ${k} | ${v} |`).join("\n")}`;
  }, [caps, effort, folderPath, initInfo, locked, mode, providerName, selectedModel, selectedProvider, sessionId, sessionTotalCost, sessionTotalTokens, sessionUsage]);

  const runPageCommand = useCallback((name: string, args: string, typed: string) => {
    clearComposer();
    switch (name) {
      case "model": {
        if (!args) { setPickerOpen(true); return; }
        const q = args.toLowerCase();
        const native = caps?.models.find((m) => m.value.toLowerCase() === q || m.display_name.toLowerCase() === q);
        const custom = agentModels.find((m) => m.id.toLowerCase() === q)
          ?? agentModels.find((m) => m.id.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q));
        const pick: ModelSelection | null = native ? { model: native.value, provider_id: null }
          : custom ? { model: custom.id, provider_id: custom.provider_id }
          : q.startsWith("claude-") ? { model: args, provider_id: null } : null;
        if (!pick) { notice(`No model matches “${args}”. Type /model to browse.`, "error"); return; }
        selectModel(pick);
        const via = pick.provider_id ? modelProviders.find((p) => p.id === pick.provider_id)?.name ?? custom?.provider : "Claude official";
        notice(`Model set to ${native?.display_name ?? pick.model} · ${via}. Applies from your next message.`);
        return;
      }
      case "effort": {
        if (!args) { effortRef.current?.focus(); return; }
        const level = args.toLowerCase();
        if (level !== "auto" && !EFFORT_LEVELS.includes(level as typeof EFFORT_LEVELS[number])) {
          notice(`Effort must be auto, ${EFFORT_LEVELS.join(", ")}.`, "error");
          return;
        }
        setEffort(level === "auto" ? "" : level);
        notice(`Effort set to ${level}.`);
        return;
      }
      case "plan":
        setMode("plan");
        if (args && canTalk()) sendTurn(args, { mode: "plan" });
        else if (!args) notice("Plan mode on: Claude explores read-only and proposes a plan. Shift+Tab to leave.");
        return;
      case "permissions": {
        const next = args ? MODE_ARGS[args.toLowerCase().replace(/[^a-z]/g, "")] : PERMISSION_MODES[(PERMISSION_MODES.indexOf(mode) + 1) % PERMISSION_MODES.length];
        if (!next) { notice("Use /permissions bypass, edits or plan.", "error"); return; }
        setMode(next);
        notice(`Permission mode: ${MODE_INFO[next].label}.`);
        return;
      }
      case "clear": newChat(); return;
      case "resume":
        setSidebarOpen(true);
        setTimeout(() => searchRef.current?.focus(), 80);
        return;
      case "memory": setMemoryOpen(true); return;
      case "status": appendLocal(typed, statusMarkdown()); return;
      case "export": exportConversation(); return;
      case "help": appendLocal(typed, helpMarkdown(caps)); return;
    }
  }, [agentModels, appendLocal, caps, clearComposer, exportConversation, mode, modelProviders, newChat, notice, selectModel, sendTurn, setEffort, setMode, statusMarkdown]);

  const submit = useCallback((raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text && images.length === 0) return;
    if (text.startsWith("/")) {
      const name = text.split(/\s+/, 1)[0];
      const page = findPageCommand(name);
      if (page && !(busy && page.name === "model")) {
        rememberPrompt(text);
        runPageCommand(page.name, text.slice(name.length).trim(), text);
        return;
      }
    }
    if (connStateRef.current === "thinking" && bindingReadyRef.current && !text.startsWith("!") && !text.startsWith("#")) {
      rememberPrompt(text);
      setQueued(text);
      setInput("");
      return;
    }
    if (!canTalk() || bashRunning) return;
    rememberPrompt(text);
    if (text.startsWith("!")) { runBash(text.slice(1).trim()); return; }
    if (text.startsWith("#")) { setMemoryNote(text.replace(/^#+\s*/, "")); return; }
    // Everything else, slash commands included, goes to the CLI as typed.
    sendTurn(text);
  }, [bashRunning, busy, images.length, input, runBash, runPageCommand, sendTurn]);

  const interrupt = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: "interrupt" }));
  }, []);

  useEffect(() => {
    if (queued && connState === "idle" && bindingReady && !bashRunning) {
      setQueued(null);
      sendTurn(queued);
    }
  }, [bashRunning, bindingReady, connState, queued, sendTurn]);

  // Esc stops the turn from anywhere on the page, as in the terminal.
  useEffect(() => {
    if (!active || !busy) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) interrupt(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [active, busy, interrupt]);

  // Typing anywhere on the page lands in the composer, no click needed. Focus moves on keydown,
  // so the browser then inserts the character (or the Ctrl/⌘+V paste) into the textarea.
  useEffect(() => {
    if (!active) return;
    const key = (e: KeyboardEvent) => {
      const paste = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "v";
      if (e.defaultPrevented || e.isComposing || (!paste && (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1))) return;
      const el = textareaRef.current;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (!el || el.disabled || target === el || !el.getClientRects().length) return;
      if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='dialog']")) return;
      if (e.key === " " && target?.closest("button, a, summary, [role='button'], [role='separator']")) return;
      if (document.querySelector("[aria-modal='true']")) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [active]);

  // Opening the page or a session puts the caret in the composer (not on touch screens: it would pop the keyboard).
  useEffect(() => {
    if (!active || !bindingReady || !window.matchMedia("(pointer: fine)").matches) return;
    if (document.querySelector("[aria-modal='true']")) return;
    textareaRef.current?.focus({ preventScroll: true });
  }, [active, bindingReady, sessionId]);

  // Folder: another folder means another conversation (--resume only finds a session in its own).
  const chooseFolder = useCallback(({ path, locked: lock }: FolderChoice) => {
    setFolderOpen(false);
    const current = sessionIdRef.current ? (sessionFolder ?? home) : (newFolder ?? home);
    if (sessionIdRef.current && path !== current) {
      if (busy) { notice("Wait for this turn to finish, or stop it, before switching folders.", "error"); return; }
      newChat();
    }
    setNewFolder(path === home ? null : path);
    store(FOLDER_KEY, path === home ? null : path);
    setLocked(lock);
    notice(`Folder ${shortPath(path, home)}${lock ? " · locked: Claude can only change files inside it" : ""}. Applies from your next message.`);
  }, [busy, home, newChat, newFolder, notice, sessionFolder, setLocked]);

  const toggleLock = useCallback(() => {
    if (!locked && caps?.sandbox && !caps.sandbox.available) {
      notice(`The folder lock needs ${caps.sandbox.missing.join(" and ")} on the server: sudo apt install bubblewrap socat`, "error");
      return;
    }
    setLocked(!locked);
    notice(locked ? "Folder unlocked: Claude can change files anywhere again. Applies from your next message."
      : `Locked to ${shortPath(folderPath, home)}: Claude can only change files inside it. Applies from your next message.`);
  }, [caps, folderPath, home, locked, notice, setLocked]);

  const recentFolders = useMemo(() => [...new Set([newFolder, ...claudeSessions.map((s) => s.cwd)]
    .filter((f): f is string => Boolean(f) && f !== home))], [claudeSessions, home, newFolder]);

  const approvePlan = useCallback(() => {
    const next = modeBeforePlanRef.current === "plan" ? "bypassPermissions" : modeBeforePlanRef.current;
    setMode(next);
    if (canTalk()) sendTurn("The plan is approved. Go ahead and implement it.", { mode: next });
  }, [sendTurn, setMode]);

  // -------------------------------------------------------------------------
  // Composer: palette for / and @, keys, images
  // -------------------------------------------------------------------------

  const beforeCaret = input.slice(0, caret);
  const slashQuery = /^\/\S*$/.test(input) ? input : null;
  const mentionQuery = !slashQuery ? beforeCaret.match(/(?:^|\s)@([^\s@]*)$/)?.[1] ?? null : null;
  const paletteKey = slashQuery !== null ? `/${slashQuery}` : mentionQuery !== null ? `@${mentionQuery}` : null;

  useEffect(() => {
    if (mentionQuery === null) return;
    setFilesLoading(true);
    const t = setTimeout(() => {
      api<{ path: string; dir: boolean }[]>(`/api/claude/files?q=${encodeURIComponent(mentionQuery)}${folder ? `&cwd=${encodeURIComponent(folder)}` : ""}`)
        .then((rows) => setFileItems(rows.map((r) => ({ key: `f:${r.path}`, insert: `@${r.path}`, label: r.path, description: "",
          badge: r.dir ? "folder" : "file", kind: r.dir ? "dir" as const : "file" as const }))))
        .catch(() => setFileItems([]))
        .finally(() => setFilesLoading(false));
    }, 120);
    return () => clearTimeout(t);
  }, [folder, mentionQuery]);

  const paletteItems = useMemo<PaletteItem[]>(() => {
    if (slashQuery !== null) return slashItems(caps, slashQuery).slice(0, 60);
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase().replace(/^agent-/, "");
    const agents: PaletteItem[] = (caps?.agents ?? []).filter((a) => !q || a.name.toLowerCase().includes(q)).slice(0, 6)
      .map((a) => ({ key: `a:${a.name}`, insert: `@agent-${a.name}`, label: `@agent-${a.name}`, description: a.description, badge: "agent", kind: "agent" }));
    return [...agents, ...fileItems];
  }, [caps, fileItems, mentionQuery, slashQuery]);

  const paletteOpen = paletteKey !== null && paletteDismissed !== paletteKey && !isArchived && (paletteItems.length > 0 || (mentionQuery !== null && filesLoading));
  useEffect(() => { setPaletteIndex(0); }, [paletteKey]);

  const placeCaret = (pos: number) => requestAnimationFrame(() => {
    const el = textareaRef.current;
    if (el) { el.focus(); el.setSelectionRange(pos, pos); setCaret(pos); }
  });

  const choosePalette = (item: PaletteItem, run: boolean) => {
    if (item.kind === "page" || item.kind === "cli" || item.kind === "skill") {
      if (run && !item.needsArgs) { submit(item.insert.trim()); return; }
      setInput(item.insert);
      placeCaret(item.insert.length);
      return;
    }
    // @mention: replace the token before the caret; folders keep the palette open.
    const start = beforeCaret.lastIndexOf("@");
    const insert = item.insert + (item.kind === "dir" ? "" : " ");
    const next = input.slice(0, start) + insert + input.slice(caret);
    setInput(next);
    placeCaret(start + insert.length);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); cycleMode(); return; }
    if (paletteOpen && paletteItems.length) {
      const n = paletteItems.length;
      if (e.key === "ArrowDown") { e.preventDefault(); setPaletteIndex((i) => (i + 1) % n); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setPaletteIndex((i) => (i - 1 + n) % n); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        choosePalette(paletteItems[paletteIndex % n], e.key === "Enter");
        return;
      }
    }
    if (e.key === "Escape") {
      if (paletteOpen) { e.preventDefault(); setPaletteDismissed(paletteKey); return; }
      if (memoryNote !== null) { e.preventDefault(); setMemoryNote(null); return; }
      if (busy) { e.preventDefault(); interrupt(); return; }
    }
    const el = e.currentTarget;
    const atStart = el.selectionStart === el.selectionEnd && !el.value.slice(0, el.selectionStart).includes("\n");
    const atEnd = el.selectionStart === el.selectionEnd && !el.value.slice(el.selectionEnd).includes("\n");
    if (e.key === "ArrowUp" && atStart && promptsRef.current.length && promptPosRef.current < promptsRef.current.length - 1) {
      e.preventDefault();
      if (promptPosRef.current === -1) draftRef.current = input;
      const text = promptsRef.current[++promptPosRef.current];
      setInput(text);
      placeCaret(text.length);
      return;
    }
    if (e.key === "ArrowDown" && atEnd && promptPosRef.current >= 0) {
      e.preventDefault();
      const text = --promptPosRef.current >= 0 ? promptsRef.current[promptPosRef.current] : draftRef.current;
      setInput(text);
      placeCaret(text.length);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  };

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  const addImageFiles = (files: File[]) => {
    files.filter((f) => f.type.startsWith("image/")).forEach((f) => {
      const reader = new FileReader();
      reader.onload = () => {
        const data = String(reader.result).split(",")[1] ?? "";
        setImages((prev) => [...prev, { id: uid(), mime: f.type || "image/png", data, preview: URL.createObjectURL(f), name: f.name }]);
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

  // -------------------------------------------------------------------------
  // Derived view data
  // -------------------------------------------------------------------------

  const unifiedSessions: UnifiedSession[] = useMemo(() => [
    ...claudeSessions
      .filter((s) => s.message_count > 0 || s.running || s.id === sessionId)
      .map((s): UnifiedSession => ({ ...s, engine: "claude" })),
    ...routerSessions.map((s): UnifiedSession => ({ ...s, engine: "router" })),
  ], [claudeSessions, routerSessions, sessionId]);

  const usageData = mergeUsage(claudeUsage, routerUsage);
  const activeSession = unifiedSessions.find((s) => s.id === sessionId);
  const chatTitle = historyTitle ?? activeSession?.title ?? (sessionId ? `Session ${sessionId.slice(0, 8)}…` : "New Chat");
  const lastMsg = messages[messages.length - 1];
  const lastAssistantText = !busy && lastMsg?.role === "assistant" && !lastMsg.local
    ? lastMsg.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("\n") : undefined;
  const lastPlanMsgId = mode === "plan" && !busy
    ? [...messages].reverse().find((m) => m.role === "assistant" && m.parts.some((p) => p.kind === "tool" && p.name === "ExitPlanMode"))?.id
    : undefined;
  const composerMode = input.startsWith("!") ? "bash" : input.startsWith("#") ? "memory" : null;
  const canSend = bindingReady && !isArchived && !bashRunning && (connState === "idle" || connState === "thinking") && (input.trim().length > 0 || images.length > 0);

  // =========================================================================
  // RENDER
  // =========================================================================

  let lastModel: string | undefined;

  const answeredBy = [...messages].reverse().find((m) => m.role === "assistant" && m.model && m.model !== "local")?.model ?? initInfo?.model ?? null;
  const liveChars = running ? messages[messages.length - 1]?.streaming?.length ?? 0 : 0;
  const lastTurn = [...turnUsages.values()].pop() ?? null;
  const pickedNative = caps?.models.find((m) => m.value === selectedModel);

  return (
    <div className="relative flex h-full w-full overflow-hidden" style={{ display: active ? undefined : "none" }}>
      {historyModalOpen && usageData && <UsageHistoryModal usage={usageData} onClose={() => setHistoryModalOpen(false)} />}
      {memoryOpen && <MemoryModal cwd={folder} onClose={() => setMemoryOpen(false)} onSaved={(path) => notice(`Saved ${path}`)} />}
      {folderOpen && home && (
        <FolderPicker current={folderPath} locked={locked} home={home} sandbox={caps?.sandbox} recent={recentFolders}
          sessionStarted={Boolean(sessionId) && !isArchived} onChoose={chooseFolder} onClose={() => setFolderOpen(false)} />
      )}

      {sidebarOpen && <div className="fixed inset-0 z-20 bg-black/50 lg:hidden" onClick={() => setSidebarOpen(false)} />}

      <div inert={!sidebarOpen} className={`claude-sidebar-wrapper border-r border-line ${sidebarOpen ? "" : "claude-sidebar-closed"}`}>
        <Sidebar
          sessions={unifiedSessions}
          loading={sessionsLoading}
          activeSessionId={sessionId}
          isThinking={running}
          pinnedIds={pinnedIds}
          limits={planLimits.limits}
          limitsLoading={planLimits.loading}
          onRefreshLimits={() => void refreshLimits(true)}
          usage={usageData}
          activePeriod={usagePeriod}
          onChangePeriod={setUsagePeriod}
          onOpenHistory={() => setHistoryModalOpen(true)}
          onNewChat={newChat}
          onSelect={(s) => void openSession(s)}
          onDelete={deleteSession}
          onTogglePin={togglePin}
          searchRef={searchRef}
          home={home ?? undefined}
        />
      </div>

      <div className="flex flex-1 min-w-0 flex-col h-full overflow-hidden bg-bg">
        <header className="agent-toolbar">
          <div className="agent-toolbar-heading">
            <button type="button" onClick={() => setSidebarOpen((o) => !o)} title="Toggle sessions"
              aria-label="Toggle sessions" aria-expanded={sidebarOpen}
              className="agent-icon-button text-muted hover:bg-surface-2 hover:text-fg">
              <Menu size={18} />
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h1 className="text-sm font-semibold text-fg truncate">{isArchived ? "Conversation archive" : "Claude Code"}</h1>
                {running && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/20 px-2.5 py-0.5 text-[10px] font-semibold text-accent border border-accent/40 shrink-0">
                    <RunningDot /> Running
                  </span>
                )}
              </div>
              <p className="text-[11px] text-muted truncate">{chatTitle}</p>
            </div>
          </div>
          <div className="agent-toolbar-actions">
            {!sidebarOpen && <PlanLimitsChip limits={planLimits.limits} onClick={() => setSidebarOpen(true)} />}
            <StatusPill state={connState} />
            <button type="button" onClick={() => setPanelOpen((o) => !o)} title="Model in use" aria-label="Model in use"
              aria-pressed={panelOpen} className={`agent-icon-button hover:bg-surface-2 hover:text-fg ${panelOpen ? "text-accent" : "text-muted"}`}>
              <PanelRight size={17} />
            </button>
            <button type="button" onClick={() => setHistoryModalOpen(true)} title="Usage history" aria-label="Usage history"
              className="agent-icon-button text-muted hover:bg-surface-2 hover:text-fg">
              <BarChart2 size={17} />
            </button>
            <button type="button" onClick={newChat} title="New chat (/clear)" aria-label="New chat"
              className="agent-icon-button text-muted hover:bg-surface-2 hover:text-fg">
              <Plus size={19} />
            </button>
          </div>
          <div className="agent-toolbar-context">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0 text-[10px] text-muted uppercase tracking-wider">Model</span>
              {!isArchived ? (
                <ModelPicker models={agentModels} providers={modelProviders} nativeModels={caps?.models}
                  value={{ model: selectedModel, provider_id: selectedProvider }}
                  disabled={running} loading={modelsLoading} error={modelsError}
                  open={pickerOpen} onOpenChange={setPickerOpen}
                  onSelect={selectModel} onRefresh={() => loadModels(true)} />
              ) : <span className="truncate text-xs text-fg-2">{formatModelBadge(activeSession?.model || selectedModel)}</span>}
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

        {/* Messages */}
        <div className="relative flex-1 min-h-0">
          <div ref={scrollRef} onScroll={onScroll} className="absolute inset-0 overflow-y-auto overscroll-contain px-3 sm:px-5 py-4">
            {messages.length === 0 && bindingReady && connState !== "connecting" && (
              <div className="flex h-full items-center justify-center px-2 sm:px-6">
                <div className="w-full max-w-md text-left">
                  <div className="mb-4 flex items-center gap-2 text-xs font-medium text-accent"><Bot size={18} /> Claude Code Agent</div>
                  <h2 className="text-xl sm:text-2xl font-semibold tracking-tight text-fg">What are we working on?</h2>
                  <p className="mt-3 text-sm leading-relaxed text-muted">
                    The real Claude Code CLI, with any model: official Claude or a custom provider, switchable mid-session.
                  </p>
                  <ul className="mt-4 space-y-1.5 text-xs text-muted">
                    <li><kbd className="palette-kbd">/</kbd> commands and skills · <kbd className="palette-kbd">@</kbd> files and agents</li>
                    <li><kbd className="palette-kbd">!</kbd> run bash · <kbd className="palette-kbd">#</kbd> save to memory</li>
                    <li><kbd className="palette-kbd">Shift+Tab</kbd> permission mode · <kbd className="palette-kbd">Esc</kbd> stop</li>
                    <li>Working in <span className="font-mono text-fg-2">{shortPath(folderPath, home)}</span>{locked ? " · locked to this folder" : ""}: change it below the message box</li>
                  </ul>
                </div>
              </div>
            )}
            {!bindingReady && messages.length === 0 && (
              <div className="flex h-full items-center justify-center gap-2 text-xs text-muted"><Loader size={14} className="animate-spin" /> Loading conversation…</div>
            )}

            {messages.map((msg) => {
              if (msg.role === "system") {
                return msg.parts.map((p, i) => p.kind === "notice" ? <NoticeRow key={`${msg.id}-${i}`} part={p} /> : null);
              }
              const usage = turnUsages.get(msg.id);
              const isLive = msg.id === liveIdRef.current;
              let divider: string | null = null;
              if (msg.role === "assistant" && msg.model && msg.model !== "local") {
                if (lastModel && lastModel !== msg.model) divider = msg.model;
                lastModel = msg.model;
              }
              const empty = !msg.parts.length && !msg.streaming;
              return (
                <div key={msg.id}>
                  {divider && <div className="chat-notice text-muted"><span>Continued with {modelLabel(divider)} <span className="font-mono text-[10px] opacity-70">{divider}</span></span></div>}
                  <div className={`mb-3 flex gap-2.5 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
                    <div className={`mt-1 flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${msg.role === "user" ? "bg-accent text-bg" : "bg-surface-2 text-accent"}`}>
                      {msg.role === "user" ? "U" : <Bot size={14} />}
                    </div>
                    <div className={`flex min-w-0 flex-col max-w-[85%] ${msg.role === "user" ? "items-end" : "items-start"}`}>
                      <div className={`chat-message-bubble min-w-0 max-w-full space-y-2 rounded-xl px-3 py-2.5 ${
                        msg.role === "user" ? "rounded-tr-sm bg-accent/15 text-fg" : "rounded-tl-sm border border-line bg-surface text-fg"}`}>
                        {msg.role === "user" && msg.parts.length === 1 && msg.parts[0].kind === "text"
                          ? <p className="whitespace-pre-wrap break-words text-sm">{msg.parts[0].text}</p>
                          : <MessageParts msg={msg} onApprovePlan={msg.id === lastPlanMsgId ? approvePlan : undefined} />}
                        {isLive && running && (
                          <div className={`flex items-center gap-2 text-xs text-accent ${empty ? "" : "border-t border-line/40 pt-2"}`}>
                            <RunningDot />
                            <span className="font-medium">✻ {activity ?? (msg.streaming ? "Writing" : "Working")}…</span>
                            <span className="text-muted"><Elapsed since={turnStartedAt} /> · esc to interrupt</span>
                          </div>
                        )}
                      </div>
                      {msg.role === "assistant" && !isLive && (usage || (msg.model && msg.model !== "local")) && (
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-muted tabular-nums">
                          {usage && <>
                            <span title="Input tokens">↑{formatTokens(usage.input_tokens)}</span><span className="opacity-40">·</span>
                            <span title="Output tokens">↓{formatTokens(usage.output_tokens)}</span>
                            {(usage.cache_read_input_tokens > 0 || usage.cache_creation_input_tokens > 0) && <>
                              <span className="opacity-40">·</span>
                              <span title="Cache read / cache write tokens">⟳{formatTokens(usage.cache_read_input_tokens)}/{formatTokens(usage.cache_creation_input_tokens)}</span>
                            </>}
                            {usage.total_cost_usd > 0 && <><span className="opacity-40">·</span><span title={usage.estimated ? "Estimated" : "As Claude Code reports it"}>{usage.estimated ? "≈" : ""}{formatCost(usage.total_cost_usd)}</span></>}
                          </>}
                          {msg.model && msg.model !== "local" && <>{usage && <span className="opacity-40">·</span>}<span className="text-muted/70" title={msg.model}>{modelLabel(msg.model)}</span></>}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {showScrollBtn && (
            <button type="button" onClick={() => { isAtBottomRef.current = true; scrollToBottom(); }}
              className="absolute bottom-3 right-4 z-10 flex size-9 cursor-pointer items-center justify-center rounded-full border border-line bg-surface shadow-lg text-muted transition-all hover:bg-surface-2 hover:text-fg"
              title="Scroll to bottom" aria-label="Scroll to bottom">
              <ArrowDown size={16} />
            </button>
          )}
        </div>

        {/* Composer */}
        <div className="agent-compose-panel border-t border-line bg-bg px-2.5 py-2 sm:px-4 sm:py-3 shrink-0">
          {bindingError && (
            <div role="alert" className="mb-2 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-muted">
              <p>{bindingError}</p>
              <div className="mt-2 flex gap-3">
                {sessionId && <button type="button" onClick={() => { setBindingError(null); void openSession({ id: sessionId, engine: sessionSource }); }} className="text-accent">Retry session</button>}
                <button type="button" onClick={newChat} className="text-accent">Start new chat</button>
              </div>
            </div>
          )}

          {busy && (
            <div className="mb-2 flex items-center justify-between rounded-xl border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs text-accent">
              <div className="flex min-w-0 items-center gap-2 font-medium">
                <RunningDot />
                <span className="truncate">{bashRunning ? "Running bash command" : "Claude Code is working"} · keeps running if you leave this page</span>
              </div>
              <button type="button" onClick={interrupt} title="Stop (Esc)"
                className="shrink-0 flex items-center gap-1 rounded-md bg-bad/20 hover:bg-bad/30 text-bad px-2 py-0.5 font-medium text-[11px]">
                <Square size={10} /> Stop
              </button>
            </div>
          )}

          {images.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {images.map((img) => (
                <div key={img.id} className="relative">
                  <img src={img.preview} alt={img.name} className="h-14 w-14 sm:h-16 sm:w-16 rounded-lg object-cover border border-line" />
                  <button type="button" onClick={() => removeImage(img.id)} aria-label={`Remove ${img.name}`}
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

          {queued && (
            <div className="mb-2 flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-muted">
              <span className="shrink-0 font-semibold text-fg-2">Queued</span>
              <span className="min-w-0 flex-1 truncate">{queued}</span>
              <button type="button" onClick={() => { setInput(queued); setQueued(null); }} className="shrink-0 text-accent">Edit</button>
              <button type="button" onClick={() => setQueued(null)} aria-label="Remove queued message" className="shrink-0 hover:text-fg"><X size={14} /></button>
            </div>
          )}

          <FeedbackSuggestions lastMessageText={lastAssistantText} disabled={busy || isArchived || !bindingReady}
            onSelect={(suggestion) => submit(suggestion)} />

          <div className="agent-composer relative flex items-end gap-1.5 sm:gap-2">
            <CommandPalette
              open={paletteOpen}
              title={slashQuery !== null ? "Commands · page, Claude Code and skills" : "Mention a file, folder or agent"}
              items={paletteItems}
              selectedIndex={paletteIndex}
              loading={mentionQuery !== null && filesLoading}
              onSelect={(item) => choosePalette(item, true)}
            />
            {memoryNote !== null && (
              <div role="dialog" aria-label="Save memory" className="absolute bottom-full left-0 right-0 z-30 mb-2 rounded-xl border border-line bg-surface-2 p-3 shadow-2xl">
                <p className="text-xs text-muted">Save to memory:</p>
                <p className="mt-1 mb-2 break-words text-sm text-fg">{memoryNote || <span className="text-muted">(empty)</span>}</p>
                <div className="flex flex-col gap-1.5 sm:flex-row">
                  {(["project", "user"] as const).map((scope) => (
                    <button key={scope} type="button" disabled={!memoryNote.trim()} onClick={() => void saveMemory(scope)}
                      className="min-h-10 flex-1 rounded-lg border border-line bg-surface px-3 text-left text-xs hover:border-accent disabled:opacity-40">
                      <span className="block font-semibold text-fg">{scope === "project" ? "Project memory" : "User memory"}</span>
                      <span className="block truncate font-mono text-[10px] text-muted">{caps?.memory[scope] ?? (scope === "project" ? "./CLAUDE.md" : "~/.claude/CLAUDE.md")}</span>
                    </button>
                  ))}
                  <button type="button" onClick={() => setMemoryNote(null)} className="min-h-10 rounded-lg px-3 text-xs text-muted hover:text-fg">Cancel</button>
                </div>
              </div>
            )}

            {!isArchived && (
              <>
                <button type="button" title="Commands (/)" aria-label="Claude Code commands" disabled={isArchived}
                  onClick={() => { setInput("/"); setPaletteDismissed(null); placeCaret(1); }}
                  className="mb-0.5 grid size-9 shrink-0 cursor-pointer place-items-center rounded-lg text-muted font-mono font-bold text-sm transition-colors hover:bg-surface-2 hover:text-accent">
                  /
                </button>
                <button type="button" onClick={() => fileRef.current?.click()} title="Attach image" aria-label="Attach image" disabled={busy}
                  className="mb-0.5 grid size-9 shrink-0 cursor-pointer place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg">
                  <Image size={18} />
                </button>
                <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
                  onChange={(e) => { addImageFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
              </>
            )}

            <textarea
              ref={textareaRef}
              value={input}
              disabled={isArchived}
              aria-label="Message Claude Code" name="message" autoComplete="off" spellCheck={!composerMode}
              onChange={(e) => {
                setInput(e.target.value);
                setCaret(e.target.selectionStart);
                setPaletteDismissed(null);
                promptPosRef.current = -1;
              }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
                if (files.length) { e.preventDefault(); addImageFiles(files); }
              }}
              placeholder={isArchived ? "Archived conversation" : running ? "Claude Code is working… type to queue a message, Esc to stop" : "Message Claude Code…  / commands · @ files · ! bash · # memory"}
              rows={1}
              className={`flex-1 resize-none rounded-xl border bg-surface px-3 py-2 text-sm text-fg placeholder:text-muted focus:outline-none ${
                composerMode === "bash" ? "border-warn font-mono focus:border-warn" : composerMode === "memory" ? "border-accent/70 focus:border-accent" : "border-line focus:border-accent"}`}
              style={{ maxHeight: 200 }}
            />

            {busy && !input.trim() ? (
              <button type="button" onClick={interrupt} title="Stop (Esc)" aria-label="Stop"
                className="mb-0.5 grid size-9 shrink-0 cursor-pointer place-items-center rounded-lg bg-bad/10 text-bad transition-colors hover:bg-bad/20">
                <Square size={16} />
              </button>
            ) : (
              <button type="button" onClick={() => submit()} disabled={!canSend} title={running ? "Queue for after this turn (Enter)" : "Send (Enter)"} aria-label="Send message"
                className="mb-0.5 grid size-9 shrink-0 cursor-pointer place-items-center rounded-lg bg-accent text-bg transition-colors hover:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-40">
                <Send size={16} />
              </button>
            )}
          </div>

          {!isArchived && (
            <div className="agent-statusline">
              <button type="button" onClick={cycleMode} title="Permission mode (Shift+Tab)" className={`agent-mode-chip ${MODE_INFO[mode].cls}`}>
                <span aria-hidden>{MODE_INFO[mode].icon}</span> {MODE_INFO[mode].label} on
                <span className="hidden text-muted sm:inline"> (shift+tab)</span>
              </button>
              <label className="agent-effort">
                <span>effort</span>
                <select ref={effortRef} value={effort} onChange={(e) => setEffort(e.target.value)} aria-label="Reasoning effort">
                  <option value="">auto</option>
                  {EFFORT_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </label>
              <span className={`agent-folder${locked ? " is-locked" : ""}`}>
                <button type="button" onClick={() => setFolderOpen(true)} disabled={!home} title={`Folder: ${folderPath} · click to change`}
                  aria-label={`Folder ${folderPath}. Change folder`} className="agent-folder-path">
                  <Folder size={12} aria-hidden className="shrink-0" />
                  <span className="truncate">{shortPath(folderPath, home)}</span>
                </button>
                <button type="button" onClick={toggleLock} aria-pressed={locked}
                  title={locked ? "Locked: Claude can only change files in this folder. Click to unlock" : "Unlocked: Claude can change files anywhere. Click to lock to this folder"}
                  aria-label={locked ? "Unlock folder" : "Lock to this folder"} className="agent-folder-lock">
                  {locked ? <Lock size={12} aria-hidden /> : <LockOpen size={12} aria-hidden />}
                  <span className="hidden sm:inline">{locked ? "locked" : "unlocked"}</span>
                </button>
              </span>
              <span className="min-w-0 truncate text-muted">
                {composerMode === "bash" ? "! bash mode · runs on the server, output goes into your next message"
                  : composerMode === "memory" ? "# memory · Enter to choose where to save"
                  : providerName ? `via ${providerName}` : "Claude official"}
              </span>
            </div>
          )}
          {!isArchived && <UsageBar usage={sessionUsage} subscription={caps?.account.subscription ?? null} />}
        </div>
      </div>

      {panelOpen && (
        <>
          <div className="fixed inset-0 z-20 bg-black/50 xl:hidden" onClick={() => setPanelOpen(false)} />
          <aside aria-label="Model in use"
            className="fixed inset-y-0 right-0 z-30 w-[min(20rem,92vw)] border-l border-line bg-surface xl:static xl:z-auto xl:w-80 xl:shrink-0">
            <ModelLivePanel
              selected={{ value: selectedModel, name: pickedNative?.display_name ?? formatModelBadge(selectedModel), note: pickedNative?.description }}
              currentModel={answeredBy} running={running} activity={activity} streamedChars={liveChars}
              usage={sessionUsage} replies={messages.filter((m) => m.role === "assistant" && !m.local).length}
              lastTurn={lastTurn} onClose={() => setPanelOpen(false)} />
          </aside>
        </>
      )}
    </div>
  );
}

import { Folder, Lock, MessageSquare, Pin, PinOff, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useState, type RefObject } from "react";
import { formatAgo, formatModelBadge } from "./format";
import { PlanLimitsPanel } from "./PlanLimits";
import type { PlanLimits } from "./types";
import { UsageWidget, type UsagePeriod, type UsageResponse } from "./Usage";

// Source is retained only to read and manage historical conversations.
export type SessionSource = "claude" | "router";

export interface UnifiedSession {
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
  cwd?: string;
  locked?: boolean;
  running?: boolean;
}

interface ContextMenuState {
  x: number;
  y: number;
  sessionId: string;
}

export function Sidebar({
  sessions,
  loading,
  activeSessionId,
  isThinking,
  pinnedIds,
  limits,
  limitsLoading,
  onRefreshLimits,
  usage,
  activePeriod,
  onChangePeriod,
  onOpenHistory,
  onNewChat,
  onSelect,
  onDelete,
  onTogglePin,
  searchRef,
  home,
}: {
  sessions: UnifiedSession[];
  loading: boolean;
  activeSessionId: string | null;
  isThinking?: boolean;
  pinnedIds: Set<string>;
  /** The official login's plan limits, shown whatever model the chat uses. */
  limits: PlanLimits | null;
  limitsLoading: boolean;
  onRefreshLimits: () => void;
  usage: UsageResponse | null;
  activePeriod: UsagePeriod;
  onChangePeriod: (p: UsagePeriod) => void;
  onOpenHistory: () => void;
  onNewChat: () => void;
  onSelect: (s: UnifiedSession) => void;
  onDelete: (s: UnifiedSession) => void;
  onTogglePin: (id: string) => void;
  searchRef?: RefObject<HTMLInputElement | null>;
  /** Sessions in other folders are labelled with theirs. */
  home?: string;
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
          <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)}
            aria-label="Search sessions" name="session-search" autoComplete="off" placeholder="Search sessions…" type="search" />
        </label>
      </div>

      <PlanLimitsPanel limits={limits} loading={limitsLoading} onRefresh={onRefreshLimits} />

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
                    {((isActive && isThinking) || session.running) && (
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
                    {session.cwd && session.cwd !== home && (
                      <span className="inline-flex min-w-0 max-w-[110px] items-center gap-0.5 text-[10px] text-muted" title={session.cwd}>
                        {session.locked ? <Lock size={9} className="shrink-0" /> : <Folder size={9} className="shrink-0" />}
                        <span className="truncate">{session.cwd.split("/").pop()}</span>
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

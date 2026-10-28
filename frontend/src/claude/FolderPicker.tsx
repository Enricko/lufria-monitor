import { ArrowUp, Folder, FolderOpen, Home, Loader, Lock, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { shortPath } from "./format";

interface Listing { path: string; parent: string | null; home: string; writable: boolean; dirs: { name: string; path: string }[]; truncated: boolean }

export interface FolderChoice { path: string; locked: boolean }

/** The server's reason from api()'s "400 {"detail": …}" error. */
function reason(e: unknown): string {
  const text = e instanceof Error ? e.message.replace(/^\d+\s*/, "") : "";
  try { return String(JSON.parse(text).detail) || "Can't open that folder."; } catch { return text || "Can't open that folder."; }
}

/** Where a chat works, and whether it may change anything outside that folder. */
export function FolderPicker({ current, locked, home, sandbox, recent, sessionStarted, onChoose, onClose }: {
  current: string;
  locked: boolean;
  home: string;
  sandbox: { available: boolean; missing: string[] } | undefined;
  recent: string[];
  /** The open conversation already has a folder: another one means a new chat. */
  sessionStarted: boolean;
  onChoose: (choice: FolderChoice) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [typed, setTyped] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lock, setLock] = useState(locked);
  const dialog = useRef<HTMLDivElement>(null);
  const request = useRef(0);

  const browse = useCallback(async (path: string) => {
    const id = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const data = await api<Listing>(`/api/claude/folders?path=${encodeURIComponent(path)}`);
      if (id !== request.current) return;
      setListing(data);
      setTyped(data.path);
    } catch (e) {
      if (id === request.current) setError(reason(e));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void browse(current); }, [browse, current]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    document.addEventListener("keydown", key);
    dialog.current?.querySelector<HTMLElement>("input")?.focus();
    return () => { document.removeEventListener("keydown", key); previous?.focus(); };
  }, [onClose]);

  const chosen = listing?.path ?? current;
  const name = chosen === home ? "~" : chosen.split("/").pop() || "/";
  const lockAvailable = sandbox?.available !== false;
  const moving = sessionStarted && chosen !== current;
  const recentShown = recent.filter((r) => r !== chosen).slice(0, 6);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="folder-title" className="flex max-h-[90dvh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 id="folder-title" className="text-sm font-semibold text-fg">Folder</h2>
            <p className="text-xs text-muted">Claude Code starts here: its files, CLAUDE.md, skills and sessions.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close folder picker" className="agent-icon-button text-muted hover:bg-surface-2 hover:text-fg"><X size={18} /></button>
        </div>

        <div className="flex flex-col gap-2 border-b border-line p-3">
          <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) void browse(typed.trim()); }}>
            <button type="button" onClick={() => listing?.parent && void browse(listing.parent)} disabled={!listing?.parent}
              aria-label="Parent folder" title="Parent folder"
              className="grid size-10 shrink-0 place-items-center rounded-lg border border-line text-muted hover:text-fg disabled:opacity-40">
              <ArrowUp size={16} />
            </button>
            <button type="button" onClick={() => void browse(home)} aria-label="Home folder" title="Home folder"
              className="grid size-10 shrink-0 place-items-center rounded-lg border border-line text-muted hover:text-fg">
              <Home size={16} />
            </button>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Folder path" spellCheck={false} autoComplete="off"
              className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 font-mono text-xs text-fg focus:border-accent focus:outline-none" />
          </form>
          {recentShown.length > 0 && (
            <div className="flex flex-wrap gap-1.5" aria-label="Recent folders">
              {recentShown.map((r) => (
                <button key={r} type="button" onClick={() => void browse(r)} title={r}
                  className="max-w-[12rem] truncate rounded-md border border-line px-2 py-1 font-mono text-[11px] text-fg-2 hover:border-accent hover:text-fg">
                  {shortPath(r, home)}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="min-h-[12rem] flex-1 overflow-y-auto p-1.5" aria-busy={loading}>
          {error && <p role="alert" className="m-2 rounded-lg border border-bad/30 bg-bad/10 p-2 text-xs text-bad">{error}</p>}
          {loading && !listing && <p className="flex items-center gap-2 p-3 text-xs text-muted"><Loader size={14} className="animate-spin" /> Loading…</p>}
          {listing && !listing.dirs.length && !error && <p className="p-3 text-xs text-muted">No folders inside.</p>}
          {listing?.dirs.map((d) => (
            <button key={d.path} type="button" onClick={() => void browse(d.path)}
              className="flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm text-fg-2 hover:bg-surface-2 hover:text-fg">
              <Folder size={15} className="shrink-0 text-muted" aria-hidden />
              <span className="truncate">{d.name}</span>
            </button>
          ))}
          {listing?.truncated && <p className="p-2 text-[11px] text-muted">Showing the first 500. Type a path to go further.</p>}
        </div>

        <label className={`flex gap-3 border-t border-line px-4 py-3 ${lockAvailable ? "cursor-pointer" : "opacity-70"}`}>
          <input type="checkbox" checked={lock && lockAvailable} disabled={!lockAvailable} onChange={(e) => setLock(e.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]" />
          <span className="min-w-0 text-xs leading-relaxed">
            <span className="flex items-center gap-1.5 font-semibold text-fg"><Lock size={12} aria-hidden /> Only change files in this folder</span>
            <span className="block text-muted">
              {lockAvailable
                ? "Bash runs in Claude Code's sandbox, which can write only here (no sudo, no Docker), and edits outside are refused. Reading and the internet still work."
                : `Needs ${sandbox?.missing.join(" and ")} on the server: sudo apt install bubblewrap socat`}
            </span>
          </span>
        </label>

        <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5">
          <p className="min-w-0 truncate font-mono text-[11px] text-muted" title={chosen}>
            <FolderOpen size={12} className="mr-1 inline" aria-hidden />{shortPath(chosen, home)}
            {listing && !listing.writable && " · read-only for you"}
          </p>
          <div className="flex shrink-0 gap-2">
            <button type="button" onClick={onClose} className="min-h-9 rounded-lg px-3 text-xs text-muted hover:bg-surface-2 hover:text-fg">Cancel</button>
            <button type="button" disabled={!listing || loading} onClick={() => onChoose({ path: chosen, locked: lock && lockAvailable })}
              className="min-h-9 rounded-lg bg-accent px-3 text-xs font-semibold text-bg hover:bg-accent/85 disabled:opacity-40">
              {moving ? `New chat in ${name}` : `Use ${name}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

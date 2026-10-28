import { Loader, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";

interface MemoryFile { scope: "project" | "user"; path: string; exists: boolean; content: string }

const LABEL: Record<MemoryFile["scope"], string> = { project: "Project memory", user: "User memory" };

/** /memory: the CLAUDE.md files every turn loads, editable in place. `cwd`: the chat's folder (project memory). */
export function MemoryModal({ cwd, onClose, onSaved }: { cwd: string | null; onClose: () => void; onSaved: (path: string) => void }) {
  const [files, setFiles] = useState<MemoryFile[] | null>(null);
  const [scope, setScope] = useState<MemoryFile["scope"]>("project");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);

  const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";

  useEffect(() => {
    api<MemoryFile[]>(`/api/claude/memory${query}`)
      .then((data) => { setFiles(data); setDraft(Object.fromEntries(data.map((f) => [f.scope, f.content]))); })
      .catch(() => setError("Could not read the memory files."));
  }, [query]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    document.addEventListener("keydown", key);
    dialog.current?.querySelector<HTMLElement>("textarea, button")?.focus();
    return () => { document.removeEventListener("keydown", key); previous?.focus(); };
  }, [onClose]);

  const file = files?.find((f) => f.scope === scope);
  const dirty = file != null && draft[scope] !== file.content;

  const save = async () => {
    if (!file) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/api/claude/memory/${scope}${query}`, { method: "PUT", body: JSON.stringify({ content: draft[scope] ?? "" }) });
      setFiles((prev) => prev?.map((f) => f.scope === scope ? { ...f, content: draft[scope] ?? "", exists: true } : f) ?? null);
      onSaved(file.path);
    } catch {
      setError("Could not save. Check the file permissions and try again.");
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="memory-title" className="flex max-h-[90dvh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 id="memory-title" className="text-sm font-semibold text-fg">Memory</h2>
            <p className="truncate text-xs text-muted">Loaded into every Claude Code turn. <span className="font-mono"># note</span> in the composer adds a line.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close memory" className="agent-icon-button text-muted hover:bg-surface-2 hover:text-fg"><X size={18} /></button>
        </div>
        <div className="flex gap-1 border-b border-line px-3 pt-2" role="tablist">
          {(["project", "user"] as const).map((s) => (
            <button key={s} type="button" role="tab" aria-selected={scope === s} onClick={() => setScope(s)}
              className={`min-h-10 rounded-t-lg px-3 text-xs font-medium ${scope === s ? "bg-surface-2 text-fg" : "text-muted hover:text-fg"}`}>
              {LABEL[s]}
            </button>
          ))}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
          {!files && !error && <p className="flex items-center gap-2 text-xs text-muted"><Loader size={14} className="animate-spin" /> Loading…</p>}
          {file && <>
            <p className="font-mono text-[11px] text-muted break-all">{file.path}{!file.exists && " (new file)"}</p>
            <textarea value={draft[scope] ?? ""} onChange={(e) => setDraft((d) => ({ ...d, [scope]: e.target.value }))}
              aria-label={`${LABEL[scope]} contents`} spellCheck={false}
              className="min-h-[50dvh] flex-1 resize-none rounded-lg border border-line bg-bg p-3 font-mono text-xs leading-relaxed text-fg focus:border-accent focus:outline-none" />
          </>}
          {error && <p role="alert" className="rounded-lg border border-bad/30 bg-bad/10 p-2 text-xs text-bad">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-2.5">
          <button type="button" onClick={onClose} className="min-h-9 rounded-lg px-3 text-xs text-muted hover:bg-surface-2 hover:text-fg">Close</button>
          <button type="button" onClick={() => void save()} disabled={!dirty || saving}
            className="min-h-9 rounded-lg bg-accent px-3 text-xs font-semibold text-bg hover:bg-accent/85 disabled:opacity-40">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

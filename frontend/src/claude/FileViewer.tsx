import { ArrowLeft, ArrowUp, Check, Copy, Download, Eye, EyeOff, File, FileCode, Folder, Home, Image as ImageIcon, Loader, Music, Video, WrapText, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { formatSize, shortPath } from "./format";
import { renderMarkdown } from "./markdown";
import { rawUrl } from "./paths";

interface Entry { name: string; dir: boolean; size: number | null }
interface Listing { path: string; parent: string | null; entries: Entry[]; truncated: boolean }
type Preview =
  | { kind: "dir"; path: string; name: string }
  | { kind: "text"; path: string; name: string; size: number; mtime: number; text: string; truncated: boolean }
  | { kind: "image" | "video" | "audio"; path: string; name: string; size: number; mtime: number; mime: string }
  | { kind: "binary"; path: string; name: string; size: number; mtime: number };

/** The server's reason from api()'s "400 {"detail": …}" error. */
function reason(e: unknown, fallback: string): string {
  const text = e instanceof Error ? e.message.replace(/^\d+\s*/, "") : "";
  try { return String(JSON.parse(text).detail) || fallback; } catch { return text || fallback; }
}

const isMarkdown = (name: string) => /\.(md|markdown|mdx)$/i.test(name);
const parentOf = (path: string) => path.replace(/\/[^/]*$/, "") || "/";

/** Browse and read files on the server without leaving the chat. `start`: a file or folder to open. */
export function FileViewer({ start, cwd, home, onClose }: { start: string; cwd: string | null; home: string | null; onClose: () => void }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [file, setFile] = useState<Preview | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [rendered, setRendered] = useState(true);
  const [copied, setCopied] = useState<"path" | "text" | null>(null);
  // Small screens show one pane at a time.
  const [pane, setPane] = useState<"list" | "file">("list");
  const dialog = useRef<HTMLDivElement>(null);
  const dirRequest = useRef(0);
  const fileRequest = useRef(0);

  const cwdQuery = cwd ? `&cwd=${encodeURIComponent(cwd)}` : "";

  const browse = useCallback(async (path: string) => {
    const id = ++dirRequest.current;
    setListError(null);
    try {
      const data = await api<Listing>(`/api/claude/dir?path=${encodeURIComponent(path)}${cwdQuery}`);
      if (id === dirRequest.current) setListing(data);
    } catch (e) {
      if (id === dirRequest.current) { setListing(null); setListError(reason(e, "Can't open that folder.")); }
    }
  }, [cwdQuery]);

  const open = useCallback(async (path: string, listParent: boolean) => {
    const id = ++fileRequest.current;
    setLoadingFile(true);
    setFileError(null);
    try {
      const data = await api<Preview>(`/api/claude/file?path=${encodeURIComponent(path)}${cwdQuery}`);
      if (id !== fileRequest.current) return;
      if (data.kind === "dir") {
        setFile(null);
        setPane("list");
        void browse(data.path);
      } else {
        setFile(data);
        setPane("file");
        if (listParent) void browse(parentOf(data.path));
      }
    } catch (e) {
      if (id !== fileRequest.current) return;
      setFile(null);
      setFileError(reason(e, "Can't open that file."));
      setPane("file");
      if (listParent) void browse(path.startsWith("/") || path.startsWith("~") ? parentOf(path) : "");
    } finally {
      if (id === fileRequest.current) setLoadingFile(false);
    }
  }, [browse, cwdQuery]);

  useEffect(() => { void open(start, true); }, [open, start]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    document.addEventListener("keydown", key);
    dialog.current?.querySelector<HTMLElement>("button")?.focus();
    return () => { document.removeEventListener("keydown", key); previous?.focus(); };
  }, [onClose]);

  const copy = (what: "path" | "text", value: string) => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(null), 1200);
    });
  };

  const entries = listing?.entries.filter((e) => showHidden || !e.name.startsWith(".")) ?? [];
  const join = (name: string) => `${listing?.path === "/" ? "" : listing?.path ?? ""}/${name}`;
  const lines = file?.kind === "text" ? file.text.replace(/\n$/, "").split("\n") : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="files-title" className="flex h-[90dvh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 id="files-title" className="text-sm font-semibold text-fg">Files</h2>
            <p className="truncate font-mono text-xs text-muted" title={file?.path ?? listing?.path}>{shortPath(file?.path ?? listing?.path, home)}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close files" className="agent-icon-button text-muted hover:bg-surface-2 hover:text-fg"><X size={18} /></button>
        </div>

        <div className="grid min-h-0 flex-1 md:grid-cols-[17rem_minmax(0,1fr)]">
          <nav aria-label="Folder contents" className={`min-h-0 flex-col border-line md:flex md:border-r ${pane === "list" ? "flex" : "hidden"}`}>
            <div className="flex items-center gap-1 border-b border-line p-2">
              <button type="button" onClick={() => listing?.parent && void browse(listing.parent)} disabled={!listing?.parent}
                aria-label="Parent folder" title="Parent folder" className="agent-icon-button text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40"><ArrowUp size={16} /></button>
              {home && <button type="button" onClick={() => void browse(home)} aria-label="Home folder" title="Home folder"
                className="agent-icon-button text-muted hover:bg-surface-2 hover:text-fg"><Home size={16} /></button>}
              {cwd && <button type="button" onClick={() => void browse(cwd)} aria-label="Chat folder" title="Chat folder"
                className="agent-icon-button text-muted hover:bg-surface-2 hover:text-fg"><Folder size={16} /></button>}
              <button type="button" onClick={() => setShowHidden((v) => !v)} aria-pressed={showHidden}
                title={showHidden ? "Hide dotfiles" : "Show dotfiles"} aria-label={showHidden ? "Hide dotfiles" : "Show dotfiles"}
                className="agent-icon-button ml-auto text-muted hover:bg-surface-2 hover:text-fg">{showHidden ? <Eye size={16} /> : <EyeOff size={16} />}</button>
            </div>
            <p className="truncate border-b border-line px-3 py-1.5 font-mono text-[11px] text-muted" title={listing?.path}>{shortPath(listing?.path, home)}</p>
            <ul className="min-h-0 flex-1 overflow-y-auto p-1">
              {!listing && !listError && <li className="flex items-center gap-2 p-2 text-xs text-muted"><Loader size={14} className="animate-spin" /> Loading…</li>}
              {listError && <li role="alert" className="p-2 text-xs text-bad">{listError}</li>}
              {listing && entries.length === 0 && <li className="p-2 text-xs text-muted">Empty folder.</li>}
              {entries.map((e) => {
                const path = join(e.name);
                const selected = file?.path === path;
                return (
                  <li key={e.name}>
                    <button type="button" onClick={() => e.dir ? void browse(path) : void open(path, false)} aria-current={selected ? "true" : undefined}
                      className={`flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-xs ${selected ? "bg-surface-2 text-fg" : "text-fg-2 hover:bg-surface-2 hover:text-fg"}`}>
                      {e.dir ? <Folder size={14} className="shrink-0 text-accent" aria-hidden /> : <File size={14} className="shrink-0 text-muted" aria-hidden />}
                      <span className="min-w-0 flex-1 truncate font-mono">{e.name}{e.dir ? "/" : ""}</span>
                      {!e.dir && <span className="shrink-0 text-[10px] text-muted">{formatSize(e.size)}</span>}
                    </button>
                  </li>
                );
              })}
              {listing?.truncated && <li className="p-2 text-[11px] text-muted">Only the first {listing.entries.length} entries are shown.</li>}
            </ul>
          </nav>

          <section aria-label="File preview" className={`min-h-0 min-w-0 flex-col md:flex ${pane === "file" ? "flex" : "hidden"}`}>
            <div className="flex min-h-12 items-center gap-1 border-b border-line px-2 py-1.5">
              <button type="button" onClick={() => setPane("list")} aria-label="Back to folder" className="agent-icon-button text-muted hover:bg-surface-2 hover:text-fg md:hidden"><ArrowLeft size={16} /></button>
              {file && file.kind !== "dir" ? <>
                <span className="flex min-w-0 flex-1 items-center gap-2 px-1">
                  {file.kind === "image" ? <ImageIcon size={14} className="shrink-0 text-muted" aria-hidden />
                    : file.kind === "video" ? <Video size={14} className="shrink-0 text-muted" aria-hidden />
                    : file.kind === "audio" ? <Music size={14} className="shrink-0 text-muted" aria-hidden />
                    : <FileCode size={14} className="shrink-0 text-muted" aria-hidden />}
                  <span className="truncate font-mono text-xs text-fg" title={file.path}>{file.name}</span>
                  <span className="shrink-0 text-[10px] text-muted">
                    {formatSize(file.size)}{file.kind === "text" ? ` · ${lines.length} lines` : ""} · {new Date(file.mtime * 1000).toLocaleString()}
                  </span>
                </span>
                {file.kind === "text" && isMarkdown(file.name) && (
                  <button type="button" onClick={() => setRendered((v) => !v)} aria-pressed={rendered} title={rendered ? "Show source" : "Show rendered"}
                    className="min-h-8 rounded-md px-2 text-[11px] text-muted hover:bg-surface-2 hover:text-fg">{rendered ? "Source" : "Rendered"}</button>
                )}
                {file.kind === "text" && (!isMarkdown(file.name) || !rendered) && (
                  <button type="button" onClick={() => setWrap((v) => !v)} aria-pressed={wrap} aria-label="Wrap lines" title="Wrap lines"
                    className={`agent-icon-button hover:bg-surface-2 hover:text-fg ${wrap ? "text-accent" : "text-muted"}`}><WrapText size={15} /></button>
                )}
                {file.kind === "text" && (
                  <button type="button" onClick={() => copy("text", file.text)} aria-label="Copy contents" title="Copy contents"
                    className="agent-icon-button text-muted hover:bg-surface-2 hover:text-fg">{copied === "text" ? <Check size={15} className="text-good" /> : <Copy size={15} />}</button>
                )}
                <button type="button" onClick={() => copy("path", file.path)} title="Copy path"
                  className="min-h-8 rounded-md px-2 text-[11px] text-muted hover:bg-surface-2 hover:text-fg">{copied === "path" ? "Copied" : "Copy path"}</button>
                <a href={rawUrl(file.path, { download: true })} download={file.name} aria-label={`Download ${file.name}`} title="Download"
                  className="agent-icon-button text-muted hover:bg-surface-2 hover:text-fg"><Download size={15} /></a>
              </> : <span className="px-1 text-xs text-muted">Choose a file to preview it.</span>}
            </div>

            <div className="min-h-0 flex-1 overflow-auto bg-bg">
              {loadingFile && <p className="flex items-center gap-2 p-4 text-xs text-muted"><Loader size={14} className="animate-spin" /> Loading…</p>}
              {!loadingFile && fileError && <p role="alert" className="m-3 rounded-lg border border-bad/30 bg-bad/10 p-2 text-xs text-bad">{fileError}</p>}
              {!loadingFile && file?.kind === "text" && (isMarkdown(file.name) && rendered
                ? <div className="md-body p-4 text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: renderMarkdown(file.text) }} />
                : <pre className={`file-code${wrap ? " is-wrapped" : ""}`}><code>{lines.map((l, i) => <span key={i} className="file-line">{l}</span>)}</code></pre>)}
              {!loadingFile && file?.kind === "text" && file.truncated && (
                <p className="border-t border-line p-3 text-[11px] text-warn">Only the first 512 KB is shown.</p>
              )}
              {!loadingFile && file?.kind === "image" && (
                <div className="file-image-wrap">
                  <img src={rawUrl(file.path, { version: file.mtime })} alt={file.name} className="max-h-full max-w-full object-contain"
                    onError={() => { setFile(null); setFileError(`Can't show ${file.name} as an image.`); }} />
                </div>
              )}
              {!loadingFile && file?.kind === "video" && (
                <div className="flex h-full items-center justify-center bg-black p-2">
                  <video key={file.path} src={rawUrl(file.path, { version: file.mtime })} controls playsInline className="max-h-full max-w-full"
                    onError={() => { setFile(null); setFileError(`Your browser can't play ${file.name}. Download it instead.`); }} />
                </div>
              )}
              {!loadingFile && file?.kind === "audio" && (
                <div className="p-6"><audio key={file.path} src={rawUrl(file.path, { version: file.mtime })} controls className="w-full" /></div>
              )}
              {!loadingFile && file?.kind === "binary" && (
                <p className="p-4 text-xs text-muted">
                  No preview for this file ({formatSize(file.size)}).{" "}
                  <a href={rawUrl(file.path, { download: true })} download={file.name} className="text-accent hover:underline">Download it</a>
                </p>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

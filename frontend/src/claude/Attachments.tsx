import { Download, FileArchive, FileText, Music } from "lucide-react";
import { useContext, useEffect, useState } from "react";
import { api } from "../api";
import { formatSize } from "./format";
import { FileContext } from "./openFile";
import { rawUrl } from "./paths";

interface FileStat {
  path: string;
  exists: boolean;
  resolved?: string;
  name?: string;
  size?: number;
  mtime?: number;
  kind?: "image" | "video" | "audio" | "file";
}
type Found = Required<FileStat>;

// History reloads remount every message (new ids); answer the same question from memory for a few seconds.
const STAT_TTL = 10_000;
const statCache = new Map<string, { at: number; result: Promise<FileStat[]> }>();

function statFiles(paths: string[], cwd: string | null): Promise<FileStat[]> {
  const key = `${cwd ?? ""}\n${paths.join("\n")}`;
  const hit = statCache.get(key);
  if (hit && Date.now() - hit.at < STAT_TTL) return hit.result;
  const result = api<FileStat[]>("/api/claude/file/stat", { method: "POST", body: JSON.stringify({ paths, cwd }) });
  statCache.set(key, { at: Date.now(), result });
  result.catch(() => statCache.delete(key));
  if (statCache.size > 200) statCache.delete(statCache.keys().next().value!);
  return result;
}

/** Files a reply handed over (paths it named that exist on the server), shown in the chat: images and video
 * inline, everything with a download button, so nobody has to copy them off the server by hand.
 * Looked up once the turn is over: a path is often named before the command that makes the file. */
export function Attachments({ paths }: { paths: string[] }) {
  const files = useContext(FileContext);
  const [found, setFound] = useState<Found[]>([]);
  const cwd = files?.cwd ?? null;
  const key = paths.join("\n");

  useEffect(() => {
    const list = key ? key.split("\n") : [];
    if (!list.length) { setFound([]); return; }
    let live = true;
    statFiles(list, cwd)
      .then((stats) => {
        if (!live) return;
        // Two spellings of one file (relative and absolute) show once.
        const unique = new Map<string, Found>();
        for (const s of stats) if (s.exists && s.resolved && !unique.has(s.resolved)) unique.set(s.resolved, s as Found);
        setFound([...unique.values()]);
      })
      .catch(() => { if (live) setFound([]); });
    return () => { live = false; };
  }, [key, cwd]);

  if (!found.length) return null;
  return (
    <div className="chat-attachments" aria-label="Attachments">
      {found.map((f) => <Attachment key={f.resolved} file={f} onOpen={files ? () => files.open(f.resolved) : undefined} />)}
    </div>
  );
}

function Attachment({ file, onOpen }: { file: Found; onOpen?: () => void }) {
  const [broken, setBroken] = useState(false);
  const src = rawUrl(file.resolved, { version: file.mtime });
  const media = broken ? "file" : file.kind;
  const Icon = /\.(zip|tar|gz|tgz|bz2|xz|zst|7z|rar)$/i.test(file.name) ? FileArchive : media === "audio" ? Music : FileText;

  return (
    <figure className={`chat-attachment is-${media}`}>
      {media === "image" && (
        <button type="button" onClick={onOpen} className="chat-attachment-media" title={`Open ${file.name}`} aria-label={`Open ${file.name}`}>
          <img src={src} alt={file.name} loading="lazy" onError={() => setBroken(true)} />
        </button>
      )}
      {media === "video" && (
        <video src={src} controls preload="metadata" playsInline className="chat-attachment-media" onError={() => setBroken(true)} />
      )}
      {media === "audio" && <audio src={src} controls preload="none" onError={() => setBroken(true)} />}
      <figcaption className="chat-attachment-bar">
        {media !== "image" && media !== "video" && <Icon size={15} className="shrink-0 text-muted" aria-hidden />}
        <button type="button" onClick={onOpen} disabled={!onOpen} title={file.resolved}
          className="min-w-0 flex-1 truncate text-left font-mono text-xs text-fg hover:text-accent">{file.name}</button>
        <span className="shrink-0 text-[10px] text-muted">{formatSize(file.size)}</span>
        <a href={rawUrl(file.resolved, { download: true })} download={file.name} title={`Download ${file.name}`} aria-label={`Download ${file.name}`}
          className="agent-icon-button shrink-0 text-muted hover:bg-surface-2 hover:text-fg"><Download size={15} /></a>
      </figcaption>
    </figure>
  );
}

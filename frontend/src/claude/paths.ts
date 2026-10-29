// File paths in chat replies: inline code that names a file opens the file viewer, and files Claude made for
// the user (media, documents, archives) show as attachments under its message.
import type { Part } from "./types";

const ROOTS = "home|tmp|var|etc|opt|srv|mnt|media|usr|root|run|data|workspace|snap|nix";
const ABSOLUTE = new RegExp(`^(?:~|~/[^\\s\`]*|/(?:${ROOTS})(?:/[^\\s\`]*)?)$`);
// Backticks mark where a path ends, so an absolute one may hold spaces, as long as it ends in an extension and
// has no " -" (that's a command line).
const ABSOLUTE_SPACED = new RegExp(`^(?:~|/(?:${ROOTS}))/[^\`]*\\.[A-Za-z][A-Za-z0-9]{0,7}$`);
// Extensions start with a letter: HTTP/1.1, 2026/10.29 and v1.2/3.4 aren't paths.
const RELATIVE = /^(?:\.{1,2}\/)?(?:[\w.@+-]+\/)+[\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,7}$|^\.\/[\w.@+-]+$/;
const DELIVERABLE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|mp4|m4v|webm|mov|mkv|avi|ogv|mp3|wav|ogg|oga|opus|m4a|flac|aac|pdf|docx?|xlsx?|pptx?|odt|ods|odp|csv|epub|zip|tar|gz|tgz|bz2|xz|zst|7z|rar|apk|deb|iso)$/i;
const BARE = new RegExp(`^[\\w.@+-]+${DELIVERABLE.source}`, "i");
export const MAX_ATTACHMENTS = 20;

/** The path an inline-code span names, without a `:line[:col]` suffix; null when it isn't one. */
export function filePath(code: string): string | null {
  const text = code.trim().replace(/:\d+(?::\d+)?$/, "");
  if (!text || text.includes("://") || text.length > 1024) return null;
  if (/\s/.test(text)) return ABSOLUTE_SPACED.test(text) && !/\s-|\s\s/.test(text) ? text : null;
  return ABSOLUTE.test(text) || RELATIVE.test(text) || BARE.test(text) ? text : null;
}

export const isDeliverable = (path: string) => DELIVERABLE.test(path);

/** Files a reply hands to the user: deliverable paths in its text (outside code blocks) and files it wrote. */
export function attachmentPaths(parts: Part[]): string[] {
  const found = new Set<string>();
  for (const part of parts) {
    if (part.kind === "text" && !part.is_error) {
      const prose = part.text.replace(/```[\s\S]*?(?:```|$)/g, "");
      for (const m of prose.matchAll(/`([^`\n]+)`/g)) {
        const path = filePath(m[1]);
        if (path && isDeliverable(path)) found.add(path);
      }
    } else if (part.kind === "tool" && part.name === "Write" && part.path && isDeliverable(part.path) && !part.is_error) {
      found.add(part.path);
    }
  }
  return [...found].slice(0, MAX_ATTACHMENTS);
}

/** A file's bytes from the server: inline (images, video, audio) or as a download. */
export function rawUrl(path: string, opts: { cwd?: string | null; download?: boolean; version?: number } = {}): string {
  const q = new URLSearchParams({ path });
  if (opts.cwd) q.set("cwd", opts.cwd);
  if (opts.download) q.set("download", "1");
  if (opts.version != null) q.set("v", String(opts.version));
  return `/api/claude/file/raw?${q}`;
}

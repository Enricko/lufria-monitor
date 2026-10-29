// Small Markdown renderer for chat text. Everything is escaped first, so model output,
// file contents and transcripts can never inject markup into the dashboard.
import { filePath } from "./paths";
import type { Part } from "./types";

export function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const HOLD = "\u0000";

function inline(text: string, held: string[], paths: boolean): string {
  const hold = (html: string) => `${HOLD}${held.push(html) - 1}${HOLD}`;
  // `paths`: code naming a file becomes a button for the file viewer (the chat handles clicks on [data-path]).
  // `c` is escaped already: safe in the attribute, and the browser decodes it back to the real path.
  text = text.replace(/`([^`\n]+)`/g, (_, c) => {
    const path = paths ? filePath(c) : null;
    return hold(path
      ? `<code class="md-code md-path" data-path="${path}" role="button" tabindex="0" title="Open ${path}">${c}</code>`
      : `<code class="md-code">${c}</code>`);
  });
  // Links: http(s) only; text and URL are already escaped.
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label, url) => hold(`<a class="md-link" href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`));
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*\w])\*([^*\n]+?)\*(?![*\w])/g, "$1<em>$2</em>");
  text = text.replace(/(^|[^\w])_([^_\n]+?)_(?!\w)/g, "$1<em>$2</em>");
  text = text.replace(/~~(.+?)~~/g, "<del>$1</del>");
  return text;
}

function tableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/** `paths`: make inline code that names a file clickable (chat messages). */
export function renderMarkdown(src: string, { paths = false }: { paths?: boolean } = {}): string {
  const held: string[] = [];
  const hold = (html: string) => `${HOLD}${held.push(html) - 1}${HOLD}`;

  // Fenced code first, so nothing inside is formatted.
  let text = src.replace(/\u0000/g, "").replace(/```([\w+-]*)[^\n]*\n?([\s\S]*?)(?:```|$)/g, (_, _lang, code) =>
    `\n${hold(`<pre class="md-pre"><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`)}\n`);
  text = escapeHtml(text);

  const lines = text.split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (new RegExp(`^${HOLD}\\d+${HOLD}$`).test(trimmed)) { closeList(); out.push(trimmed); continue; }
    if (!trimmed) { closeList(); continue; }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { closeList(); out.push('<hr class="md-rule"/>'); continue; }

    // Table: header row, then a |---|---| separator.
    if (trimmed.startsWith("|") && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1].trim())) {
      closeList();
      const head = tableRow(trimmed);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(tableRow(lines[i++]));
      i--;
      out.push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${head.map((c) => `<th>${inline(c, held, paths)}</th>`).join("")}</tr></thead><tbody>${
        rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, held, paths)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)/);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length, 3);
      out.push(`<h${level} class="md-h${level}">${inline(heading[2], held, paths)}</h${level}>`);
      continue;
    }
    const quote = trimmed.match(/^&gt;\s?(.*)/);
    if (quote) { closeList(); out.push(`<blockquote class="md-quote">${inline(quote[1], held, paths)}</blockquote>`); continue; }

    const bullet = line.match(/^\s*[-*+]\s+(.*)/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (bullet || numbered) {
      const kind = bullet ? "ul" : "ol";
      if (list !== kind) { closeList(); out.push(kind === "ul" ? '<ul class="md-ul">' : '<ol class="md-ol">'); list = kind; }
      let item = (bullet || numbered)![1];
      const box = item.match(/^\[( |x|X)\]\s+(.*)/);
      if (box) item = `${box[1] === " " ? "☐" : "☑"} ${box[2]}`;
      out.push(`<li>${inline(item, held, paths)}</li>`);
      continue;
    }
    closeList();
    out.push(`<p class="md-p">${inline(line, held, paths)}</p>`);
  }
  closeList();

  return out.join("").replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, "g"), (_, n) => held[Number(n)]);
}

/** Archived router conversations stored tool calls as HTML cards; read them back as parts. */
export function legacyTextToParts(text: string): Part[] {
  const parts: Part[] = [];
  const pushText = (t: string) => {
    const legacy = />\s*⚙️\s*\*\*([\w-]+):\*\*\s*`([^`]+)`/g;
    let last = 0;
    for (const m of t.matchAll(legacy)) {
      if (t.slice(last, m.index).trim()) parts.push({ kind: "text", text: t.slice(last, m.index).trim() });
      parts.push({ kind: "tool", id: `legacy-${parts.length}`, name: m[1], summary: m[2], output: "", is_error: false, done: true });
      last = m.index! + m[0].length;
    }
    if (t.slice(last).trim()) parts.push({ kind: "text", text: t.slice(last).trim() });
  };
  let last = 0;
  for (const m of text.matchAll(/<details[\s\S]*?<\/details>/gi)) {
    pushText(text.slice(last, m.index));
    // DOMParser never runs scripts; only textContent is kept.
    const doc = new DOMParser().parseFromString(m[0], "text/html");
    parts.push({
      kind: "tool", id: `legacy-${parts.length}`,
      name: (doc.querySelector(".tool-call-name")?.textContent || "Tool").replace(/:$/, ""),
      summary: doc.querySelector(".tool-call-cmd")?.textContent || "",
      output: doc.querySelector("pre")?.textContent || "", is_error: false, done: true,
    });
    last = m.index! + m[0].length;
  }
  pushText(text.slice(last));
  return parts;
}

/** Plain text of a message, for copying, export and quick replies. */
export function partsToText(parts: Part[]): string {
  return parts.map((p) => {
    switch (p.kind) {
      case "text": case "thinking": case "command_output": return p.text;
      case "command": return `${p.name} ${p.args}`.trim();
      case "tool": return `[${p.name}] ${p.summary}`;
      case "bash": return `! ${p.command ?? ""}\n${p.stdout ?? ""}${p.stderr ?? ""}`;
      case "notice": return `— ${p.text} —`;
      default: return "";
    }
  }).filter(Boolean).join("\n\n");
}

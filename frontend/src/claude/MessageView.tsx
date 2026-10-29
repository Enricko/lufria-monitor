import { Check, CheckCircle2, Circle, CircleDot, FileSearch, Image as ImageIcon, Loader, X } from "lucide-react";
import { memo, useContext, useMemo, type KeyboardEvent, type MouseEvent } from "react";
import { Attachments } from "./Attachments";
import { renderMarkdown } from "./markdown";
import { FileContext } from "./openFile";
import { attachmentPaths } from "./paths";
import type { ChatMsg, Part } from "./types";

type ToolPart = Extract<Part, { kind: "tool" }>;

/** The tool result Claude Code writes when the user picks "No" (or Esc) in its dialog. */
const REJECTED = "The user doesn't want to proceed with this tool use";
const rejected = (part: ToolPart) => part.is_error && part.output.startsWith(REJECTED);
/** What the user typed after "No", if anything. */
const rejectionNote = (part: ToolPart) => (rejected(part) ? part.output.split("the user said:\n")[1]?.trim() : undefined);

export function Markdown({ text, error }: { text: string; error?: boolean }) {
  const files = useContext(FileContext);
  // Inline code naming a file is rendered with data-path (markdown.ts); open it in the file viewer.
  const openPath = (e: MouseEvent | KeyboardEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-path]");
    if (!el?.dataset.path || !files) return;
    if (e.type === "click" && !window.getSelection()?.isCollapsed) return;  // selecting the path to copy it
    e.preventDefault();
    files.open(el.dataset.path);
  };
  return <div className={`md-body text-sm leading-relaxed${error ? " text-bad" : ""}`}
    onClick={files ? openPath : undefined}
    onKeyDown={files ? (e) => { if (e.key === "Enter" || e.key === " ") openPath(e); } : undefined}
    dangerouslySetInnerHTML={{ __html: renderMarkdown(text, { paths: Boolean(files) }) }} />;
}

/** AskUserQuestion in the conversation, as the terminal records it once the dialog is gone. */
function QuestionsCard({ part }: { part: ToolPart }) {
  const questions = part.questions ?? [];
  const answers = Object.entries(part.answers ?? {});
  let head = "Claude is asking you…";
  if (part.done && part.is_error) {
    head = part.output.startsWith("The user wants to clarify") ? "User chose to chat about Claude's questions" : "User declined to answer questions";
  } else if (part.done) head = "User answered Claude's questions:";
  return (
    <div className="cc-asked">
      <p className="cc-asked-head">{!part.done && <Loader size={11} className="animate-spin" />}{head}</p>
      <ul>
        {part.done && !part.is_error && answers.length
          ? answers.map(([q, a]) => <li key={q}>· {q} → <span className="text-fg">{a}</span></li>)
          : questions.map((q) => <li key={q.question}>· {q.question} <span className="text-muted">({q.options.map((o) => o.label).join(" / ")})</span></li>)}
      </ul>
      {part.done && !part.is_error && !answers.length && part.output && <p className="text-muted">{part.output}</p>}
    </div>
  );
}

function ToolCard({ part }: { part: ToolPart }) {
  const openFile = useContext(FileContext)?.open;
  const status = !part.done
    ? <span className="tool-call-badge-running"><Loader size={11} className="animate-spin" /> {part.name === "ExitPlanMode" ? "awaiting approval" : "running"}</span>
    : rejected(part)
      ? <span className="tool-call-badge-error"><X size={11} /> rejected</span>
      : part.is_error
        ? <span className="tool-call-badge-error"><X size={11} /> error</span>
        : <span className="tool-call-badge-done"><Check size={11} /> {part.name === "ExitPlanMode" ? "approved" : "done"}</span>;
  if (part.name === "AskUserQuestion" && part.questions?.length) return <QuestionsCard part={part} />;
  if (part.name === "ExitPlanMode" && part.plan) {
    const note = rejectionNote(part);
    return (
      <div className="plan-card">
        <div className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold text-fg">
          <span>Plan</span>{status}
        </div>
        <Markdown text={part.plan} />
        {note && <p className="mt-2 text-xs text-muted">Your feedback: <span className="text-fg-2">{note}</span></p>}
      </div>
    );
  }
  // The preview button sits over the row, not inside <summary>: a button inside a button isn't reliable.
  const preview = openFile && part.path ? part.path : null;
  return (
    <div className={`tool-call-wrap${preview ? " has-open" : ""}`}>
      <details className={`tool-call${part.is_error ? " is-error" : ""}`}>
        <summary>
          <span className="tool-call-left">
            <span className="tool-call-arrow" aria-hidden="true">▶</span>
            <span className="tool-call-name">{part.name}</span>
            <code className="tool-call-cmd" title={part.summary}>{part.summary}</code>
          </span>
          {status}
        </summary>
        <div className="tool-call-body">
          {part.todos && (
            <ul className="todo-list">
              {part.todos.map((t, i) => (
                <li key={i} className={t.status === "completed" ? "is-done" : ""}>
                  {t.status === "completed" ? <CheckCircle2 size={13} className="text-good" /> : t.status === "in_progress" ? <CircleDot size={13} className="text-accent" /> : <Circle size={13} className="text-muted" />}
                  <span>{t.content}</span>
                </li>
              ))}
            </ul>
          )}
          {part.diff && (
            <pre className="tool-diff"><code>{part.diff.split("\n").map((l, i) => (
              <span key={i} className={l.startsWith("+ ") ? "diff-add" : l.startsWith("- ") ? "diff-del" : ""}>{l}{"\n"}</span>
            ))}</code></pre>
          )}
          {part.output.trim()
            ? <pre><code>{part.output.trimEnd()}</code></pre>
            : !part.todos && !part.diff && <p className="tool-empty-output">{part.done ? "No output." : "Running…"}</p>}
        </div>
      </details>
      {preview && (
        <button type="button" className="tool-call-open" title={`Preview ${preview}`} aria-label={`Preview ${preview}`}
          onClick={() => openFile?.(preview)}>
          <FileSearch size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}

function BashBlock({ part }: { part: Extract<Part, { kind: "bash" }> }) {
  return (
    <div className="bash-block">
      <div className="bash-block-head">
        <span className="font-mono text-warn">!</span>
        <code className="min-w-0 flex-1 truncate">{part.command ?? ""}</code>
        {part.running ? <Loader size={12} className="animate-spin text-muted" />
          : part.code != null && part.code !== 0 ? <span className="text-[10px] text-bad">exit {part.code}</span> : null}
      </div>
      {(part.stdout || part.stderr) && (
        <pre><code>{part.stdout ?? ""}{part.stderr ? <span className="text-bad">{part.stderr}</span> : null}</code></pre>
      )}
    </div>
  );
}

export function PartView({ part }: { part: Part }) {
  switch (part.kind) {
    case "text": return <Markdown text={part.text} error={part.is_error} />;
    case "thinking":
      return (
        <details className="tool-call thinking-card">
          <summary><span className="tool-call-left"><span className="tool-call-arrow" aria-hidden="true">▶</span><span className="tool-call-name">✻ Thinking</span></span></summary>
          <div className="tool-call-body"><p className="whitespace-pre-wrap text-xs leading-relaxed text-muted">{part.text}</p></div>
        </details>
      );
    case "tool": return <ToolCard part={part} />;
    case "command":
      return <p className="font-mono text-sm"><span className="font-semibold text-accent">{part.name}</span>{part.args && <span className="text-fg"> {part.args}</span>}</p>;
    case "command_output":
      // /context and friends print Markdown; others are aligned plain text.
      return /^#{1,3} |\n\|.*\|\n/.test(part.text) && !part.is_error
        ? <div className="command-output-md"><Markdown text={part.text} /></div>
        : <pre className={`command-output${part.is_error ? " text-bad" : ""}`}><code>{part.text || "(no output)"}</code></pre>;
    case "bash": return <BashBlock part={part} />;
    case "image":
      return part.preview
        ? <img src={part.preview} alt="" className="max-h-40 max-w-full rounded-lg border border-line object-contain" />
        : <span className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[11px] text-muted"><ImageIcon size={12} /> image</span>;
    case "notice": return <NoticeRow part={part} />;
  }
}

export function NoticeRow({ part }: { part: Extract<Part, { kind: "notice" }> }) {
  const tone = part.level === "error" ? "text-bad" : part.level === "warn" ? "text-warn" : "text-muted";
  return (
    <div className={`chat-notice ${tone}`} role={part.level === "error" ? "alert" : undefined}>
      {part.detail
        ? <details><summary>{part.text}</summary><div className="chat-notice-detail"><Markdown text={part.detail} /></div></details>
        : <span>{part.text}</span>}
    </div>
  );
}

/** `settled`: the turn is over (attachments are looked up then). */
export const MessageParts = memo(function MessageParts({ msg, settled = true }: { msg: ChatMsg; settled?: boolean }) {
  const attachments = useMemo(() => msg.role === "assistant" && !msg.local ? attachmentPaths(msg.parts) : [], [msg.local, msg.parts, msg.role]);
  return (
    <>
      {msg.parts.map((part, i) => <PartView key={i} part={part} />)}
      {msg.streaming && <Markdown text={msg.streaming} />}
      {settled && attachments.length > 0 && <Attachments paths={attachments} />}
    </>
  );
});

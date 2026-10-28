import { Check, CheckCircle2, Circle, CircleDot, Image as ImageIcon, Loader, X } from "lucide-react";
import { memo } from "react";
import { renderMarkdown } from "./markdown";
import type { ChatMsg, Part } from "./types";

function Markdown({ text, error }: { text: string; error?: boolean }) {
  return <div className={`md-body text-sm leading-relaxed${error ? " text-bad" : ""}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}

function ToolCard({ part, onApprovePlan }: { part: Extract<Part, { kind: "tool" }>; onApprovePlan?: () => void }) {
  const status = !part.done
    ? <span className="tool-call-badge-running"><Loader size={11} className="animate-spin" /> running</span>
    : part.is_error
      ? <span className="tool-call-badge-error"><X size={11} /> {part.name === "ExitPlanMode" ? "awaiting approval" : "error"}</span>
      : <span className="tool-call-badge-done"><Check size={11} /> done</span>;
  if (part.name === "ExitPlanMode" && part.plan) {
    return (
      <div className="plan-card">
        <div className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold text-fg">
          <span>Plan</span>{status}
        </div>
        <Markdown text={part.plan} />
        {onApprovePlan && (
          <button type="button" onClick={onApprovePlan} className="mt-3 inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-semibold text-bg hover:bg-accent/85">
            <Check size={14} /> Approve plan and run
          </button>
        )}
      </div>
    );
  }
  return (
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

export function PartView({ part, onApprovePlan }: { part: Part; onApprovePlan?: () => void }) {
  switch (part.kind) {
    case "text": return <Markdown text={part.text} error={part.is_error} />;
    case "thinking":
      return (
        <details className="tool-call thinking-card">
          <summary><span className="tool-call-left"><span className="tool-call-arrow" aria-hidden="true">▶</span><span className="tool-call-name">✻ Thinking</span></span></summary>
          <div className="tool-call-body"><p className="whitespace-pre-wrap text-xs leading-relaxed text-muted">{part.text}</p></div>
        </details>
      );
    case "tool": return <ToolCard part={part} onApprovePlan={onApprovePlan} />;
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

export const MessageParts = memo(function MessageParts({ msg, onApprovePlan }: { msg: ChatMsg; onApprovePlan?: () => void }) {
  const lastPlan = msg.parts.map((p) => p.kind === "tool" && p.name === "ExitPlanMode").lastIndexOf(true);
  return (
    <>
      {msg.parts.map((part, i) => <PartView key={i} part={part} onApprovePlan={i === lastPlan ? onApprovePlan : undefined} />)}
      {msg.streaming && <Markdown text={msg.streaming} />}
    </>
  );
});

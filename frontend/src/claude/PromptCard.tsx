// Claude Code's dialogs in the browser: a tool permission, AskUserQuestion, plan approval.
// The CLI waits on a can_use_tool control request until the page answers (claude_chat.Run.answer).
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { shortPath } from "./format";
import { Markdown } from "./MessageView";
import type { PermissionMode, PermissionUpdate, PromptAnswer, PromptRequest, Question } from "./types";

/** What Claude Code tells the model, with the user's own words, after "No". */
const REJECTED_SAYING = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was "
  + "a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n";
const HINT = "Enter to select · ↑/↓ to navigate · Esc to cancel";

interface Option {
  label?: ReactNode;
  description?: string;
  /** A row you type into, like "Type something." or "No, and tell Claude what to do differently". */
  input?: { placeholder: string; value: string; onChange: (value: string) => void };
  /** Multi-select rows carry a checkbox. */
  checked?: boolean;
  /** Set apart under a rule, like "Chat about this". */
  apart?: boolean;
}

/** The terminal's select: ❯ marks the row, a digit picks it, ↑/↓ move, Enter chooses, Esc cancels. */
function Select({ label, options, onPick, onCancel, onKey, autoFocus, initial = 0, digits = true }: {
  label: string;
  options: Option[];
  onPick: (index: number) => void;
  onCancel: () => void;
  /** Keys the select itself doesn't use (question tabs); true when handled. */
  onKey?: (e: KeyboardEvent<HTMLDivElement>) => boolean;
  autoFocus?: boolean;
  /** The row marked at first. */
  initial?: number;
  /** Whether 1-9 pick a row. */
  digits?: boolean;
}) {
  const [focus, setFocus] = useState(initial);
  const listRef = useRef<HTMLDivElement>(null);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const id = useId();

  useEffect(() => { if (autoFocus) listRef.current?.focus({ preventScroll: true }); }, [autoFocus]);

  const moveTo = (i: number) => {
    setFocus(i);
    // An input row takes the keys once it is the marked one, as in the terminal.
    const list = listRef.current;
    if (list?.contains(document.activeElement)) (options[i].input ? inputs.current[i] : list)?.focus({ preventScroll: true });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    const typing = e.target instanceof HTMLInputElement;
    const n = options.length;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) moveTo((focus + 1) % n);
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) moveTo((focus - 1 + n) % n);
    else if (e.key === "Enter" && !e.shiftKey) onPick(focus);
    else if (e.key === "Escape") onCancel();
    else if (e.key === " " && !typing && options[focus].checked !== undefined) onPick(focus);
    else if (digits && !typing && /^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && Number(e.key) <= n) {
      const i = Number(e.key) - 1;
      moveTo(i);
      if (!options[i].input) onPick(i);
    } else if (!onKey?.(e)) return;
    e.preventDefault();  // the page's own Esc (stop) and type-to-compose skip handled keys
  };

  return (
    <div ref={listRef} role="listbox" tabIndex={0} aria-label={label} aria-activedescendant={`${id}-${focus}`}
      className="cc-select" onKeyDown={onKeyDown}>
      {options.map((o, i) => (
        <div key={i} id={`${id}-${i}`} role="option" aria-selected={i === focus}
          aria-checked={o.checked === undefined ? undefined : o.checked}
          className={`cc-option${i === focus ? " is-focused" : ""}${o.apart ? " is-apart" : ""}`}
          onClick={() => {
            setFocus(i);
            if (o.input) inputs.current[i]?.focus();
            else onPick(i);
          }}>
          <span className="cc-option-pointer" aria-hidden>{i === focus ? "❯" : ""}</span>
          <span className="cc-option-num">{i + 1}.</span>
          {o.checked !== undefined && <span className="cc-option-check" aria-hidden>{o.checked ? "[✔]" : "[ ]"}</span>}
          <span className="cc-option-body">
            {o.input ? (
              <span className="cc-option-line">
                {o.label && <span className="shrink-0">{o.label}</span>}
                <input ref={(el) => { inputs.current[i] = el; }} value={o.input.value} placeholder={o.input.placeholder}
                  aria-label={o.input.placeholder} autoComplete="off" onFocus={() => setFocus(i)}
                  onChange={(e) => o.input?.onChange(e.target.value)} />
              </span>
            ) : <span className="cc-option-label">{o.label}</span>}
            {o.description && <span className="cc-option-desc">{o.description}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AskUserQuestion
// ---------------------------------------------------------------------------

function readQuestions(input: Record<string, unknown>): Question[] {
  const raw: unknown[] = Array.isArray(input.questions) ? input.questions : [];
  return raw.flatMap((item) => {
    const q = item as Partial<Question> | null;
    if (!q || typeof q.question !== "string") return [];
    const options = (Array.isArray(q.options) ? q.options : [])
      .filter((o) => o && typeof o.label === "string")
      .map((o) => ({ label: o.label, description: typeof o.description === "string" ? o.description : "" }));
    return [{ question: q.question, header: typeof q.header === "string" ? q.header : "", multiSelect: q.multiSelect === true, options }];
  });
}

/** {question: answer} so far: the picked labels (joined for multi-select) or the typed text. */
function collect(questions: Question[], picks: Record<number, number[]>, typed: Record<number, string>): Record<string, string> {
  const out: Record<string, string> = {};
  questions.forEach((q, qi) => {
    const own = (typed[qi] ?? "").trim();
    const chosen = [...(picks[qi] ?? [])].sort((a, b) => a - b)
      .flatMap((i) => (i < q.options.length ? [q.options[i].label] : own ? [own] : []));
    if (chosen.length) out[q.question] = chosen.join(", ");
  });
  return out;
}

/** Claude Code's "Chat about this": the questions go back unanswered and Claude asks what to clarify. */
function clarify(questions: Question[], answers: Record<string, string>): string {
  return "The user wants to clarify these questions.\n"
    + "    This means they may have additional information, context or questions for you.\n"
    + "    Take their response into account and then reformulate the questions if appropriate.\n"
    + "    Start by asking them what they would like to clarify.\n"
    + "    Questions asked:\n"
    + questions.map((q) => `- "${q.question}"\n${answers[q.question] ? `  Answer: ${answers[q.question]}` : "  (No answer provided)"}`).join("\n");
}

function AskQuestions({ prompt, steal, answer }: { prompt: PromptRequest; steal: boolean; answer: (a: PromptAnswer) => void }) {
  const questions = useMemo(() => readQuestions(prompt.input), [prompt.input]);
  // Several questions get tabs and a review step, as in the terminal; a single one is answered by its pick.
  const review = questions.length > 1;
  const [tab, setTab] = useState(0);
  const [picks, setPicks] = useState<Record<number, number[]>>({});
  const [typed, setTyped] = useState<Record<number, string>>({});
  const moved = useRef(false);
  const answers = collect(questions, picks, typed);

  const decline = () => answer({ behavior: "deny", message: "User declined to answer questions", interrupt: true });
  const submit = (p = picks) => {
    const got = collect(questions, p, typed);
    if (Object.keys(got).length) answer({ behavior: "allow", answers: got });
  };
  const go = (t: number) => {
    moved.current = true;
    setTab(Math.max(0, Math.min(t, questions.length)));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!review) return false;
    const typing = e.target instanceof HTMLInputElement;
    if (e.key === "Tab") go(tab + (e.shiftKey ? -1 : 1));
    else if (e.key === "ArrowRight" && !typing) go(tab + 1);
    else if (e.key === "ArrowLeft" && !typing) go(tab - 1);
    else return false;
    return true;
  };

  if (!questions.length) {
    return (
      <>
        <p className="cc-prompt-title">Claude has a question</p>
        <p className="cc-prompt-note">It came in a form this page can't show.</p>
        <Select label="Answer" options={[{ label: "Decline and tell Claude in chat" }]} onPick={decline} onCancel={decline} autoFocus={steal} />
      </>
    );
  }

  const tabs = (
    <div className="cc-tabs" role={review ? "tablist" : undefined} aria-label="Questions">
      {review && <span aria-hidden className="text-muted">←</span>}
      {questions.map((q, i) => (review ? (
        <button key={i} type="button" role="tab" aria-selected={i === tab} onClick={() => go(i)}
          className={`cc-tab${i === tab ? " is-current" : ""}`}>
          {answers[q.question] ? "☒" : "☐"} {q.header || `Question ${i + 1}`}
        </button>
      ) : <span key={i} className="cc-tab is-current">☐ {q.header || "Question"}</span>))}
      {review && <>
        <button type="button" role="tab" aria-selected={tab === questions.length} onClick={() => go(questions.length)}
          className={`cc-tab${tab === questions.length ? " is-current" : ""}`}>✔ Submit</button>
        <span aria-hidden className="text-muted">→</span>
      </>}
    </div>
  );
  const hint = <p className="cc-prompt-hint">{HINT}{review ? " · Tab to switch questions" : ""}</p>;

  if (tab === questions.length) {
    const missing = questions.some((q) => !answers[q.question]);
    return (
      <>
        {tabs}
        <p className="cc-prompt-title">Review your answers</p>
        <ul className="cc-review">
          {questions.map((q) => (
            <li key={q.question}><span className="text-muted">● {q.question}</span> → <span>{answers[q.question] ?? "—"}</span></li>
          ))}
        </ul>
        {missing && <p className="cc-prompt-warn">⚠ You have not answered all questions</p>}
        <p className="cc-prompt-question">Ready to submit your answers?</p>
        <Select key="review" label="Submit your answers" options={[{ label: "Submit answers" }, { label: "Cancel" }]}
          onPick={(i) => (i === 0 ? submit() : decline())} onCancel={decline} onKey={onKey} autoFocus />
        {hint}
      </>
    );
  }

  const q = questions[tab];
  const n = q.options.length;
  const chosen = picks[tab] ?? [];
  const toggle = (i: number) => setPicks((prev) => {
    const cur = prev[tab] ?? [];
    return { ...prev, [tab]: cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i] };
  });
  const type = (value: string) => {
    setTyped((prev) => ({ ...prev, [tab]: value }));
    // Typing an answer of your own ticks its box.
    if (q.multiSelect) setPicks((prev) => {
      const cur = prev[tab] ?? [];
      if (value.trim() && !cur.includes(n)) return { ...prev, [tab]: [...cur, n] };
      if (!value.trim() && cur.includes(n)) return { ...prev, [tab]: cur.filter((x) => x !== n) };
      return prev;
    });
  };
  const next = (p: Record<number, number[]>) => (review ? go(tab + 1) : submit(p));
  const options: Option[] = [
    ...q.options.map((o, i) => ({ label: o.label, description: o.description || undefined,
      checked: q.multiSelect ? chosen.includes(i) : undefined })),
    { input: { placeholder: q.multiSelect ? "Type something" : "Type something.", value: typed[tab] ?? "", onChange: type },
      checked: q.multiSelect ? chosen.includes(n) : undefined },
    ...(q.multiSelect ? [{ label: review ? "Next" : "Submit", apart: true }] : []),
    { label: "Chat about this", apart: !q.multiSelect },
  ];
  const pick = (i: number) => {
    if (i === options.length - 1) {
      answer({ behavior: "deny", message: clarify(questions, answers) });
    } else if (q.multiSelect) {
      if (i < n || (i === n && !(typed[tab] ?? "").trim())) toggle(i);  // typed text already ticked its own box
      else if (i > n && answers[q.question]) next(picks);
    } else if (i < n || (typed[tab] ?? "").trim()) {
      const p = { ...picks, [tab]: [Math.min(i, n)] };
      setPicks(p);
      next(p);
    }
  };

  return (
    <>
      {tabs}
      <p className="cc-prompt-question font-semibold">{q.question}</p>
      {q.multiSelect && <p className="cc-prompt-note">Select all that apply</p>}
      <Select key={tab} label={q.question} options={options} onPick={pick} onCancel={decline} onKey={onKey}
        autoFocus={steal || moved.current} />
      {hint}
    </>
  );
}

// ---------------------------------------------------------------------------
// ExitPlanMode
// ---------------------------------------------------------------------------

function ApprovePlan({ prompt, steal, planReturn, answer }: {
  prompt: PromptRequest; steal: boolean; planReturn: PermissionMode; answer: (a: PromptAnswer) => void;
}) {
  const plan = typeof prompt.input.plan === "string" ? prompt.input.plan : "";
  const [feedback, setFeedback] = useState("");
  // Approving switches the rest of the turn (and the next ones) to the chosen mode, like the terminal.
  const choices: { label: string; mode: PermissionMode }[] = [
    ...(planReturn === "bypassPermissions" ? [{ label: "Yes, and bypass permissions", mode: "bypassPermissions" as const }] : []),
    { label: "Yes, auto-accept edits", mode: "acceptEdits" },
    { label: "Yes, manually approve edits", mode: "default" },
  ];
  const stop = () => answer({ behavior: "deny", interrupt: true });
  return (
    <>
      <p className="cc-prompt-title">Ready to code?</p>
      <p className="cc-prompt-note">Here is Claude's plan:</p>
      <div className="cc-prompt-plan"><Markdown text={plan || "(The plan is empty.)"} /></div>
      <p className="cc-prompt-question">Claude has written up a plan and is ready to execute. Would you like to proceed?</p>
      <Select label="Approve the plan" autoFocus={steal}
        options={[...choices.map((c) => ({ label: c.label })),
          { label: "No, keep planning", input: { placeholder: "Tell Claude what to change", value: feedback, onChange: setFeedback } }]}
        onPick={(i) => {
          if (i < choices.length) answer({ behavior: "allow", permissions: [{ type: "setMode", mode: choices[i].mode, destination: "session" }] });
          else if (feedback.trim()) answer({ behavior: "deny", message: REJECTED_SAYING + feedback.trim() });
          else stop();
        }}
        onCancel={stop} />
      <p className="cc-prompt-hint">{HINT}</p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Any other tool: "Do you want to proceed?"
// ---------------------------------------------------------------------------

const str = (v: unknown) => (typeof v === "string" ? v : "");
const basename = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

function clip(text: string, lines = 40): string {
  const all = text.split("\n");
  return all.length > lines ? `${all.slice(0, lines).join("\n")}\n… ${all.length - lines} more lines` : text;
}

function Diff({ edits }: { edits: unknown[] }) {
  const lines = (text: string) => (text ? clip(text, 30).split("\n") : []);
  const rows = edits.flatMap((e) => {
    const edit = (e ?? {}) as Record<string, unknown>;
    return [...lines(str(edit.old_string)).map((l) => `- ${l}`), ...lines(str(edit.new_string)).map((l) => `+ ${l}`)];
  });
  return (
    <pre className="cc-prompt-code">{rows.map((l, i) => (
      <span key={i} className={l.startsWith("+ ") ? "diff-add" : "diff-del"}>{l}{"\n"}</span>
    ))}</pre>
  );
}

/** The terminal's title, question and preview for one tool. */
function describe(prompt: PromptRequest): { title: string; question: ReactNode; content: ReactNode } {
  const inp = prompt.input;
  const path = str(inp.file_path) || str(inp.notebook_path);
  const note = (text: string) => (text ? <p className="cc-prompt-note">{text}</p> : null);
  const code = (text: string) => <pre className="cc-prompt-code">{text}</pre>;
  switch (prompt.tool_name) {
    case "Bash":
      return { title: "Bash command", question: "Do you want to proceed?", content: <>{code(str(inp.command))}{note(str(inp.description))}</> };
    case "Edit":
    case "MultiEdit":
      return { title: "Edit file", question: <>Do you want to make this edit to <b>{basename(path)}</b>?</>,
        content: <><p className="cc-prompt-path">{path}</p><Diff edits={Array.isArray(inp.edits) ? inp.edits : [inp]} /></> };
    case "Write":
      return { title: "Write file", question: <>Do you want to write <b>{basename(path)}</b>?</>,
        content: <><p className="cc-prompt-path">{path}</p>{code(clip(str(inp.content)))}</> };
    case "NotebookEdit":
      return { title: "Edit notebook", question: <>Do you want to make this edit to <b>{basename(path)}</b>?</>,
        content: <><p className="cc-prompt-path">{path}</p>{code(clip(str(inp.new_source)))}</> };
    case "WebFetch":
      return { title: "Fetch", question: "Do you want to proceed?", content: <>{code(str(inp.url))}{note(str(inp.prompt))}</> };
    case "WebSearch":
      return { title: "Web search", question: "Do you want to proceed?", content: code(str(inp.query)) };
    case "EnterPlanMode":
      return { title: "Enter plan mode?", question: "Would you like to proceed?",
        content: note("Claude wants to enter plan mode to explore and design an implementation approach. No code changes will be made until you approve the plan.") };
  }
  const mcp = prompt.tool_name.match(/^mcp__(.+?)__(.+)$/);
  const name = mcp ? `${mcp[1]} - ${mcp[2]}` : prompt.display_name || prompt.tool_name;
  const args = JSON.stringify(inp);
  return { title: prompt.title || (mcp ? "Tool use" : name), question: "Do you want to proceed?",
    content: <>{code(`${name}(${args.length > 1500 ? `${args.slice(0, 1500)}…` : args})${mcp ? " (MCP)" : ""}`)}{note(str(prompt.description) === name ? "" : str(prompt.description))}</> };
}

/** The "don't ask again" row for what the CLI suggests, worded like the terminal. */
function alwaysLabel(updates: PermissionUpdate[], cwd: string, home: string | null): ReactNode {
  const rules = updates.filter((u) => u.type === "addRules").flatMap((u) => u.rules ?? []);
  const dirs = updates.filter((u) => u.type === "addDirectories").flatMap((u) => u.directories ?? []);
  if (updates.some((u) => u.type === "setMode" && u.mode === "acceptEdits")) return "Yes, allow all edits during this session";
  if (rules.length && rules.every((r) => r.toolName === "Bash" && r.ruleContent)) {
    const commands = rules.map((r) => (r.ruleContent ?? "").replace(/:\*$/, ""));
    return <>Yes, and don't ask again for <b>{commands.join(", ")}</b> commands in <b>{shortPath(cwd, home)}</b></>;
  }
  if (dirs.length) return <>Yes, and always allow access to <b>{dirs.map((d) => shortPath(d, home)).join(", ")}</b> from this project</>;
  if (rules.length) {
    const user = updates.some((u) => u.destination === "userSettings") ? " in any project (user settings)" : "";
    return <>Yes, and don't ask again for <b>{rules.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)).join(", ")}</b>{user}</>;
  }
  return "Yes, and don't ask again";
}

function ToolPermission({ prompt, steal, cwd, home, answer }: {
  prompt: PromptRequest; steal: boolean; cwd: string; home: string | null; answer: (a: PromptAnswer) => void;
}) {
  const [feedback, setFeedback] = useState("");
  const { title, question, content } = describe(prompt);
  // Rules saved to settings are what "don't ask again" means; the CLI can rule them out for this ask.
  const suggestions = (prompt.permission_suggestions ?? [])
    .filter((u) => !prompt.suppress_always_allow_rule || u.destination === "session");
  const planEntry = prompt.tool_name === "EnterPlanMode";
  const stop = () => answer({ behavior: "deny", interrupt: true });
  const options: Option[] = planEntry
    ? [{ label: "Yes, enter plan mode" }, { label: "No, start implementing now" }]
    : [{ label: "Yes" }, ...(suggestions.length ? [{ label: alwaysLabel(suggestions, cwd, home) }] : []),
      { label: "No,", input: { placeholder: "and tell Claude what to do differently (esc)", value: feedback, onChange: setFeedback } }];
  const pick = (i: number) => {
    if (i === 0) answer({ behavior: "allow" });
    else if (planEntry) answer({ behavior: "deny", message: "User declined to enter plan mode. Go ahead with the task without planning first." });
    else if (i === 1 && suggestions.length) answer({ behavior: "allow", permissions: suggestions });
    else if (feedback.trim()) answer({ behavior: "deny", message: REJECTED_SAYING + feedback.trim() });
    else stop();
  };
  return (
    <>
      <p className="cc-prompt-title">{title}</p>
      {prompt.agent_id && <p className="cc-prompt-note">Asked by a subagent</p>}
      <div className="cc-prompt-content">{content}</div>
      {prompt.blocked_path && <p className="cc-prompt-note">Outside the folders Claude may use: <code>{prompt.blocked_path}</code></p>}
      {prompt.decision_reason && <p className="cc-prompt-warn">{prompt.decision_reason}</p>}
      <p className="cc-prompt-question">{question}</p>
      <Select label={typeof question === "string" ? question : title} options={options} onPick={pick} onCancel={stop} autoFocus={steal}
        initial={prompt.default_to_no ? options.length - 1 : 0} digits={!prompt.default_to_no} />
      <p className="cc-prompt-hint">{HINT}</p>
    </>
  );
}

// ---------------------------------------------------------------------------

/** The prompt the CLI is waiting on, docked above the composer where the terminal shows its dialog. */
export function PromptCard({ prompt, more, cwd, home, planReturn, onAnswer }: {
  prompt: PromptRequest;
  /** Prompts waiting behind this one (parallel tool calls). */
  more: number;
  cwd: string;
  home: string | null;
  /** The mode plan mode was entered from: approving the plan can return to it. */
  planReturn: PermissionMode;
  onAnswer: (prompt: PromptRequest, answer: PromptAnswer) => void;
}) {
  // The terminal's dialog takes the keys; here too, unless a message is half typed or a window is open over the chat.
  const [steal] = useState(() => {
    const el = document.activeElement;
    return !(el instanceof HTMLTextAreaElement && el.value.trim()) && !document.querySelector("[aria-modal='true']");
  });
  const answer = (a: PromptAnswer) => onAnswer(prompt, a);
  const kind = prompt.tool_name === "AskUserQuestion" ? "question" : prompt.tool_name === "ExitPlanMode" ? "plan" : "permission";
  return (
    <section role="dialog" aria-label="Claude Code is waiting for your answer" className={`cc-prompt is-${kind}`}>
      {more > 0 && <span className="cc-prompt-more">1 of {more + 1}</span>}
      {kind === "question" ? <AskQuestions prompt={prompt} steal={steal} answer={answer} />
        : kind === "plan" ? <ApprovePlan prompt={prompt} steal={steal} planReturn={planReturn} answer={answer} />
        : <ToolPermission prompt={prompt} steal={steal} cwd={cwd} home={home} answer={answer} />}
    </section>
  );
}

import { Activity, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePoll } from "../api";
import { Swatch } from "../components/ui";
import { familyColor, familyOf, type Analytics } from "./AnalyticsOverview";
import { formatAgo, formatCost, formatTokens } from "./format";
import type { ModelUsage, SessionUsage, TurnUsage } from "./types";

interface Props {
  /** What the picker says (may be a combo); `note` is the picker's description of it. */
  selected: { value: string; name: string; note?: string };
  /** The model that answered last: with a combo it changes between plan, work and review. */
  currentModel: string | null;
  running: boolean;
  activity: string | null;
  /** Characters of the reply streamed so far, for a rough speed. */
  streamedChars: number;
  usage: SessionUsage;
  replies: number;
  lastTurn: TurnUsage | null;
  onClose: () => void;
}

function Row({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5" title={title}>
      <dt className="text-muted">{label}</dt>
      <dd className="font-mono tabular-nums text-fg">{value}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-3">
      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">{title}</h3>
      {children}
    </section>
  );
}

const cost = (m: { cost_usd: number | null; estimated?: boolean }) =>
  m.cost_usd == null ? "n/a" : `${m.estimated ? "≈ " : ""}${formatCost(m.cost_usd)}`;

/** Elapsed seconds of the running turn, ticking while it runs. */
function useElapsed(running: boolean): number {
  const since = useRef(0);
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!running) { since.current = 0; return; }
    since.current = Date.now();
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [running]);
  return running && since.current ? Math.max(0, (now - since.current) / 1000) : 0;
}

/** Right of the chat: the model answering now and everything counted for it, live. */
export function ModelLivePanel({ selected, currentModel, running, activity, streamedChars, usage, replies, lastTurn, onClose }: Props) {
  const { data: today } = usePoll<Analytics>("/api/claude/analytics?range=today", 4000);
  const elapsed = useElapsed(running);
  const model = currentModel ?? (selected.value === "default" ? null : selected.value);
  const family = model ? familyOf(model) : null;
  const isCombo = selected.value.startsWith("official-");
  const mine: ModelUsage | undefined = model ? usage.models.find((m) => m.model === model) : undefined;
  const todayRow = model ? today?.by_model.find((m) => m.model === model) : undefined;
  const streamedTokens = Math.round(streamedChars / 4);
  const sessionTokens = usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
  const inUseElsewhere = today?.live_models.filter((m) => m !== model) ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="flex items-center gap-1.5">
          <Activity size={14} className="text-accent" aria-hidden />
          <h2 className="text-xs font-semibold text-fg">Model in use</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="Close model panel" title="Close"
          className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg">
          <X size={15} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto text-xs" aria-live="off">
        <section className="border-b border-line px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              {family && <Swatch color={familyColor(family)} />}
              <span className="truncate font-mono text-sm font-semibold text-fg" title={model ?? undefined}>{model ?? selected.name}</span>
            </span>
            <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
              running ? "border-accent/40 bg-accent/15 text-accent" : "border-line-strong text-muted"}`}>
              {running && <span className="size-1.5 animate-pulse rounded-full bg-accent" aria-hidden />}
              {running ? "Running" : "Idle"}
            </span>
          </div>
          {(isCombo || !model) && (
            <p className="mt-1.5 leading-relaxed text-muted">
              <span className="text-fg-2">{selected.name}</span>{selected.note ? ` · ${selected.note}` : ""}
            </p>
          )}
          {!model && <p className="mt-1.5 text-muted">The model shows after the first reply.</p>}
          {inUseElsewhere.length > 0 && (
            <p className="mt-1.5 text-muted">Also active in other sessions: <span className="text-fg-2">{inUseElsewhere.join(", ")}</span></p>
          )}
        </section>

        {running && (
          <Section title="This turn">
            <dl>
              <Row label="Elapsed" value={`${elapsed.toFixed(1)}s`} />
              <Row label="Doing" value={activity ?? "Working"} />
              {streamedTokens > 0 && <Row label="Streamed" value={`≈ ${formatTokens(streamedTokens)} tok`} title="Estimated from the text received so far" />}
              {streamedTokens > 0 && elapsed >= 1 && <Row label="Speed" value={`≈ ${(streamedTokens / elapsed).toFixed(0)} tok/s`} title="Estimated, includes time spent in tools" />}
            </dl>
          </Section>
        )}

        <Section title="Context">
          <dl>
            <Row label="Tokens now" value={formatTokens(usage.context_tokens)} title="What the model read on its latest call: the context window now" />
          </dl>
        </Section>

        <Section title={`This conversation${model ? ` · ${model}` : ""}`}>
          {mine ? (
            <dl>
              <Row label="Input" value={formatTokens(mine.input_tokens)} title={`${mine.input_tokens.toLocaleString()} uncached input tokens`} />
              <Row label="Output" value={formatTokens(mine.output_tokens)} title={`${mine.output_tokens.toLocaleString()} output tokens`} />
              <Row label="Cache read" value={formatTokens(mine.cache_read_input_tokens)} />
              <Row label="Cache write" value={formatTokens(mine.cache_creation_input_tokens)} />
              <Row label="Cost" value={cost(mine)} />
            </dl>
          ) : <p className="text-muted">Nothing counted for this model yet.</p>}
          <dl className="mt-2 border-t border-line/60 pt-1.5">
            <Row label="Replies" value={replies} />
            <Row label="All models" value={`${formatTokens(sessionTokens)} tok · ${usage.unpriced && !usage.total_cost_usd ? "n/a" : `${usage.estimated ? "≈ " : ""}${formatCost(usage.total_cost_usd)}`}`} />
          </dl>
        </Section>

        {usage.models.length > 1 && (
          <Section title="Models in this conversation">
            <ul className="space-y-1">
              {usage.models.map((m) => (
                <li key={m.model} className="flex items-center gap-2 font-mono">
                  <Swatch color={familyColor(familyOf(m.model))} />
                  <span className={`min-w-0 flex-1 truncate ${m.model === model ? "text-fg" : "text-fg-2"}`} title={m.model}>{m.model}</span>
                  <span className="shrink-0 tabular-nums text-muted">{formatTokens(m.input_tokens + m.output_tokens + m.cache_read_input_tokens + m.cache_creation_input_tokens)}</span>
                  <span className="w-14 shrink-0 text-right tabular-nums text-fg-2">{cost(m)}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {lastTurn && (
          <Section title="Last turn">
            <dl>
              <Row label="Model" value={lastTurn.model || "—"} />
              <Row label="In / out" value={`${formatTokens(lastTurn.input_tokens + lastTurn.cache_read_input_tokens + lastTurn.cache_creation_input_tokens)} / ${formatTokens(lastTurn.output_tokens)}`} />
              <Row label="Cost" value={lastTurn.unpriced && !lastTurn.total_cost_usd ? "n/a" : `${lastTurn.estimated ? "≈ " : ""}${formatCost(lastTurn.total_cost_usd)}`} />
            </dl>
          </Section>
        )}

        <Section title="Today · all conversations">
          {todayRow ? (
            <dl>
              <Row label="Requests" value={todayRow.requests.toLocaleString()} />
              <Row label="Input" value={formatTokens(todayRow.input_tokens + todayRow.cache_write_tokens)} />
              <Row label="Cache read" value={formatTokens(todayRow.cache_read_tokens)} />
              <Row label="Output" value={formatTokens(todayRow.output_tokens)} />
              <Row label="Cost" value={`~${formatCost(todayRow.cost_usd)}`} title="API-equivalent price, not what a subscription bills" />
              <Row label="Last used" value={formatAgo(todayRow.last_used)} />
            </dl>
          ) : <p className="text-muted">{today ? "No requests today for this model." : "Loading…"}</p>}
        </Section>
      </div>
    </div>
  );
}

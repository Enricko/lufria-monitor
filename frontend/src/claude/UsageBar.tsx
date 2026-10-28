import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { formatCost, formatTokens } from "./format";
import type { ModelUsage, SessionUsage } from "./types";

const COUNTS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;

export const EMPTY_USAGE: SessionUsage = {
  input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  total_cost_usd: 0, estimated: false, unpriced: false, context_tokens: 0, models: [],
};

/** Fill in fields an older server leaves out. */
export function toUsage(raw: Partial<SessionUsage> | null | undefined): SessionUsage {
  if (!raw) return EMPTY_USAGE;
  const out: SessionUsage = { ...EMPTY_USAGE, ...raw, models: Array.isArray(raw.models) ? raw.models : [] };
  for (const key of COUNTS) out[key] = Number(raw[key]) || 0;
  out.total_cost_usd = Number(raw.total_cost_usd) || 0;
  out.context_tokens = Number(raw.context_tokens) || 0;
  return out;
}

/** Session so far + one more turn, merged per model. */
export function addUsage(a: SessionUsage, b: SessionUsage): SessionUsage {
  const models = new Map<string, ModelUsage>(a.models.map((m) => [m.model, { ...m }]));
  for (const m of b.models) {
    const prev = models.get(m.model);
    if (!prev) { models.set(m.model, { ...m }); continue; }
    for (const key of COUNTS) prev[key] += m[key];
    prev.cost_usd = prev.cost_usd == null && m.cost_usd == null ? null : (prev.cost_usd ?? 0) + (m.cost_usd ?? 0);
    prev.estimated ||= m.estimated;
  }
  const out = { ...a, models: [...models.values()] };
  for (const key of COUNTS) out[key] = a[key] + b[key];
  out.total_cost_usd = a.total_cost_usd + b.total_cost_usd;
  out.estimated = a.estimated || b.estimated;
  out.unpriced = a.unpriced || b.unpriced;
  out.context_tokens = b.context_tokens || a.context_tokens;
  return out;
}

function Stat({ label, value, title }: { label: string; value: string; title: string }) {
  return (
    <span className="usage-stat" title={title}>
      <span className="text-muted">{label}</span> <span className="text-fg-2">{value}</span>
    </span>
  );
}

/** Under the composer: this conversation's tokens by kind and what they cost. */
export function UsageBar({ usage, subscription }: { usage: SessionUsage; subscription: string | null }) {
  const [open, setOpen] = useState(false);
  const priced = usage.total_cost_usd > 0 || !usage.unpriced;
  const cost = priced ? `${usage.estimated ? "≈ " : ""}${formatCost(usage.total_cost_usd)}` : "n/a";
  const costNote = [
    usage.estimated && "Custom-model prices are estimates from the price table on the server.",
    !usage.estimated && usage.total_cost_usd > 0 && "Claude prices as Claude Code reports them.",
    subscription && "With a Claude subscription this is the API-equivalent price, not what you're billed.",
    usage.unpriced && "Some turns have no price (older sessions without Claude Code's cost record).",
  ].filter(Boolean).join(" ");

  return (
    <div className="agent-usage">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="agent-usage-models"
        className="agent-usage-line" title="Tokens and cost of this conversation · click for the split per model">
        <Stat label="context" value={formatTokens(usage.context_tokens)} title="Tokens the model read on its latest call: what the context window holds now" />
        <Stat label="in" value={formatTokens(usage.input_tokens)} title={`${usage.input_tokens.toLocaleString()} uncached input tokens`} />
        <Stat label="out" value={formatTokens(usage.output_tokens)} title={`${usage.output_tokens.toLocaleString()} output tokens`} />
        <Stat label="cache read" value={formatTokens(usage.cache_read_input_tokens)} title={`${usage.cache_read_input_tokens.toLocaleString()} input tokens read from the prompt cache (about 10% of the input price)`} />
        <Stat label="cache write" value={formatTokens(usage.cache_creation_input_tokens)} title={`${usage.cache_creation_input_tokens.toLocaleString()} input tokens written to the prompt cache (about 125% of the input price)`} />
        <span className="usage-stat usage-cost" title={costNote || "Estimated cost of this conversation"}>
          <span className="text-muted">cost</span> <span className="font-semibold text-fg">{cost}</span>
          {usage.estimated && <span className="text-muted"> est.</span>}
        </span>
        {usage.models.length > 0 && <ChevronDown size={12} aria-hidden className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} />}
      </button>
      {open && usage.models.length > 0 && (
        <div id="agent-usage-models" className="agent-usage-models">
          <table>
            <thead>
              <tr><th scope="col">Model</th><th scope="col">In</th><th scope="col">Out</th><th scope="col">Cache read</th><th scope="col">Cache write</th><th scope="col">Cost</th></tr>
            </thead>
            <tbody>
              {usage.models.map((m) => (
                <tr key={m.model}>
                  <td className="font-mono" title={m.model}>{m.model}</td>
                  <td>{formatTokens(m.input_tokens)}</td>
                  <td>{formatTokens(m.output_tokens)}</td>
                  <td>{formatTokens(m.cache_read_input_tokens)}</td>
                  <td>{formatTokens(m.cache_creation_input_tokens)}</td>
                  <td>{m.cost_usd == null ? "n/a" : `${m.estimated ? "≈ " : ""}${formatCost(m.cost_usd)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {costNote && <p className="mt-1.5 text-[10px] leading-relaxed text-muted">{costNote}</p>}
        </div>
      )}
    </div>
  );
}

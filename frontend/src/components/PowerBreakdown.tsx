import type { LivePower } from "../api";
import { watts } from "../format";
import { COMPONENTS } from "../palette";
import { Row, Tag } from "./ui";

const KIND_LABEL = { measured: "measured", modelled: "WattSeal model", configured: "your setting" } as const;

/** One 100% stacked bar of live power by component + a labelled row per component. */
export function PowerBreakdown({ power, compact }: { power: LivePower | undefined; compact?: boolean }) {
  const comps = power?.components;
  // GPU stays listed at 0 W while the dGPU sleeps, so it's clear it is counted
  const parts = COMPONENTS.map((c) => ({ ...c, w: comps?.[c.key] ?? null }))
    .filter((c) => c.w != null && (c.w > 0 || c.key === "gpu"));
  const total = parts.reduce((s, c) => s + (c.w ?? 0), 0);
  return (
    <div>
      <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full" role="img"
        aria-label={parts.map((c) => `${c.label} ${watts(c.w)}`).join(", ")}>
        {total > 0 ? (
          parts.map((c) => (
            <div key={c.key} className="h-full transition-[flex-grow] duration-300" style={{ flexGrow: c.w ?? 0, background: c.color }} />
          ))
        ) : (
          <div className="h-full w-full bg-surface-2" />
        )}
      </div>
      <div className={`mt-3 ${compact ? "" : "divide-y divide-line"}`}>
        {parts.map((c) => (
          <Row
            key={c.key}
            swatch={c.color}
            label={c.label}
            sub={c.key === "gpu" && c.w === 0 ? <Tag>sleeping</Tag> : !compact && <Tag>{KIND_LABEL[c.kind]}</Tag>}
            value={
              <>
                {watts(c.w)}
                <span className="ml-2 inline-block w-10 text-right text-muted">{total ? `${(((c.w ?? 0) / total) * 100).toFixed(0)}%` : ""}</span>
              </>
            }
          />
        ))}
      </div>
    </div>
  );
}

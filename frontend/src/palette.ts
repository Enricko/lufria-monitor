/**
 * Chart colors. Categorical slots are the dataviz reference palette's dark steps,
 * in fixed order, validated on the #0f172a surface (all checks pass, worst adjacent
 * CVD ΔE 8.4). Colors follow the entity, never its rank.
 */
export const SURFACE = "#0f172a";
export const GRID = "#1e293b";
export const AXIS_TEXT = "#94a3b8";
export const TEXT = "#f8fafc";

export const SLOT = {
  blue: "#3987e5",
  orange: "#d95926",
  aqua: "#199e70",
  yellow: "#c98500",
  magenta: "#d55181",
  violet: "#9085e9",
} as const;

/** Neutral for "other / unattributed" folds. */
export const NEUTRAL = "#64748b";

/** Power components, in stack order (bottom -> top). */
export const COMPONENTS = [
  { key: "cpu", label: "CPU", color: SLOT.blue, kind: "measured" },
  { key: "ram", label: "Memory", color: SLOT.orange, kind: "modelled" },
  { key: "disk", label: "Storage", color: SLOT.aqua, kind: "modelled" },
  { key: "net", label: "Network", color: SLOT.yellow, kind: "modelled" },
  { key: "gpu", label: "GPU", color: SLOT.magenta, kind: "measured" },
  { key: "overhead", label: "Platform", color: SLOT.violet, kind: "configured" },
] as const;

export type ComponentKey = (typeof COMPONENTS)[number]["key"];

/** Status colors are reserved for state and always ship with an icon + label. */
export const STATUS = { good: "#22c55e", warn: "#f59e0b", bad: "#ef4444" } as const;

export const ACCENT = "#22c55e";

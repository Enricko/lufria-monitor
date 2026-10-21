import type { LucideIcon } from "lucide-react";
import { AlertTriangle, CheckCircle2, CircleHelp, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { Severity } from "../format";
import { STATUS } from "../palette";

export function Card({ title, icon: Icon, actions, children, className = "", bodyClass = "" }: {
  title?: ReactNode;
  icon?: LucideIcon;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
}) {
  return (
    <section className={`min-w-0 rounded-2xl border border-line bg-surface ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
          <h2 className="flex items-center gap-2 text-sm font-medium text-fg-2">
            {Icon && <Icon size={16} className="text-muted" aria-hidden />}
            {title}
          </h2>
          {actions}
        </header>
      )}
      <div className={`p-5 ${bodyClass}`}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

/** Stat tile: label · value (+unit) · optional sub line, meter and sparkline slot. */
export function Kpi({ label, value, unit, sub, children }: {
  label: string;
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="truncate text-3xl font-semibold tracking-tight">{value}</span>
        {unit && <span className="text-sm text-muted">{unit}</span>}
      </div>
      {sub && <div className="mt-0.5 truncate text-xs text-muted">{sub}</div>}
      {children}
    </div>
  );
}

const SEVERITY_FILL: Record<Severity, string> = { good: STATUS.good, warn: STATUS.warn, bad: STATUS.bad };

/** Meter: fill carries severity, track is a dim step of the same hue. */
export function Meter({ value, label, severity = "good", color, className = "" }: {
  value: number;
  label: string;
  severity?: Severity;
  color?: string;
  className?: string;
}) {
  const fill = color ?? SEVERITY_FILL[severity];
  const v = Math.min(100, Math.max(0, value));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
      className={`h-1.5 overflow-hidden rounded-full ${className}`}
      style={{ background: `${fill}26` }}
    >
      <div className="h-full rounded-full transition-[width] duration-300 ease-out" style={{ width: `${v}%`, background: fill }} />
    </div>
  );
}

const STATUS_META: Record<Severity | "unknown", { icon: LucideIcon; cls: string }> = {
  good: { icon: CheckCircle2, cls: "bg-good/10 text-good" },
  warn: { icon: AlertTriangle, cls: "bg-warn/10 text-warn" },
  bad: { icon: XCircle, cls: "bg-bad/10 text-bad" },
  unknown: { icon: CircleHelp, cls: "bg-surface-2 text-muted" },
};

/** Status pill: always icon + label, never color alone. */
export function Status({ state, children }: { state: Severity | "unknown"; children: ReactNode }) {
  const { icon: Icon, cls } = STATUS_META[state];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      <Icon size={12} aria-hidden />
      {children}
    </span>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="rounded-md border border-line-strong px-1.5 py-0.5 text-[11px] text-muted">{children}</span>;
}

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg border border-line bg-bg p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`h-9 min-w-11 cursor-pointer rounded-md px-3 text-xs font-medium transition-colors duration-150 ${
            value === o.value ? "bg-surface-2 text-fg" : "text-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Button({ children, onClick, disabled, variant = "secondary", icon: Icon, type = "button" }: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary";
  icon?: LucideIcon;
  type?: "button" | "submit";
}) {
  const cls =
    variant === "primary"
      ? "bg-accent text-bg hover:bg-accent/90"
      : "border border-line-strong bg-surface-2 text-fg hover:border-muted";
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${cls}`}
    >
      {Icon && <Icon size={16} aria-hidden />}
      {children}
    </button>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-surface-2 ${className}`} aria-hidden />;
}

export function Empty({ icon: Icon, children, className = "" }: { icon: LucideIcon; children: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col items-center justify-center gap-2 px-4 py-8 text-center text-sm text-muted ${className}`}>
      <Icon size={22} aria-hidden />
      <div>{children}</div>
    </div>
  );
}

export function Swatch({ color, line }: { color: string; line?: boolean }) {
  return line ? (
    <span className="inline-block h-0.5 w-3 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
  ) : (
    <span className="inline-block size-2.5 shrink-0 rounded-sm" style={{ background: color }} aria-hidden />
  );
}

export function Legend({ items }: { items: { label: string; color: string; line?: boolean }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-2">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <Swatch color={i.color} line={i.line} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

/** Label/value row used in spec lists and breakdowns. */
export function Row({ label, value, sub, swatch }: { label: ReactNode; value: ReactNode; sub?: ReactNode; swatch?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="flex min-w-0 items-center gap-2 text-fg-2">
        {swatch && <Swatch color={swatch} />}
        <span className="truncate">{label}</span>
        {sub}
      </span>
      <span className="tnum shrink-0 font-mono text-[13px]">{value}</span>
    </div>
  );
}

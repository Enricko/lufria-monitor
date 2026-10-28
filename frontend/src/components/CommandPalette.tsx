import { Bot, FileText, Folder, Sparkles, Terminal, Wrench } from "lucide-react";
import { useEffect, useRef } from "react";
import type { PaletteItem } from "../claude/commands";

const ICONS: Record<PaletteItem["kind"], React.ReactNode> = {
  page: <Wrench size={14} className="text-accent" />,
  cli: <Terminal size={14} className="text-accent" />,
  skill: <Sparkles size={14} className="text-accent" />,
  file: <FileText size={14} className="text-muted" />,
  dir: <Folder size={14} className="text-muted" />,
  agent: <Bot size={14} className="text-accent" />,
};

interface CommandPaletteProps {
  open: boolean;
  title: string;
  items: PaletteItem[];
  selectedIndex: number;
  loading?: boolean;
  onSelect: (item: PaletteItem) => void;
}

/** Suggestions above the composer for `/` commands and `@` mentions. Keys are handled by the textarea. */
export function CommandPalette({ open, title, items, selectedIndex, loading, onSelect }: CommandPaletteProps) {
  const list = useRef<HTMLDivElement>(null);
  const active = items.length ? ((selectedIndex % items.length) + items.length) % items.length : -1;

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  if (!open || (!items.length && !loading)) return null;

  return (
    <div
      className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-xl border border-line bg-surface-2/95 backdrop-blur-md shadow-2xl z-30"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line/60 px-3 py-1.5 text-[11px] font-medium text-muted bg-surface/50">
        <span className="truncate">{title}</span>
        <span className="hidden shrink-0 text-[10px] sm:inline">
          <kbd className="palette-kbd">↑</kbd> <kbd className="palette-kbd">↓</kbd> select · <kbd className="palette-kbd">Tab</kbd> complete · <kbd className="palette-kbd">Enter</kbd> run
        </span>
      </div>
      <div ref={list} role="listbox" aria-label={title} className="overflow-y-auto p-1 max-h-[min(300px,45dvh)]">
        {loading && !items.length && <p className="px-3 py-2 text-xs text-muted">Searching…</p>}
        {items.map((item, idx) => {
          const isSelected = idx === active;
          return (
            <button
              key={item.key}
              type="button"
              role="option"
              data-index={idx}
              aria-selected={isSelected}
              // Keep focus (and the caret) in the textarea.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onSelect(item)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors cursor-pointer border ${
                isSelected ? "bg-accent/15 text-fg border-accent/30" : "text-fg-2 hover:bg-surface hover:text-fg border-transparent"
              }`}
            >
              <span className="grid size-6 shrink-0 place-items-center rounded bg-surface border border-line/50">{ICONS[item.kind]}</span>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className={`truncate font-mono font-semibold ${item.kind === "file" || item.kind === "dir" ? "text-fg" : "text-accent"}`}>{item.label}</span>
                  {item.hint && <span className="hidden truncate font-mono text-[10px] text-muted sm:inline">{item.hint}</span>}
                </span>
                {item.description && <span className="block truncate text-[11px] text-muted">{item.description}</span>}
              </span>
              <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-[9px] font-mono uppercase text-muted border border-line/40">{item.badge}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

/** Dialog shell: Escape and the backdrop close it, focus moves in and returns to where it was. */
export function Modal({ title, subtitle, onClose, children, footer, wide = false }: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close.current(); } };
    document.addEventListener("keydown", key);
    box.current?.querySelector<HTMLElement>("[data-autofocus], input, select, textarea, button:not([data-close])")?.focus();
    return () => { document.removeEventListener("keydown", key); previous?.focus(); };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className={`flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl ${wide ? "max-w-4xl" : "max-w-lg"}`}>
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-semibold text-fg">{title}</h2>
            {subtitle && <div className="mt-0.5 truncate text-xs text-muted">{subtitle}</div>}
          </div>
          <button type="button" data-close onClick={onClose} aria-label="Close"
            className="-mr-2 inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg">
            <X size={18} aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

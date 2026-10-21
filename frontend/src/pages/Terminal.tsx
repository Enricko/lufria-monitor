import { AArrowDown, AArrowUp, ClipboardPaste, Copy, Plus, SquareTerminal, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type RefObject } from "react";
import { api } from "../api";
import { APPLE, TerminalView, type TerminalHandle } from "../components/TerminalView";
import { Button, Empty, PageHeader, Skeleton } from "../components/ui";

type Session = { id: string; created: number };
type Overview = { user: string; max: number; sessions: Session[] };

type State = { list: Session[] | null; current: string | null };
type Action =
  | { type: "load"; list: Session[] }
  | { type: "add"; session: Session }
  | { type: "remove"; id: string }
  | { type: "select"; id: string };

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "load":
      return { list: a.list, current: a.list.at(-1)?.id ?? null };
    case "add":
      return { list: [...(s.list ?? []), a.session], current: a.session.id };
    case "remove": {
      if (!s.list?.some((x) => x.id === a.id)) return s;
      const i = s.list.findIndex((x) => x.id === a.id);
      const list = s.list.filter((x) => x.id !== a.id);
      return { list, current: s.current === a.id ? (list[Math.min(i, list.length - 1)]?.id ?? null) : s.current };
    }
    case "select":
      return { ...s, current: a.id };
  }
}

const TOOL =
  "grid size-9 shrink-0 cursor-pointer place-items-center rounded-lg text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50";

/** Terminal text size, remembered per browser */
const SIZE_KEY = "terminal.fontSize";
const MIN_SIZE = 8;
const MAX_SIZE = 28;

function savedSize() {
  try {
    const v = Number(localStorage.getItem(SIZE_KEY));
    if (v >= MIN_SIZE && v <= MAX_SIZE) return v;
  } catch {
    // storage blocked: use the default
  }
  return window.innerWidth < 640 ? 12 : 14;
}

/** Height that fills the viewport below the element, so the terminal never scrolls the page. */
function useFillHeight(ref: RefObject<HTMLElement | null>, active: boolean, layoutKey: unknown) {
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    if (!active) return;
    const update = () => {
      const el = ref.current;
      if (!el) return;
      const viewport = window.visualViewport?.height ?? window.innerHeight;
      const top = el.getBoundingClientRect().top + window.scrollY;
      const gap = window.innerWidth >= 768 ? 32 : 24; // <main> bottom padding
      setHeight(Math.max(260, Math.floor(viewport - top - gap)));
    };
    update();
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, [ref, active, layoutKey]);
  return height;
}

export function Terminal({ active }: { active: boolean }) {
  const [{ list, current }, dispatch] = useReducer(reducer, { list: null, current: null });
  const [info, setInfo] = useState<Pick<Overview, "user" | "max"> | null>(null);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLElement>(null);
  const views = useRef(new Map<string, TerminalHandle>());
  const [fontSize, setFontSize] = useState(savedSize);
  const height = useFillHeight(box, active, error); // the error banner moves the box down

  const open = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      dispatch({ type: "add", session: await api<Session>("/api/terminal", { method: "POST", body: "{}" }) });
    } catch (e) {
      const detail = String(e).match(/"detail":"([^"]*)"/)?.[1];
      setError(`Couldn't open a terminal${detail ? `: ${detail}` : "."}`);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    let stale = false;
    api<Overview>("/api/terminal")
      .then((r) => {
        if (stale) return;
        setInfo({ user: r.user, max: r.max });
        dispatch({ type: "load", list: r.sessions });
        if (!r.sessions.length) open();
      })
      .catch(() => !stale && setError("Couldn't load terminal sessions."));
    return () => {
      stale = true;
    };
  }, [open]);

  const resize = (step: number) => {
    const size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, fontSize + step));
    setFontSize(size);
    try {
      localStorage.setItem(SIZE_KEY, String(size));
    } catch {
      // storage blocked: the size holds until reload
    }
  };

  const close = (id: string) => {
    dispatch({ type: "remove", id });
    api(`/api/terminal/${id}`, { method: "DELETE" }).catch(() => {});
  };
  const onTitle = useCallback((id: string, title: string) => setTitles((t) => ({ ...t, [id]: title })), []);
  const onExit = useCallback((id: string) => dispatch({ type: "remove", id }), []);

  const full = info !== null && list !== null && list.length >= info.max;

  return (
    <>
      <PageHeader
        title="Terminal"
        description={`Login shell${info ? ` as ${info.user}` : ""} · keeps running when you leave this page, ends when the dashboard restarts`}
      />

      {error && (
        <div role="alert" className="mb-4 rounded-xl border border-bad/40 bg-bad/10 px-4 py-2.5 text-sm text-fg-2">
          {error}
        </div>
      )}

      <section
        ref={box}
        aria-label="Terminal sessions"
        className="flex flex-col overflow-hidden rounded-2xl border border-line bg-bg"
        style={{ height }}
      >
        <div className="flex items-center gap-1 border-b border-line bg-surface px-2 py-1.5">
          <div role="tablist" aria-label="Sessions" className="flex min-w-0 gap-1 overflow-x-auto">
            {list?.map((s, i) => {
              const selected = s.id === current;
              return (
                <div
                  key={s.id}
                  className={`flex h-9 shrink-0 items-center rounded-lg text-sm transition-colors duration-150 ${
                    selected ? "bg-surface-2 text-fg" : "text-muted hover:text-fg"
                  }`}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => dispatch({ type: "select", id: s.id })}
                    className="h-full max-w-56 cursor-pointer truncate pl-3 pr-1.5 font-mono text-xs"
                    title={titles[s.id]}
                  >
                    {titles[s.id] || `shell ${i + 1}`}
                  </button>
                  <button
                    type="button"
                    aria-label={`Close ${titles[s.id] || `shell ${i + 1}`}`}
                    onClick={() => close(s.id)}
                    className="mr-1 grid size-7 cursor-pointer place-items-center rounded-md hover:bg-line-strong"
                  >
                    <X size={14} aria-hidden />
                  </button>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            aria-label="New terminal"
            title={full ? `At most ${info?.max} terminals` : "New terminal"}
            onClick={open}
            disabled={busy || full}
            className={TOOL}
          >
            <Plus size={16} aria-hidden />
          </button>
          <div className="ml-auto flex shrink-0 items-center gap-1 pl-1">
            <button
              type="button"
              aria-label="Smaller text"
              title={`Smaller text (${fontSize}px)`}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => resize(-1)}
              disabled={fontSize <= MIN_SIZE}
              className={TOOL}
            >
              <AArrowDown size={16} aria-hidden />
            </button>
            <span className="hidden w-6 text-center text-xs text-muted tabular-nums sm:block" aria-hidden>
              {fontSize}
            </span>
            <button
              type="button"
              aria-label="Larger text"
              title={`Larger text (${fontSize}px)`}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => resize(1)}
              disabled={fontSize >= MAX_SIZE}
              className={TOOL}
            >
              <AArrowUp size={16} aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Copy"
              title={`Copy the selection (${APPLE ? "⌘C" : "Ctrl+C"}), or pick text to copy. In apps that use the mouse, like Claude Code, drag copies on release; ${APPLE ? "Option" : "Shift"}+drag selects as usual`}
              onPointerDown={(e) => e.preventDefault()} // keep focus (and the phone keyboard) in the terminal
              onClick={() => current && views.current.get(current)?.copy()}
              disabled={!current}
              className={TOOL}
            >
              <Copy size={16} aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Paste"
              title={`Paste (${APPLE ? "⌘V" : "Ctrl+V"})`}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => current && views.current.get(current)?.paste()}
              disabled={!current}
              className={TOOL}
            >
              <ClipboardPaste size={16} aria-hidden />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1">
          {list === null && <Skeleton className="m-3 h-[calc(100%-1.5rem)]" />}
          {list?.map((s) => (
            <TerminalView
              key={s.id}
              ref={(h) => {
                if (h) views.current.set(s.id, h);
                else views.current.delete(s.id);
              }}
              id={s.id}
              active={active && s.id === current}
              fontSize={fontSize}
              onTitle={onTitle}
              onExit={onExit}
            />
          ))}
          {list?.length === 0 && !busy && (
            <Empty icon={SquareTerminal} className="h-full">
              <p className="mb-3">No terminal open</p>
              <Button variant="primary" icon={Plus} onClick={open}>
                New terminal
              </Button>
            </Empty>
          )}
        </div>
      </section>
    </>
  );
}

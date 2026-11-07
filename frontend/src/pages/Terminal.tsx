import { AArrowDown, AArrowUp, ClipboardPaste, Copy, Maximize2, Minimize2, Paperclip, Plus, RefreshCw, SquareTerminal, X } from "lucide-react";
import { memo, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api } from "../api";
import { APPLE, TerminalView, type ConnState, type TerminalHandle } from "../components/TerminalView";
import { Button, Empty, Skeleton } from "../components/ui";

type Session = { id: string; created: number };
type Overview = { user: string; max: number; sessions: Session[] };

type State = { list: Session[] | null; current: string | null };
type Action =
  | { type: "load"; list: Session[]; preferred?: string | null }
  | { type: "add"; session: Session }
  | { type: "remove"; id: string }
  | { type: "select"; id: string };

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "load": {
      const preferred = a.preferred && a.list.some((x) => x.id === a.preferred) ? a.preferred : null;
      return { list: a.list, current: preferred ?? a.list.at(-1)?.id ?? null };
    }
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
  "grid size-11 shrink-0 cursor-pointer place-items-center rounded-lg text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 lg:size-9";

const FONT_BTN =
  "grid size-11 shrink-0 cursor-pointer place-items-center rounded-md text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 lg:size-8";

/** Terminal text size, remembered per browser */
const SIZE_KEY = "terminal.fontSize";
const CURRENT_KEY = "terminal.current";
const MIN_SIZE = 8;
const MAX_SIZE = 28;

function savedCurrent() {
  try {
    return localStorage.getItem(CURRENT_KEY);
  } catch {
    return null;
  }
}

function savedSize() {
  try {
    const v = Number(localStorage.getItem(SIZE_KEY));
    if (v >= MIN_SIZE && v <= MAX_SIZE) return v;
  } catch {
    // storage blocked: use the default
  }
  return window.innerWidth < 640 ? 12 : 14;
}

function connLabel(state?: ConnState) {
  if (state === "open") return "Connected";
  if (state === "reconnecting") return "Reconnecting…";
  if (state === "paused") return "Paused";
  return "Connecting…";
}

function connDot(state?: ConnState) {
  if (state === "open") return "bg-good";
  if (state === "reconnecting") return "bg-warn animate-pulse";
  if (state === "paused") return "bg-line-strong";
  return "bg-muted animate-pulse";
}

export const Terminal = memo(function Terminal({ active }: { active: boolean }) {
  const [{ list, current }, dispatch] = useReducer(reducer, { list: null, current: null });
  const [info, setInfo] = useState<Pick<Overview, "user" | "max"> | null>(null);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [conns, setConns] = useState<Record<string, ConnState>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shellRef = useRef<HTMLElement>(null);
  const views = useRef(new Map<string, TerminalHandle>());
  const [fontSize, setFontSize] = useState(savedSize);
  const [fullscreen, setFullscreen] = useState(false);
  const canFullscreen = typeof document !== "undefined" && document.fullscreenEnabled;

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === shellRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

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
        dispatch({ type: "load", list: r.sessions, preferred: savedCurrent() });
        if (!r.sessions.length) open();
      })
      .catch(() => !stale && setError("Couldn't load terminal sessions."));
    return () => {
      stale = true;
    };
  }, [open]);

  useEffect(() => {
    if (!current) return;
    try {
      localStorage.setItem(CURRENT_KEY, current);
    } catch {
      // storage blocked: selection still holds for this visit
    }
  }, [current]);

  const resize = (step: number) => {
    const size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, fontSize + step));
    setFontSize(size);
    try {
      localStorage.setItem(SIZE_KEY, String(size));
    } catch {
      // storage blocked: the size holds until reload
    }
  };

  const forgetConn = (id: string) => {
    setConns((c) => {
      if (!(id in c)) return c;
      const rest = { ...c };
      delete rest[id];
      return rest;
    });
  };

  const close = (id: string) => {
    dispatch({ type: "remove", id });
    forgetConn(id);
    api(`/api/terminal/${id}`, { method: "DELETE" }).catch(() => {});
  };
  const onTitle = useCallback((id: string, title: string) => setTitles((t) => ({ ...t, [id]: title })), []);
  const onConn = useCallback((id: string, state: ConnState) => {
    setConns((c) => (c[id] === state ? c : { ...c, [id]: state }));
  }, []);
  const onExit = useCallback((id: string) => {
    dispatch({ type: "remove", id });
    setConns((c) => {
      const rest = { ...c };
      delete rest[id];
      return rest;
    });
  }, []);

  const toggleFullscreen = async () => {
    const el = shellRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await el.requestFullscreen();
    } catch {
      // iOS Safari only allows video fullscreen; the button simply does nothing there
    }
  };

  const full = info !== null && list !== null && list.length >= info.max;
  const currentConn = current ? conns[current] : undefined;
  const fullscreenButton = canFullscreen ? (
    <button
      type="button"
      aria-label={fullscreen ? "Exit full screen" : "Full screen"}
      aria-pressed={fullscreen}
      title={fullscreen ? "Exit full screen (Esc)" : "Full screen"}
      onPointerDown={(e) => e.preventDefault()}
      onClick={toggleFullscreen}
      className={TOOL}
    >
      {fullscreen ? <Minimize2 size={16} aria-hidden /> : <Maximize2 size={16} aria-hidden />}
    </button>
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 md:px-6 md:py-5">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-0.5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-line bg-surface text-accent shadow-sm" aria-hidden>
            <SquareTerminal size={19} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold leading-6 tracking-tight">Terminal</h1>
              <span className="rounded-full border border-line bg-surface px-2 py-0.5 font-mono text-[10px] tabular-nums text-muted">
                {list?.length ?? 0}/{info?.max ?? 8}
              </span>
            </div>
            <p className="truncate text-xs text-muted">
              {info ? `Login shell as ${info.user}` : "Login shell"} · sessions keep running when you leave this page
            </p>
          </div>
        </div>
        <span role="status" className="inline-flex shrink-0 items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-fg-2">
          <span className={`size-1.5 rounded-full ${connDot(currentConn)}`} aria-hidden />
          {connLabel(currentConn)}
        </span>
      </header>

      {error && (
        <div role="alert" className="shrink-0 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-fg-2">
          {error}
        </div>
      )}

      <section
        ref={shellRef}
        aria-label="Terminal sessions"
        className="terminal-shell flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-bg shadow-[inset_0_1px_0_rgb(255_255_255/0.03),0_18px_60px_rgb(0_0_0/0.25)]"
      >
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line bg-surface/90 px-2 py-1.5 lg:flex-nowrap">
          <div role="tablist" aria-label="Sessions" className="order-1 flex min-w-0 flex-1 gap-1 overflow-x-auto">
            {list?.map((s, i) => {
              const selected = s.id === current;
              const state = conns[s.id];
              const label = titles[s.id] || `shell ${i + 1}`;
              return (
                <div
                  key={s.id}
                  className={`group flex h-11 min-w-24 max-w-64 items-center rounded-lg border text-sm transition-colors duration-150 lg:h-9 ${
                    selected
                      ? "border-line-strong bg-surface-2 text-fg"
                      : "border-transparent text-muted hover:bg-surface-2 hover:text-fg"
                  }`}
                >
                  <button
                    type="button"
                    role="tab"
                    id={`terminal-tab-${s.id}`}
                    aria-controls={`terminal-panel-${s.id}`}
                    aria-selected={selected}
                    aria-label={`${label} — ${connLabel(state)}`}
                    onClick={() => dispatch({ type: "select", id: s.id })}
                    className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 pl-2.5 pr-1.5 font-mono text-xs"
                    title={`${label} · ${connLabel(state)}`}
                  >
                    <span className={`size-1.5 shrink-0 rounded-full ${connDot(state)}`} aria-hidden />
                    <span className="truncate">{label}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Close ${label}`}
                    onClick={() => close(s.id)}
                    className="mr-1 grid size-10 shrink-0 cursor-pointer place-items-center rounded-md text-muted opacity-70 transition-colors duration-150 hover:bg-line-strong hover:text-fg group-hover:opacity-100 lg:size-8"
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
            className={`${TOOL} order-2`}
          >
            <Plus size={16} aria-hidden />
          </button>

          {fullscreenButton && <div className="order-2 lg:hidden">{fullscreenButton}</div>}

          <div className="order-3 flex w-full flex-wrap items-center gap-1 border-t border-line/60 pt-1.5 lg:ml-auto lg:w-auto lg:flex-nowrap lg:border-0 lg:pt-0">
            <div className="mr-1 flex shrink-0 items-center rounded-lg border border-line bg-bg p-0.5">
              <button
                type="button"
                aria-label="Smaller text"
                title={`Smaller text (${fontSize}px)`}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => resize(-1)}
                disabled={fontSize <= MIN_SIZE}
                className={FONT_BTN}
              >
                <AArrowDown size={15} aria-hidden />
              </button>
              <span className="w-7 text-center font-mono text-[11px] tabular-nums text-fg-2" aria-hidden>
                {fontSize}
              </span>
              <button
                type="button"
                aria-label="Larger text"
                title={`Larger text (${fontSize}px)`}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => resize(1)}
                disabled={fontSize >= MAX_SIZE}
                className={FONT_BTN}
              >
                <AArrowUp size={15} aria-hidden />
              </button>
            </div>

            <span className="mx-0.5 h-5 w-px shrink-0 bg-line-strong" aria-hidden />

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
            <button
              type="button"
              aria-label="Upload files"
              title="Upload files and paste their path on the server (Claude Code attaches images and can read the rest). Dropping or pasting files into the terminal does the same"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => current && views.current.get(current)?.attach()}
              disabled={!current}
              className={TOOL}
            >
              <Paperclip size={16} aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Redraw screen"
              title="Redraw the screen: nudges the shell's window size so full-screen apps repaint after a layout change"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => current && views.current.get(current)?.redraw()}
              disabled={!current}
              className={TOOL}
            >
              <RefreshCw size={16} aria-hidden />
            </button>
            {fullscreenButton && <div className="hidden lg:block">{fullscreenButton}</div>}
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
              onConn={onConn}
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

        <footer className="hidden shrink-0 items-center justify-between gap-3 border-t border-line bg-surface/60 px-3 py-1.5 text-[11px] text-muted lg:flex">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5">
              <span className={`size-1.5 rounded-full ${connDot(currentConn)}`} aria-hidden />
              {connLabel(currentConn)}
            </span>
            <span className="h-3 w-px bg-line-strong" aria-hidden />
            <span>{list?.length ?? 0} of {info?.max ?? 8} sessions</span>
          </div>
          <div className="flex items-center gap-3 font-mono text-[10px]">
            <span>{APPLE ? "⌘C" : "Ctrl+Shift+C"} copy</span>
            <span>{APPLE ? "⌘V" : "Ctrl+V"} paste</span>
            <span className="hidden xl:inline">{APPLE ? "Option" : "Shift"}+drag select</span>
          </div>
        </footer>
      </section>
    </div>
  );
});

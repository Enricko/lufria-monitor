import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ClipboardPaste, Copy, X } from "lucide-react";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { api } from "../api";
import { Button } from "./ui";

// Background, cursor and selection mirror the tokens in index.css; ANSI colors are Tailwind 400/300 steps
const THEME = {
  background: "#020617",
  foreground: "#e2e8f0",
  cursor: "#22c55e",
  cursorAccent: "#020617",
  selectionBackground: "rgba(34, 197, 94, 0.3)",
  black: "#334155",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#facc15",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#cbd5e1",
  brightBlack: "#64748b",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde047",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#f8fafc",
};

/** Extra keys for phones, whose keyboards have no Esc, Tab, Ctrl or arrows. */
const KEYS = [
  { label: "Esc", seq: "\x1b" },
  { label: "Tab", seq: "\t" },
  { label: "Ctrl", ctrl: true },
  { label: "←", arrow: "D", name: "Left" },
  { label: "↑", arrow: "A", name: "Up" },
  { label: "↓", arrow: "B", name: "Down" },
  { label: "→", arrow: "C", name: "Right" },
  { label: "^C", seq: "\x03", name: "Control C" },
  { label: "|", seq: "|" },
  { label: "~", seq: "~" },
  { label: "/", seq: "/" },
  { label: "-", seq: "-" },
] as { label: string; seq?: string; arrow?: string; ctrl?: boolean; name?: string }[];

/** Apple keyboards copy and paste with Cmd, so there Ctrl+C and Ctrl+V stay terminal keys. */
export const APPLE = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/** Copies text. The LAN address is plain http, where navigator.clipboard is missing: fall back to the old copy command. */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const prev = document.activeElement as HTMLElement | null;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.readOnly = true; // no phone keyboard
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.append(ta);
    ta.select();
    ta.setSelectionRange(0, text.length); // iOS ignores select() alone
    const ok = document.execCommand("copy");
    ta.remove();
    prev?.focus();
    return ok;
  }
}

/** Scrollback plus screen as plain text, with soft-wrapped rows joined back into one line. */
function bufferText(term: XTerm) {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(); // untrimmed, so a space at the wrap point survives
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines.map((l) => l.trimEnd()).join("\n").trimEnd();
}

export type ConnState = "connecting" | "open" | "reconnecting";

/** Copy and paste for the toolbar above the terminal, which phones need: they can't select or paste in xterm. */
export type TerminalHandle = { copy: () => void; paste: () => void };

type Panel = { kind: "copy"; text: string } | { kind: "paste" };

/**
 * One terminal session. Survives disconnects: it tracks how many output bytes it has and asks the
 * server only for the rest on reconnect. Calls onExit once the session is gone for good.
 */
export function TerminalView({ id, active, fontSize, onTitle, onExit, ref }: {
  id: string;
  active: boolean;
  fontSize: number;
  onTitle: (id: string, title: string) => void;
  onExit: (id: string) => void;
  ref?: Ref<TerminalHandle>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ctrlRef = useRef(false);
  const [ctrl, setCtrl] = useState(false);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [notice, setNotice] = useState<{ text: string; action?: () => void } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pending = useRef<{ text: string; at: number } | null>(null); // app copy the browser refused to write
  const [panel, setPanel] = useState<Panel | null>(null);
  const [panelSel, setPanelSel] = useState(""); // text selected in the copy panel
  const preRef = useRef<HTMLPreElement>(null);
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const sizeRef = useRef(fontSize);
  sizeRef.current = fontSize;
  const callbacks = useRef({ onTitle, onExit });
  callbacks.current = { onTitle, onExit };

  const flash = (text: string, ms = 1500, action?: () => void) => {
    setNotice({ text, action });
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), ms);
  };
  const copyText = (text: string) => writeClipboard(text).then((ok) => flash(ok ? "Copied" : "Couldn't copy"));
  const copySelection = (term: XTerm) => {
    copyText(term.getSelection());
    term.clearSelection(); // so the next Ctrl+C is ^C again
  };
  /** Copies what the app last asked to copy but the browser refused; false if there is nothing recent. */
  const copyPending = () => {
    const p = pending.current;
    pending.current = null;
    if (!p || performance.now() - p.at > 60_000) return false;
    copyText(p.text);
    termRef.current?.focus();
    return true;
  };
  /** OSC 52 from the app (Claude Code sends one when you drag-select in it). Chrome takes it straight away;
   *  Safari only writes the clipboard during a click or key press, so there it waits for ⌘C or a click. */
  const copyFromApp = (text: string) =>
    writeClipboard(text).then((ok) => {
      if (ok) {
        pending.current = null;
        flash("Copied");
      } else {
        pending.current = { text, at: performance.now() };
        flash(`Press ${APPLE ? "⌘C" : "Ctrl+Shift+C"} or click here to copy`, 8000, copyPending);
      }
    });

  useImperativeHandle(ref, () => ({
    copy() {
      const term = termRef.current;
      if (!term) return;
      if (term.hasSelection()) {
        copySelection(term);
        term.focus();
      } else if (!copyPending()) {
        setPanel({ kind: "copy", text: bufferText(term) });
      }
    },
    async paste() {
      const term = termRef.current;
      if (!term) return;
      try {
        term.paste(await navigator.clipboard.readText());
        term.focus();
      } catch {
        setPanel({ kind: "paste" }); // no clipboard read (plain http, or permission refused): paste by hand
      }
    },
  }), []);

  useEffect(() => {
    const el = host.current!;
    const term = new XTerm({
      fontFamily: '"Fira Code", ui-monospace, monospace',
      fontSize: sizeRef.current,
      lineHeight: 1.1,
      cursorBlink: true,
      scrollback: 5000,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true, // Option+drag selects in apps that grab the mouse (Shift+drag elsewhere)
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    termRef.current = term;
    fitRef.current = fit;

    const enc = new TextEncoder();
    let ws: WebSocket | null = null;
    let offset = -1; // output bytes received so far; -1 = none yet
    let done = false;
    let attempts = 0;
    let retry: ReturnType<typeof setTimeout>;

    const send = (data: string | Uint8Array) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(data);
    };
    const sendSize = () => send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    const finish = () => {
      done = true;
      callbacks.current.onExit(id);
    };

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const since = offset >= 0 ? `?since=${offset}` : "";
      ws = new WebSocket(`${proto}://${location.host}/ws/terminal/${id}${since}`);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        attempts = 0;
        setConn("open");
        sendSize();
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") {
          const bytes = new Uint8Array(ev.data);
          offset += bytes.length;
          term.write(bytes);
          return;
        }
        const msg = JSON.parse(ev.data);
        if (msg.type === "attach") {
          if (msg.reset) term.reset(); // our offset fell out of the server's buffer: full replay
          offset = msg.offset;
        } else if (msg.type === "exit") {
          finish();
        }
      };
      ws.onclose = (ev) => {
        if (done) return;
        if (ev.code === 4404) finish();
        else reconnect();
      };
    };

    const reconnect = () => {
      setConn("reconnecting");
      // Check the session still exists first; this also catches an expired login (401 -> login page)
      retry = setTimeout(() => {
        api<{ sessions: { id: string }[] }>("/api/terminal")
          .then((r) => {
            if (done) return;
            if (r.sessions.some((s) => s.id === id)) connect();
            else finish();
          })
          .catch(() => !done && reconnect());
      }, Math.min(1000 * 2 ** attempts++, 10000));
    };

    term.onData((d) => {
      if (ctrlRef.current && d.length === 1) {
        const c = d.toLowerCase().charCodeAt(0);
        if (c >= 97 && c <= 122) d = String.fromCharCode(c - 96);
        ctrlRef.current = false;
        setCtrl(false);
      }
      send(enc.encode(d));
    });
    term.onBinary((d) => send(Uint8Array.from(d, (c) => c.charCodeAt(0) & 255)));
    term.onResize(sendSize);
    term.onTitleChange((t) => callbacks.current.onTitle(id, t));

    // Apps copy with OSC 52 ("c;<base64>"): Claude Code on drag-select, tmux, vim. Honored only just after a
    // click or key press here, so output replayed on reload never overwrites the clipboard. Reads ("?") are
    // never answered: the server doesn't get to see the clipboard.
    let lastInput = -Infinity;
    const markInput = () => (lastInput = performance.now());
    el.addEventListener("pointerup", markInput, true);
    el.addEventListener("keydown", markInput, true);
    term.parser.registerOscHandler(52, (data) => {
      const b64 = data.slice(data.indexOf(";") + 1);
      if (b64 === "?" || performance.now() - lastInput > 3000) return true;
      try {
        const text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
        if (text) copyFromApp(text);
      } catch {
        // not base64
      }
      return true;
    });

    term.attachCustomKeyEventHandler((e) => {
      const copyKey = e.code === "KeyC" && !e.altKey && (APPLE ? e.metaKey && !e.ctrlKey : e.ctrlKey && e.shiftKey);
      if (e.type === "keydown" && copyKey && !term.hasSelection() && pending.current) {
        e.preventDefault();
        copyPending();
        return false;
      }
      if (e.type !== "keydown" || !e.ctrlKey || e.altKey || e.metaKey) return true;
      // Ctrl+Shift+C always copies; Ctrl+C copies too while text is selected, and is ^C otherwise
      if (e.code === "KeyC" && (e.shiftKey || (!APPLE && term.hasSelection()))) {
        e.preventDefault();
        if (term.hasSelection()) copySelection(term);
        return false;
      }
      // Ctrl+V and Ctrl+Shift+V fall through to the browser's paste, which xterm sends on as a paste
      return !(e.code === "KeyV" && (e.shiftKey || !APPLE));
    });

    const ro = new ResizeObserver(() => {
      if (el.offsetParent) fit.fit(); // skip while hidden: a 0x0 box would give a 1-column terminal
    });

    // Measure cell size with the real font, not the fallback it would use before Fira Code loads
    document.fonts.load(`${term.options.fontSize}px "Fira Code"`).finally(() => {
      if (done) return;
      term.open(el);
      if (el.offsetParent) fit.fit();
      ro.observe(el);
      connect();
    });

    return () => {
      done = true;
      clearTimeout(retry);
      ro.disconnect();
      el.removeEventListener("pointerup", markInput, true);
      el.removeEventListener("keydown", markInput, true);
      ws?.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [id]);

  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      fitRef.current?.fit();
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active]);

  useEffect(() => {
    const term = termRef.current;
    if (!term || term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    if (host.current?.offsetParent) fitRef.current?.fit(); // hidden tabs refit when they're shown
  }, [fontSize]);

  useEffect(() => {
    if (panel?.kind !== "copy") return;
    const pre = preRef.current!;
    pre.scrollTop = pre.scrollHeight; // newest output first in view, like the terminal
    pre.focus({ preventScroll: true });
    const onSelect = () => {
      const s = document.getSelection();
      setPanelSel(s && !s.isCollapsed && pre.contains(s.anchorNode) ? s.toString() : "");
    };
    document.addEventListener("selectionchange", onSelect);
    return () => {
      document.removeEventListener("selectionchange", onSelect);
      setPanelSel("");
    };
  }, [panel]);

  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  const closePanel = () => {
    setPanel(null);
    termRef.current?.focus();
  };
  const sendPaste = () => {
    const text = pasteRef.current?.value;
    if (text) termRef.current?.paste(text);
    closePanel();
  };

  const press = (k: (typeof KEYS)[number]) => {
    const term = termRef.current;
    if (!term) return;
    if (k.ctrl) {
      ctrlRef.current = !ctrlRef.current;
      setCtrl(ctrlRef.current);
      return;
    }
    const seq = k.arrow ? `\x1b${term.modes.applicationCursorKeysMode ? "O" : "["}${k.arrow}` : k.seq!;
    term.input(seq, true);
  };

  const status = conn === "connecting" ? "Connecting…" : conn === "reconnecting" ? "Reconnecting…" : notice?.text;
  const chip = "absolute top-3 right-4 z-20 rounded-md bg-surface-2 px-2 py-1 text-xs";

  return (
    <div className={active ? "flex h-full flex-col" : "hidden"}>
      <div className="relative min-h-0 flex-1 p-2">
        <div ref={host} className="h-full" />
        {status && conn === "open" && notice?.action ? (
          <button type="button" role="status" onClick={notice.action} className={`${chip} cursor-pointer text-fg ring-1 ring-accent`}>
            {status}
          </button>
        ) : (
          status && (
            <div role="status" className={`${chip} text-muted`}>
              {status}
            </div>
          )
        )}
        {panel && (
          <div
            role="dialog"
            aria-label={panel.kind === "copy" ? "Copy text" : "Paste text"}
            onKeyDown={(e) => e.key === "Escape" && closePanel()}
            className="absolute inset-0 z-10 flex flex-col bg-bg"
          >
            {/* mousedown would clear the text selected below before the click lands */}
            <div onMouseDown={(e) => e.preventDefault()} className="flex items-center gap-2 border-b border-line px-3 py-2">
              <p className="mr-auto min-w-0 text-sm text-muted">
                {panel.kind === "copy" ? "Select text to copy" : "Paste here, then Send"}
              </p>
              <div className="shrink-0">
                {panel.kind === "copy" ? (
                  <Button variant="primary" icon={Copy} onClick={() => copyText(panelSel || panel.text).then(closePanel)}>
                    {panelSel ? "Copy selection" : "Copy all"}
                  </Button>
                ) : (
                  <Button variant="primary" icon={ClipboardPaste} onClick={sendPaste}>
                    Send
                  </Button>
                )}
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={closePanel}
                className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-lg text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg"
              >
                <X size={16} aria-hidden />
              </button>
            </div>
            {panel.kind === "copy" ? (
              <pre
                ref={preRef}
                tabIndex={0}
                style={{ outline: "none", fontSize }} // the global :focus-visible ring would hug the panel edges
                className="min-h-0 flex-1 overflow-auto p-3 font-mono leading-relaxed whitespace-pre-wrap text-fg-2 select-text [overflow-wrap:anywhere]"
              >
                {panel.text}
              </pre>
            ) : (
              <textarea
                ref={pasteRef}
                autoFocus
                aria-label="Text to paste"
                placeholder={APPLE ? "Tap and hold, then Paste" : "Ctrl+V, or tap and hold, then Paste"}
                onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && sendPaste()}
                style={{ outline: "none" }}
                className="min-h-0 flex-1 resize-none bg-bg p-3 font-mono text-sm text-fg placeholder:text-muted"
              />
            )}
          </div>
        )}
      </div>
      <div className="flex gap-1 overflow-x-auto border-t border-line px-2 py-1.5 lg:hidden">
        {KEYS.map((k) => (
          <button
            key={k.label}
            type="button"
            aria-label={k.name}
            aria-pressed={k.ctrl ? ctrl : undefined}
            onPointerDown={(e) => e.preventDefault()} // keep focus (and the phone keyboard) in the terminal
            onClick={() => press(k)}
            className={`h-10 min-w-11 shrink-0 cursor-pointer rounded-md px-2 font-mono text-sm ${
              k.ctrl && ctrl ? "bg-accent text-bg" : "bg-surface-2 text-fg-2"
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>
    </div>
  );
}

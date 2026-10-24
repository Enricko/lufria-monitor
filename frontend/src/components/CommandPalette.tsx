import React, { useMemo } from "react";
import {
  BarChart2,
  CheckCircle2,
  Cpu,
  FileCode,
  HelpCircle,
  ListTodo,
  Minimize2,
  RefreshCw,
  Search,
  ShieldCheck,
  Terminal,
} from "lucide-react";

export interface SlashCommand {
  name: string;
  syntax: string;
  description: string;
  badge?: string;
  icon: React.ReactNode;
}

export const CLAUDE_SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "/model",
    syntax: "/model [nama]",
    description: "Pilih AI model & provider (buka dialog Model Picker)",
    badge: "Dialog",
    icon: <Cpu size={14} className="text-accent" />,
  },
  {
    name: "/status",
    syntax: "/status",
    description: "Cek status server, resource (CPU/RAM), model & sesi aktif",
    badge: "Instan",
    icon: <Terminal size={14} className="text-accent" />,
  },
  {
    name: "/cost",
    syntax: "/cost",
    description: "Rincian token & riwayat biaya penggunaan (buka modal Usage)",
    badge: "Modal",
    icon: <BarChart2 size={14} className="text-accent" />,
  },
  {
    name: "/clear",
    syntax: "/clear",
    description: "Mulai percakapan baru (bersihkan konteks sesi)",
    badge: "Reset",
    icon: <RefreshCw size={14} className="text-accent" />,
  },
  {
    name: "/plan",
    syntax: "/plan [topik]",
    description: "Mode perencanaan kerja bertahap (step-by-step plan) sebelum eksekusi",
    badge: "Agent",
    icon: <ListTodo size={14} className="text-accent" />,
  },
  {
    name: "/review",
    syntax: "/review",
    description: "Review perubahan kode (git status & diff) terbaru",
    badge: "Code",
    icon: <FileCode size={14} className="text-accent" />,
  },
  {
    name: "/security-review",
    syntax: "/security-review",
    description: "Audit keamanan kode terhadap vulnerabilitas (OWASP, SQLi, injection)",
    badge: "Security",
    icon: <ShieldCheck size={14} className="text-accent" />,
  },
  {
    name: "/context",
    syntax: "/context",
    description: "Cek estimasi penggunaan context window sesi Claude Code",
    badge: "CLI",
    icon: <Search size={14} className="text-accent" />,
  },
  {
    name: "/compact",
    syntax: "/compact",
    description: "Kompres percakapan untuk menghemat context window",
    badge: "CLI",
    icon: <Minimize2 size={14} className="text-accent" />,
  },
  {
    name: "/help",
    syntax: "/help",
    description: "Panduan lengkap perintah, shortcut & subagent Claude Code",
    badge: "Guide",
    icon: <HelpCircle size={14} className="text-accent" />,
  },
];

interface CommandPaletteProps {
  open: boolean;
  query: string;
  selectedIndex: number;
  onSelect: (command: SlashCommand) => void;
  onClose: () => void;
}

export function CommandPalette({
  open,
  query,
  selectedIndex,
  onSelect,
}: CommandPaletteProps) {
  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q || q === "/") return CLAUDE_SLASH_COMMANDS;
    const clean = q.startsWith("/") ? q : `/${q}`;
    return CLAUDE_SLASH_COMMANDS.filter(
      (c) =>
        c.name.toLowerCase().includes(clean) ||
        c.description.toLowerCase().includes(q) ||
        c.syntax.toLowerCase().includes(q)
    );
  }, [query]);

  if (!open || filtered.length === 0) return null;

  return (
    <div
      role="listbox"
      aria-label="Claude Code Commands"
      className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-xl border border-line bg-surface-2/95 backdrop-blur-md shadow-2xl z-30 animate-in fade-in slide-in-from-bottom-2 duration-150"
      style={{ maxHeight: 280 }}
    >
      <div className="flex items-center justify-between border-b border-line/60 px-3 py-1.5 text-[11px] font-medium text-muted bg-surface/50">
        <span className="flex items-center gap-1.5">
          <Terminal size={12} className="text-accent" /> Perintah Claude Code
        </span>
        <span className="text-[10px]">
          Gunakan <kbd className="rounded bg-surface px-1 py-0.5 font-mono text-[9px] border border-line">↑</kbd> <kbd className="rounded bg-surface px-1 py-0.5 font-mono text-[9px] border border-line">↓</kbd> untuk memilih · <kbd className="rounded bg-surface px-1 py-0.5 font-mono text-[9px] border border-line">Enter</kbd>
        </span>
      </div>

      <div className="overflow-y-auto p-1 max-h-[230px]">
        {filtered.map((cmd, idx) => {
          const isSelected = idx === selectedIndex % filtered.length;
          return (
            <button
              key={cmd.name}
              type="button"
              role="option"
              aria-selected={isSelected}
              onClick={() => onSelect(cmd)}
              className={`flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-xs transition-colors cursor-pointer ${
                isSelected
                  ? "bg-accent/15 text-fg border border-accent/30"
                  : "text-fg-2 hover:bg-surface hover:text-fg border border-transparent"
              }`}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="grid size-6 shrink-0 place-items-center rounded bg-surface border border-line/50">
                  {cmd.icon}
                </div>
                <div className="min-w-0 truncate">
                  <span className="font-mono font-semibold text-accent">{cmd.name}</span>
                  <span className="ml-2 text-muted truncate text-[11px]">{cmd.description}</span>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {cmd.badge && (
                  <span className="rounded bg-surface px-1.5 py-0.5 text-[9px] font-mono text-muted border border-line/40 uppercase">
                    {cmd.badge}
                  </span>
                )}
                {isSelected && (
                  <CheckCircle2 size={13} className="text-accent shrink-0" />
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

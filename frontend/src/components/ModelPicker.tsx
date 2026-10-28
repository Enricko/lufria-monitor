import { Check, ChevronDown, ChevronRight, Loader, RefreshCw, Search, Settings2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentModel, ModelSelection, Provider } from "../provider-types";
import type { NativeModel } from "../claude/types";

const FALLBACK_NATIVE: NativeModel[] = [{ value: "default", display_name: "Claude Default", description: "Native Claude Code configuration", effort_levels: [] }];

interface Props {
  models: AgentModel[];
  providers: Provider[];
  value: ModelSelection;
  disabled?: boolean;
  loading: boolean;
  error: string | null;
  onSelect: (value: ModelSelection) => void;
  onRefresh: () => Promise<void>;
  /** Official Claude models the CLI offers with its own login. */
  nativeModels?: NativeModel[];
  /** Controlled open state, so /model can open the picker. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function ModelPicker({ models, providers, value, disabled, loading, error, onSelect, onRefresh, nativeModels, open: openProp, onOpenChange }: Props) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (next: boolean) => { if (onOpenChange) onOpenChange(next); else setOpenState(next); };
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const selected = models.find((m) => m.id === value.model && (!value.provider_id || m.provider_id === value.provider_id));
  const selectedProvider = value.provider_id
    ? providers.find((p) => p.id === value.provider_id)?.name || selected?.provider || value.provider_id
    : undefined;
  const natives = nativeModels?.length ? nativeModels : FALLBACK_NATIVE;
  const isNativeDefault = !value.provider_id && (value.model === "default" || value.model.startsWith("claude-") || natives.some((n) => n.value === value.model));
  const selectedName = isNativeDefault
    ? value.model === "default" ? "Claude Default" : natives.find((n) => n.value === value.model)?.display_name || value.model
    : selected?.name || value.model;
  const nativeMatches = natives.filter((n) => `${n.value} ${n.display_name} ${n.description} claude official native anthropic`.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()));
  const groups = useMemo(() => {
    const map = new Map<string, { id: string; name: string; models: AgentModel[] }>();
    for (const p of providers) if (p.enabled) map.set(p.id, {id:p.id,name:p.name,models:[]});
    for (const m of models) {
      if (!map.has(m.provider_id)) map.set(m.provider_id,{id:m.provider_id,name:m.provider,models:[]});
      map.get(m.provider_id)!.models.push(m);
    }
    const q = query.toLocaleLowerCase().trim();
    return [...map.values()].map((g) => ({...g, total:g.models.length, models:g.models.filter((m) => `${m.name || ""} ${m.id} ${g.name}`.toLocaleLowerCase().includes(q))}));
  }, [models, providers, query]);
  const matching = groups.reduce((n,g) => n+g.models.length,0);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setExpanded(new Set(value.provider_id ? [value.provider_id] : []));
    search.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
      const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,a[href]') || [])];
      const active = document.activeElement;
      if (e.key === "Tab") {
        if (e.shiftKey && active === controls[0]) { e.preventDefault(); controls.at(-1)?.focus(); }
        else if (!e.shiftKey && active === controls.at(-1)) { e.preventDefault(); controls[0]?.focus(); }
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const options = [...(panel.current?.querySelectorAll<HTMLButtonElement>('button[data-model-id]') || [])];
        if (!options.length) return;
        const index = options.indexOf(active as HTMLButtonElement);
        const next = index < 0 ? (e.key === "ArrowDown" ? 0 : options.length-1) : (index+(e.key === "ArrowDown" ? 1 : -1)+options.length)%options.length;
        e.preventDefault(); options[next].focus();
        options[next].scrollIntoView({block:"nearest"});
      }
    };
    document.addEventListener("keydown",key);
    return () => { document.removeEventListener("keydown",key); trigger.current?.focus(); };
  }, [open]);

  const choose = (model: string, provider_id: string | null) => { onSelect({model,provider_id});setOpen(false); };
  const option = (m: AgentModel) => {
    const active = value.model === m.id && value.provider_id === m.provider_id;
    return <button type="button" key={`${m.provider_id}:${m.id}`} data-model-id={m.id} data-provider-id={m.provider_id}
      aria-pressed={active} className={`model-picker-option ${active ? "is-selected" : ""}`} onClick={() => choose(m.id,m.provider_id)}>
      <span className="min-w-0 flex-1 text-left"><span className="block text-sm font-medium break-words">{m.name || m.id}</span>
        <span className="mt-0.5 block text-[11px] font-mono text-muted break-all">{m.id}</span></span>
      {active && <Check size={16} className="shrink-0 text-accent" aria-hidden />}
    </button>;
  };

  return <>
    <button type="button" ref={trigger} disabled={disabled} onClick={() => setOpen(true)}
      aria-label="Choose model" aria-haspopup="dialog" aria-expanded={open} className="agent-model-trigger">
      <span className="min-w-0 flex-1 text-left"><span className="block truncate text-xs text-fg-2">{selectedName}</span>
        <span className="block truncate text-[10px] text-muted">{isNativeDefault ? "Claude · official" : selectedProvider || "Choose a provider"}</span></span>
      <ChevronDown size={14} className="shrink-0 text-muted" aria-hidden />
    </button>
    {open && createPortal(<div className="model-picker-backdrop" onMouseDown={(e) => {if (e.target===e.currentTarget)setOpen(false);}}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby="model-picker-title" className="model-picker-panel">
        <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3 shrink-0">
          <div className="min-w-0"><h2 id="model-picker-title" className="text-sm font-semibold text-fg">Choose a model</h2>
            <p className="mt-1 text-xs text-muted">Applies from your next message. Official and custom models can take turns in one session.</p></div>
          <button type="button" className="agent-icon-button -mt-2 -mr-2 text-muted hover:bg-surface-2" aria-label="Close model picker" onClick={() => setOpen(false)}><X size={18}/></button>
        </div>
        <label className="model-picker-search"><Search size={16} className="shrink-0 text-muted" aria-hidden/>
          <input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search models" name="model-search" type="search" autoComplete="off" placeholder="Search models or providers…"/>
        </label>
        {error && <p role="alert" className="mx-4 mb-2 rounded-lg border border-bad/30 bg-bad/10 p-2 text-xs text-bad">{error}</p>}
        <div className="model-picker-list">
          {!query && <section className="mb-2">
            <p className="model-picker-label">Current selection</p>
            <div className="mx-2 rounded-lg border border-accent/25 bg-accent/5 px-3 py-2">
              <p className="text-sm text-fg break-words">{selectedName}</p><p className="mt-0.5 text-xs text-accent break-words">{isNativeDefault ? "Claude · official (Claude Code login)" : selectedProvider || "Legacy routing · choose a provider"}</p>
            </div>
          </section>}
          {nativeMatches.length > 0 && <section className="border-t border-line">
            <p className="model-picker-label pt-3">Claude · official</p>
            {nativeMatches.map((n) => {
              const active = !value.provider_id && value.model === n.value;
              return <button type="button" key={`native:${n.value}`} data-model-id={n.value} aria-pressed={active}
                className={`model-picker-option ${active ? "is-selected" : ""}`} onClick={() => choose(n.value, null)}>
                <span className="min-w-0 flex-1 text-left"><span className="block text-sm font-medium break-words">{n.value === "default" ? "Claude Default" : n.display_name}</span>
                  <span className="mt-0.5 block text-[11px] text-muted break-words">{n.description || n.value}</span></span>
                {active && <Check size={16} className="shrink-0 text-accent" aria-hidden/>}
              </button>;
            })}
          </section>}
          {groups.filter((g) => !query || g.models.length>0).map((g) => {
            const isOpen = !!query || expanded.has(g.id);
            return <section key={g.id} className="border-t border-line">
              <button type="button" className="model-picker-group" aria-expanded={isOpen} aria-controls={`model-group-${g.id}`} onClick={() => setExpanded((prev) => {const n=new Set(prev);n.has(g.id)?n.delete(g.id):n.add(g.id);return n;})}>
                {isOpen ? <ChevronDown size={14} aria-hidden/> : <ChevronRight size={14} aria-hidden/>}
                <span className="flex-1 min-w-0 truncate text-left">{g.name}</span><span className="font-mono text-[10px] tabular-nums">{g.total}</span>
              </button>
              {isOpen && <div id={`model-group-${g.id}`}>{g.models.map(option)}{!g.models.length && <p className="px-4 pb-3 text-xs text-muted">No models cached. Refresh in Settings.</p>}</div>}
            </section>;
          })}
          {query && matching===0 && <p className="p-6 text-center text-sm text-muted">No matching models</p>}
          {loading && <div role="status" className="flex items-center justify-center gap-2 p-4 text-xs text-muted"><Loader size={14} className="animate-spin"/>Fetching model catalog…</div>}
        </div>
        <div className="model-picker-footer">
          <button type="button" disabled={loading} onClick={() => void onRefresh()} className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-xs text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50">
            <RefreshCw size={14} className={loading?"animate-spin":""} aria-hidden/>Refresh models
          </button>
          <a href="#settings" onClick={() => setOpen(false)} className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-xs text-accent hover:bg-accent/10"><Settings2 size={14} aria-hidden/>Manage providers</a>
        </div>
      </div>
    </div>,document.body)}
  </>;
}

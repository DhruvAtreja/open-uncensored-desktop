import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Chevron, Search } from "./icons";
import type { ModelInfo } from "./lib";

// A searchable popover: ranked models first with their OpenUncensored Score, then everything else.

function scoreTone(score: number | null) {
  if (score === null) return "text-fg-3 bg-white/[0.04]";
  if (score >= 65) return "text-ok bg-ok/10";
  if (score >= 55) return "text-[#e9c46a] bg-[#e9c46a]/10";
  return "text-fg-2 bg-white/[0.06]";
}

export function ModelPicker({ value, models, onChange }: { value: string; models: ModelInfo[]; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const current = models.find((m) => m.id === value);

  const bestAgent = useMemo(
    () => [...models].filter((m) => m.rank).sort((a, b) => (b.agentic ?? 0) - (a.agentic ?? 0))[0]?.id,
    [models],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? models.filter((m) => m.name.toLowerCase().includes(q) || m.id.includes(q)) : models;
  }, [models, query]);
  const ranked = filtered.filter((m) => m.rank);
  const others = filtered.filter((m) => !m.rank);
  const flat = [...ranked, ...others];

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  useEffect(() => setCursor(0), [query, open]);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };

  const row = (m: ModelInfo, i: number) => (
    <button
      key={m.id}
      onMouseEnter={() => setCursor(i)}
      onClick={() => pick(m.id)}
      className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left ${i === cursor ? "bg-white/[0.07]" : ""}`}
    >
      <span className="w-7 shrink-0 font-mono text-[11px] text-fg-3">{m.rank ? `#${m.rank}` : ""}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-fg">{m.name}</span>
        {m.id === bestAgent && <span className="block text-[11px] text-orange">Best at agent tasks</span>}
      </span>
      {m.rank && m.score !== null && (
        <span className={`shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[11px] tabular-nums ${scoreTone(m.score)}`}>{m.score.toFixed(0)}</span>
      )}
      <span className="w-4 shrink-0 text-blue">{m.id === value && <Check className="h-4 w-4" />}</span>
    </button>
  );

  return (
    <div ref={root} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex max-w-[320px] items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] text-fg-2 transition-colors hover:bg-white/[0.06] hover:text-fg"
      >
        {current?.rank && <span className="font-mono text-[11px] text-fg-3">#{current.rank}</span>}
        <span className="truncate">{current?.name ?? value}</span>
        <Chevron className="h-3.5 w-3.5 shrink-0 opacity-60" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-2 w-[400px] overflow-hidden rounded-xl border border-white/10 bg-[#0b1820] shadow-2xl shadow-black/60">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
            <Search className="h-4 w-4 text-fg-3" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") (e.preventDefault(), setCursor((c) => Math.min(c + 1, flat.length - 1)));
                else if (e.key === "ArrowUp") (e.preventDefault(), setCursor((c) => Math.max(c - 1, 0)));
                else if (e.key === "Enter" && flat[cursor]) pick(flat[cursor].id);
                else if (e.key === "Escape") setOpen(false);
              }}
              placeholder="Search models"
              className="flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-3"
            />
          </div>
          <div className="max-h-[360px] overflow-y-auto p-1.5">
            {ranked.length > 0 && <p className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-wider text-fg-3">Ranked by OpenUncensored Score</p>}
            {ranked.map((m, i) => row(m, i))}
            {others.length > 0 && <p className="px-2.5 pb-1 pt-3 text-[10.5px] font-medium uppercase tracking-wider text-fg-3">More models</p>}
            {others.map((m, i) => row(m, ranked.length + i))}
            {flat.length === 0 && <p className="px-3 py-6 text-center text-[12.5px] text-fg-3">No model matches “{query}”.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

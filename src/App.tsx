import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Check, ChevronRight, File, Folder, Gear, Pencil, Plus, Sidebar, Spinner, Square, Terminal, Trash, X } from "./icons";
import { type AgentItem, type UpdateState, balance, type Conversation, fetchModels, md, type ModelInfo, pollPurchase, startPurchase, suggestTitle, uid } from "./lib";
import logo from "./logo.svg";
import { ModelPicker } from "./ModelPicker";

// Drives tools reliably through the agent; the default for new conversations.
const DEFAULT_MODEL = "glm-5.3-flash-uncensored";
const PACKS = [1000, 2500, 5000];
const DEFAULT_TITLE = "New conversation";

const folderName = (p?: string) => (p ? p.split("/").filter(Boolean).pop() ?? p : "");
function ago(ts: number) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export default function App() {
  const [key, setKey] = useState<string | null | undefined>(undefined);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [convos, setConvos] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [credit, setCredit] = useState<number | null>(null);
  const [settings, setSettings] = useState(false);
  const [appUpdate, setAppUpdate] = useState<UpdateState>({ status: "idle" });
  useEffect(() => {
    window.ou.getUpdate().then(setAppUpdate);
    return window.ou.onUpdate(setAppUpdate);
  }, []);
  const [sidebar, setSidebar] = useState(() => localStorage.getItem("ou.sidebar") !== "closed");
  const [width, setWidth] = useState(() => Number(localStorage.getItem("ou.sidebarWidth")) || 260);
  const [renaming, setRenaming] = useState<string | null>(null);
  useEffect(() => localStorage.setItem("ou.sidebar", sidebar ? "open" : "closed"), [sidebar]);
  useEffect(() => localStorage.setItem("ou.sidebarWidth", String(width)), [width]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setSidebar((s) => !s);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const move = (ev: MouseEvent) => setWidth(Math.max(200, Math.min(440, ev.clientX)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  useEffect(() => {
    window.ou.getKey().then(setKey);
    // Empty, never-named conversations left from earlier sessions are dropped on launch.
    window.ou.getConversations().then((list) => setConvos(list.filter((c) => c.kind === "agent" && (c.turns.length > 0 || c.named))));
    fetchModels().then(setModels).catch(() => setModels([]));
  }, []);

  const refreshCredit = useCallback(() => {
    if (key) balance().then(setCredit);
  }, [key]);
  useEffect(refreshCredit, [refreshCredit]);

  const persist = (next: Conversation[]) => window.ou.setConversations(next);
  const update = useCallback(
    (id: string, fn: (c: Conversation) => Conversation) =>
      setConvos((list) => {
        const next = list.map((c) => (c.id === id ? fn(c) : c));
        persist(next);
        return next;
      }),
    [],
  );

  // Every conversation is the agent: it chats, and it can work on files from its folder.
  const create = async (pick: boolean) => {
    const empty = convos.find((c) => c.turns.length === 0 && !c.named && !pick);
    if (empty) {
      setActiveId(empty.id);
      return;
    }
    const folder = pick ? await window.ou.pickFolder() : await window.ou.defaultFolder();
    if (!folder) return;
    const convo: Conversation = {
      id: uid(),
      kind: "agent",
      title: pick ? folderName(folder) : DEFAULT_TITLE,
      model: DEFAULT_MODEL,
      folder,
      turns: [],
      updated: Date.now(),
    };
    setConvos((list) => {
      const next = [convo, ...list];
      persist(next);
      return next;
    });
    setActiveId(convo.id);
  };
  const remove = (id: string) =>
    setConvos((list) => {
      const next = list.filter((c) => c.id !== id);
      persist(next);
      if (activeId === id) setActiveId(null);
      return next;
    });

  if (key === undefined) return <div className="h-full bg-ink" />;
  if (!key) return <KeySetup onKey={(k) => window.ou.setKey(k).then(() => setKey(k))} />;

  const active = convos.find((c) => c.id === activeId) ?? null;
  const sorted = [...convos].sort((a, b) => b.updated - a.updated);
  return (
    <div className="flex h-full text-fg">
      {sidebar && (
      <aside style={{ width }} className="relative flex shrink-0 flex-col border-r border-white/[0.06] bg-ink-2">
        <div className="drag flex h-[52px] shrink-0 items-center pl-[84px] pr-2">
          <img src={logo} alt="" className="h-[18px] w-[18px] rounded-[5px]" />
          <span className="ml-2 min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight">Open Uncensored</span>
          <button onClick={() => setSidebar(false)} title="Hide sidebar (⌘\)" className="no-drag rounded-md p-1.5 text-fg-3 hover:bg-white/[0.07] hover:text-fg">
            <Sidebar className="h-4 w-4" />
          </button>
        </div>
        <div className="flex gap-1.5 px-3 pb-3">
          <button
            onClick={() => create(false)}
            className="no-drag flex flex-1 items-center gap-2 rounded-lg bg-white/[0.07] px-3 py-2 text-[13px] font-medium text-fg transition-colors hover:bg-white/[0.11]"
          >
            <Plus className="h-4 w-4" /> New conversation
          </button>
          <button
            onClick={() => create(true)}
            title="Open a project folder"
            className="no-drag flex w-9 items-center justify-center rounded-lg text-fg-2 transition-colors hover:bg-white/[0.07] hover:text-fg"
          >
            <Folder className="h-4 w-4" />
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-2">
          {sorted.length > 0 && <p className="px-2.5 pb-1.5 pt-1 text-[10.5px] font-medium uppercase tracking-wider text-fg-3">Recent</p>}
          {sorted.map((c) => (
            <div
              key={c.id}
              onClick={() => setActiveId(c.id)}
              className={`group relative flex cursor-default items-center gap-2 rounded-lg px-2.5 py-2 transition-colors ${
                c.id === activeId ? "bg-white/[0.09]" : "hover:bg-white/[0.045]"
              }`}
            >
              <div className="min-w-0 flex-1" onDoubleClick={() => setRenaming(c.id)}>
                {renaming === c.id ? (
                  <TitleInput
                    value={c.title}
                    onDone={(t) => {
                      setRenaming(null);
                      if (t) update(c.id, (x) => ({ ...x, title: t, named: true }));
                    }}
                  />
                ) : (
                  <p className={`truncate text-[13px] ${c.id === activeId ? "text-fg" : "text-fg-2"}`}>{c.title}</p>
                )}
                <p className="mt-0.5 truncate text-[11px] text-fg-3">
                  {folderName(c.folder)} · {ago(c.updated)}
                </p>
              </div>
              <div className="hidden shrink-0 items-center group-hover:flex">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenaming(c.id);
                  }}
                  title="Rename"
                  className="rounded-md p-1 text-fg-3 hover:bg-white/[0.08] hover:text-fg"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(c.id);
                  }}
                  title="Delete conversation"
                  className="rounded-md p-1 text-fg-3 hover:bg-white/[0.08] hover:text-bad"
                >
                  <Trash className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </nav>
        {appUpdate.status === "ready" && (
          <button
            onClick={() => window.ou.installUpdate()}
            title={`Version ${appUpdate.version} is ready`}
            className="mx-3 -mb-1 mt-3 flex items-center gap-2 rounded-xl bg-white/[0.07] px-3 py-2.5 text-left text-[13px] font-medium text-fg transition-colors hover:bg-white/[0.11]"
          >
            <span className="flex-1">Relaunch to update</span>
            <ArrowUp className="h-3.5 w-3.5 rotate-90 text-fg-2" />
          </button>
        )}
        <button
          onClick={() => setSettings(true)}
          className="m-3 flex items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.05]"
        >
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-fg-3">Balance</p>
            <p className="text-[14px] font-medium tabular-nums">{typeof credit === "number" ? `$${credit.toFixed(2)}` : "–"}</p>
          </div>
          <Gear className="h-4 w-4 text-fg-3" />
        </button>
        <div onMouseDown={startResize} title="Drag to resize" className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-white/[0.06]" />
      </aside>
      )}

      <main className="flex min-w-0 flex-1 flex-col bg-ink">
        {active ? (
          <AgentView
            key={active.id}
            convo={active}
            models={models}
            update={update}
            onSpent={refreshCredit}
            bar={<SidebarToggle open={sidebar} onOpen={() => setSidebar(true)} />}
          />
        ) : (
          <Home onNew={create} bar={<SidebarToggle open={sidebar} onOpen={() => setSidebar(true)} />} />
        )}
      </main>

      {settings && (
        <Settings
          apiKey={key}
          credit={credit}
          onClose={() => setSettings(false)}
          onRefresh={refreshCredit}
          onSignOut={() => window.ou.setKey(null).then(() => setKey(null))}
        />
      )}
    </div>
  );
}

// Shown in the top bar when the sidebar is hidden: room for the window buttons, then a toggle.
function SidebarToggle({ open, onOpen }: { open: boolean; onOpen: () => void }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    window.ou.getUpdate().then((u) => setReady(u.status === "ready"));
    return window.ou.onUpdate((u) => setReady(u.status === "ready"));
  }, []);
  if (open) return null;
  return (
    <>
      <button onClick={onOpen} title="Show sidebar (⌘\)" className="no-drag ml-[72px] rounded-md p-1.5 text-fg-3 hover:bg-white/[0.07] hover:text-fg">
        <Sidebar className="h-4 w-4" />
      </button>
      {ready && (
        <button
          onClick={() => window.ou.installUpdate()}
          className="no-drag ml-1 shrink-0 rounded-full bg-white/[0.08] px-2.5 py-1 text-[11.5px] font-medium text-fg hover:bg-white/[0.13]"
        >
          Relaunch to update
        </button>
      )}
    </>
  );
}

function TitleInput({ value, onDone }: { value: string; onDone: (t: string | null) => void }) {
  const [text, setText] = useState(value);
  return (
    <input
      autoFocus
      value={text}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setText(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onDone(text.trim() || null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone(text.trim() || null);
        if (e.key === "Escape") onDone(null);
      }}
      className="no-drag w-full rounded-md border border-white/20 bg-ink px-1.5 py-0.5 text-[13px] text-fg outline-none"
    />
  );
}

function Home({ onNew, bar }: { onNew: (pick: boolean) => void; bar: React.ReactNode }) {
  return (
    <>
      <div className="drag flex h-[52px] shrink-0 items-center">{bar}</div>
      <div className="flex flex-1 flex-col items-center justify-center px-8 pb-16 text-center">
        <img src={logo} alt="" className="h-12 w-12 rounded-xl" />
        <h1 className="mt-5 text-[26px] font-semibold tracking-tight">What are we doing today?</h1>
        <p className="mt-2 max-w-sm text-[13.5px] leading-relaxed text-fg-2">
          Ask anything, or open a project and let the agent read, write and run code for you.
        </p>
        <div className="mt-7 flex gap-2.5">
          <button onClick={() => onNew(false)} className="flex items-center gap-2 rounded-lg bg-fg px-4 py-2.5 text-[13px] font-medium text-ink transition-colors hover:bg-white">
            <Plus className="h-4 w-4" /> New conversation
          </button>
          <button onClick={() => onNew(true)} className="flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2.5 text-[13px] text-fg transition-colors hover:bg-white/[0.05]">
            <Folder className="h-4 w-4" /> Open project
          </button>
        </div>
      </div>
    </>
  );
}

function Composer({
  busy,
  draft,
  setDraft,
  onSend,
  onStop,
  picker,
}: {
  busy: boolean;
  draft: string;
  setDraft: (s: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  picker: React.ReactNode;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const t = box.current;
    if (!t) return;
    t.style.height = "0px";
    t.style.height = `${Math.min(t.scrollHeight, 220)}px`;
  }, [draft]);
  useEffect(() => box.current?.focus(), []);
  const send = () => {
    const t = draft.trim();
    if (!t || busy) return;
    setDraft("");
    onSend(t);
  };
  return (
    <div className="px-6 pb-5 pt-2">
      <div className="mx-auto max-w-[760px] rounded-2xl border border-white/10 bg-ink-3 shadow-lg shadow-black/30 transition-colors focus-within:border-white/20">
        <textarea
          ref={box}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
          placeholder="Ask anything, or describe a task"
          className="block max-h-[220px] w-full resize-none bg-transparent px-4 pt-3.5 text-[14.5px] leading-relaxed text-fg outline-none placeholder:text-fg-3"
        />
        <div className="flex items-center justify-between gap-3 px-2 pb-2 pt-1">
          {picker}
          <div className="flex items-center gap-3">
            <span className="hidden text-[11px] text-fg-3 sm:block">{busy ? "Working" : "↵ send · ⇧↵ new line"}</span>
            {busy ? (
              <button onClick={onStop} title="Stop" className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-fg transition-colors hover:bg-white/20">
                <Square className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                onClick={send}
                disabled={!draft.trim()}
                title="Send"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-fg text-ink transition-opacity hover:bg-white disabled:opacity-30"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function useAutoScroll(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [dep]);
  return ref;
}

type Update = (id: string, fn: (c: Conversation) => Conversation) => void;

const SUGGESTIONS = [
  "What's in this folder? Give me a quick tour.",
  "Write a Python script that renames photos by the date they were taken.",
  "Find bugs in this project and fix the worst one.",
  "Explain how abliteration removes refusals from a model.",
];

function AgentView({
  convo,
  models,
  update,
  onSpent,
  bar,
}: {
  convo: Conversation;
  models: ModelInfo[];
  update: Update;
  onSpent: () => void;
  bar: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const convoRef = useRef(convo);
  convoRef.current = convo;
  const [draft, setDraft] = useState("");
  const runRef = useRef<string | null>(null);
  const scroller = useAutoScroll(convo.turns);

  const upsert = useCallback(
    (item: AgentItem) =>
      update(convo.id, (c) => {
        const turns = [...c.turns];
        const last = { ...turns[turns.length - 1] };
        const items = [...(last.items ?? [])];
        const at = items.findIndex((x) => x.id === item.id);
        if (at >= 0) items[at] = item;
        else items.push(item);
        last.items = items;
        turns[turns.length - 1] = last;
        return { ...c, turns, updated: Date.now() };
      }),
    [convo.id, update],
  );

  useEffect(
    () =>
      window.ou.onAgentEvent(({ runId, event }) => {
        if (runId !== runRef.current) return;
        const type = event.type as string;
        const item = (event.item ?? {}) as Record<string, unknown>;
        if (type === "thread.started") {
          update(convo.id, (c) => ({ ...c, threadId: event.thread_id as string }));
        } else if (type.startsWith("item.")) {
          const id = String(item.id);
          switch (item.type) {
            case "agent_message":
              upsert({ kind: "message", id, text: String(item.text ?? "") });
              break;
            case "reasoning":
              upsert({ kind: "reasoning", id, text: String(item.text ?? "") });
              break;
            case "command_execution":
              upsert({
                kind: "command",
                id,
                command: String(item.command ?? ""),
                output: String(item.aggregated_output ?? ""),
                exitCode: (item.exit_code as number | null) ?? null,
                running: type !== "item.completed",
              });
              break;
            case "file_change": {
              const changes = (item.changes as { path: string; kind: string }[]) ?? [];
              upsert({ kind: "file", id, summary: changes.map((c) => `${c.kind}\t${c.path}`).join("\n") });
              break;
            }
            case "error":
              if (!String(item.message).startsWith("Model metadata")) upsert({ kind: "error", id, text: String(item.message ?? "") });
              break;
          }
        } else if (type === "turn.failed" || type === "error") {
          const message = String((event.error as { message?: string })?.message ?? event.message ?? "The agent stopped.");
          upsert({ kind: "error", id: uid(), text: message });
        } else if (type === "run.exited") {
          if (event.code && event.stderr) upsert({ kind: "error", id: uid(), text: String(event.stderr).split("\n").slice(-6).join("\n") });
          runRef.current = null;
          setBusy(false);
          onSpent();
          // After the first exchange, a fast model names the conversation (unless the user did).
          const c = convoRef.current;
          if (!c.named && c.turns.length === 2) {
            suggestTitle(c.turns[0].text).then((t) => t && update(c.id, (x) => (x.named ? x : { ...x, title: t })));
          }
        }
      }),
    [convo.id, update, upsert, onSpent],
  );

  const send = async (prompt: string) => {
    const runId = uid();
    runRef.current = runId;
    setBusy(true);
    update(convo.id, (c) => ({
      ...c,
      title: c.turns.length || c.title !== DEFAULT_TITLE ? c.title : prompt.replace(/\s+/g, " ").slice(0, 60),
      turns: [...c.turns, { role: "user", text: prompt }, { role: "assistant", text: "", items: [], model: c.model }],
      updated: Date.now(),
    }));
    const r = await window.ou.startAgent({ runId, threadId: convo.threadId, prompt, cwd: convo.folder!, model: convo.model });
    if (r.error) {
      upsert({ kind: "error", id: uid(), text: r.error });
      runRef.current = null;
      setBusy(false);
    }
  };

  const modelName = (id?: string) => models.find((m) => m.id === id)?.name ?? id ?? "";
  const lastItems = convo.turns[convo.turns.length - 1]?.items ?? [];
  const running = lastItems.findLast((i) => i.kind === "command" && i.running) as Extract<AgentItem, { kind: "command" }> | undefined;

  return (
    <>
      <header className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-white/[0.06] pl-3 pr-6">
        {bar}
        <div className="min-w-0 flex-1 pl-3">
          {editingTitle ? (
            <div className="max-w-[420px]">
              <TitleInput
                value={convo.title}
                onDone={(t) => {
                  setEditingTitle(false);
                  if (t) update(convo.id, (x) => ({ ...x, title: t, named: true }));
                }}
              />
            </div>
          ) : (
            <button
              onClick={() => setEditingTitle(true)}
              title="Rename"
              className="no-drag group flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-white/[0.05]"
            >
              <span className="truncate text-[13.5px] font-medium">{convo.title}</span>
              <Pencil className="h-3 w-3 shrink-0 text-fg-3 opacity-0 group-hover:opacity-100" />
            </button>
          )}
        </div>
        <span title={convo.folder} className="no-drag flex max-w-[260px] items-center gap-1.5 rounded-md bg-white/[0.05] px-2 py-1 text-[11.5px] text-fg-2">
          <Folder className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{folderName(convo.folder)}</span>
        </span>
        <span className="no-drag rounded-md bg-orange/10 px-2 py-1 text-[11px] text-orange" title="The agent can read, edit and run anything your account can">
          Full access
        </span>
      </header>

      <div ref={scroller} className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-6 py-8">
          {convo.turns.length === 0 && (
            <div className="mt-[12vh] text-center">
              <p className="text-[20px] font-semibold tracking-tight">How can I help?</p>
              <p className="mt-1.5 text-[13px] text-fg-3">Working in {convo.folder}</p>
              <div className="mx-auto mt-7 grid max-w-[560px] grid-cols-2 gap-2.5 text-left">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => setDraft(s)}
                    className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3.5 py-3 text-left text-[12.5px] leading-snug text-fg-2 transition-colors hover:border-white/15 hover:bg-white/[0.05] hover:text-fg"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {convo.turns.map((t, i) =>
            t.role === "user" ? (
              <div key={i} className="max-w-[85%] self-end whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-white/[0.08] px-4 py-2.5 text-[14.5px] leading-relaxed">
                {t.text}
              </div>
            ) : (
              <div key={i} className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-[11.5px] text-fg-3">
                  <img src={logo} alt="" className="h-4 w-4 rounded" />
                  <span>{modelName(t.model)}</span>
                </div>
                {(t.items ?? []).map((it) => (
                  <AgentItemView key={it.id} item={it} />
                ))}
                {busy && i === convo.turns.length - 1 && (
                  <div className="flex items-center gap-2 py-1 text-[12.5px] text-fg-3">
                    <Spinner />
                    <span className="truncate">{running ? `Running ${cleanCommand(running.command).slice(0, 60)}` : "Thinking"}</span>
                  </div>
                )}
              </div>
            ),
          )}
        </div>
      </div>

      <Composer
        busy={busy}
        draft={draft}
        setDraft={setDraft}
        onSend={send}
        onStop={() => runRef.current && window.ou.stopAgent(runRef.current)}
        picker={<ModelPicker value={convo.model} models={models} onChange={(m) => update(convo.id, (c) => ({ ...c, model: m }))} />}
      />
    </>
  );
}

const cleanCommand = (cmd: string) => cmd.replace(/^\/bin\/(zsh|bash) -lc /, "").replace(/^(["'])([\s\S]*)\1$/, "$2");

function AgentItemView({ item }: { item: AgentItem }) {
  const [open, setOpen] = useState(false);
  switch (item.kind) {
    case "message":
      return <div className="md break-words" dangerouslySetInnerHTML={{ __html: md(item.text) }} />;
    case "reasoning":
      return (
        <button onClick={() => setOpen(!open)} className="group flex items-start gap-1.5 text-left text-[12.5px] text-fg-3 hover:text-fg-2">
          <ChevronRight className={`mt-[3px] h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
          <span className={open ? "whitespace-pre-wrap leading-relaxed" : "line-clamp-1"}>{open ? item.text : `Thought: ${item.text}`}</span>
        </button>
      );
    case "command": {
      const ok = !item.running && !item.exitCode;
      return (
        <div className="overflow-hidden rounded-lg border border-white/[0.07] bg-white/[0.02]">
          <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-white/[0.03]">
            <span className={item.running ? "text-blue" : ok ? "text-ok" : "text-bad"}>
              {item.running ? <Spinner /> : ok ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
            </span>
            <Terminal className="h-3.5 w-3.5 shrink-0 text-fg-3" />
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-2">{cleanCommand(item.command)}</span>
            {item.output && <ChevronRight className={`h-3 w-3 shrink-0 text-fg-3 transition-transform ${open ? "rotate-90" : ""}`} />}
          </button>
          {open && item.output && (
            <pre className="max-h-72 overflow-auto border-t border-white/[0.06] bg-black/30 px-3.5 py-2.5 font-mono text-[11.5px] leading-relaxed text-fg-2">{item.output}</pre>
          )}
        </div>
      );
    }
    case "file":
      return (
        <div className="flex flex-wrap gap-1.5">
          {item.summary.split("\n").map((line) => {
            const [kind, path] = line.split("\t");
            return (
              <span key={line} className="flex items-center gap-1.5 rounded-md border border-white/[0.07] bg-white/[0.03] px-2 py-1 font-mono text-[11.5px] text-fg-2">
                <File className="h-3.5 w-3.5 text-fg-3" />
                <span className="text-fg-3">{kind === "add" ? "Created" : kind === "delete" ? "Deleted" : "Edited"}</span>
                {path?.split("/").pop()}
              </span>
            );
          })}
        </div>
      );
    case "error":
      return <div className="whitespace-pre-wrap break-words rounded-lg border border-bad/30 bg-bad/[0.06] px-3 py-2 text-[12.5px] text-bad">{item.text}</div>;
  }
}

function Purchase({ topUpKey, onKey, onDone }: { topUpKey?: string; onKey?: (k: string) => void; onDone?: () => void }) {
  const [state, setState] = useState<"idle" | "waiting" | "error" | "done">("idle");
  const [message, setMessage] = useState("");
  const buy = async (credits: number) => {
    try {
      setState("waiting");
      setMessage("Finish the payment in your browser. This updates by itself when it clears.");
      const p = await startPurchase(credits, topUpKey);
      await window.ou.openUrl(p.payment_url);
      for (let i = 0; i < 180; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        const s = await pollPurchase(p.session_id, p.claim_token);
        if (s.status === "paid") {
          if (s.api_key && onKey) onKey(s.api_key);
          setState("done");
          setMessage("Payment received.");
          onDone?.();
          return;
        }
        if (s.status === "expired") throw new Error("The payment link expired. Try again.");
      }
      throw new Error("Timed out waiting for the payment.");
    } catch (e) {
      setState("error");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div>
      <div className="grid grid-cols-3 gap-2">
        {PACKS.map((c) => (
          <button
            key={c}
            disabled={state === "waiting"}
            onClick={() => buy(c)}
            className="rounded-lg border border-white/10 py-2.5 text-[14px] font-medium tabular-nums text-fg transition-colors hover:border-white/20 hover:bg-white/[0.05] disabled:opacity-40"
          >
            ${c / 100}
          </button>
        ))}
      </div>
      {message && (
        <p className={`mt-2.5 flex items-center gap-2 text-[12px] ${state === "error" ? "text-bad" : state === "done" ? "text-ok" : "text-fg-2"}`}>
          {state === "waiting" && <Spinner className="h-3 w-3" />}
          {message}
        </p>
      )}
    </div>
  );
}

function KeySetup({ onKey }: { onKey: (k: string) => void }) {
  const [value, setValue] = useState("");
  const valid = useMemo(() => /^ou-cus_[A-Za-z0-9]+-[a-f0-9]{40}$/.test(value.trim()), [value]);
  return (
    <div className="flex h-full flex-col bg-ink">
      <div className="drag h-[52px] shrink-0" />
      <div className="flex flex-1 items-center justify-center px-6 pb-12">
        <div className="w-full max-w-[400px]">
          <img src={logo} alt="" className="h-11 w-11 rounded-xl" />
          <h1 className="mt-5 text-[26px] font-semibold tracking-tight">Open Uncensored</h1>
          <div className="mt-7 rounded-2xl border border-white/[0.08] bg-ink-3 p-5">
            <p className="text-[13.5px] font-medium">Get started with credits</p>
            <p className="mb-3.5 mt-1 text-[12.5px] text-fg-3">Pay by card in your browser. Your key arrives here automatically.</p>
            <Purchase onKey={onKey} />
          </div>
          <div className="mt-3 rounded-2xl border border-white/[0.08] bg-ink-3 p-5">
            <p className="text-[13.5px] font-medium">Already have a key?</p>
            <div className="mt-3 flex gap-2">
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && valid && onKey(value.trim())}
                placeholder="ou-cus_…"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-ink px-3 py-2 font-mono text-[12px] outline-none transition-colors focus:border-white/25"
              />
              <button
                disabled={!valid}
                onClick={() => onKey(value.trim())}
                className="rounded-lg bg-fg px-3.5 py-2 text-[12.5px] font-medium text-ink transition-opacity disabled:opacity-30"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Settings({
  apiKey,
  credit,
  onClose,
  onRefresh,
  onSignOut,
}: {
  apiKey: string;
  credit: number | null;
  onClose: () => void;
  onRefresh: () => void;
  onSignOut: () => void;
}) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-[2px]" onClick={onClose}>
      <div className="w-full max-w-[420px] rounded-2xl border border-white/10 bg-ink-2 p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-[16px] font-semibold">Settings</h2>
          <button onClick={onClose} className="rounded-md p-1 text-fg-3 hover:bg-white/[0.07] hover:text-fg">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-5 rounded-xl bg-white/[0.03] p-4">
          <p className="text-[12px] text-fg-3">Balance</p>
          <p className="mt-0.5 text-[28px] font-semibold tabular-nums tracking-tight">{typeof credit === "number" ? `$${credit.toFixed(2)}` : "–"}</p>
          <p className="mt-1 text-[11.5px] text-fg-3">Key ending …{apiKey.slice(-4)}, stored encrypted in your keychain</p>
        </div>
        <p className="mb-2.5 mt-5 text-[13px] font-medium">Add credit</p>
        <Purchase topUpKey={apiKey} onDone={onRefresh} />
        <div className="mt-6 flex items-center justify-between border-t border-white/[0.06] pt-4">
          <button onClick={onSignOut} className="text-[12px] text-fg-3 transition-colors hover:text-bad">
            Remove key from this Mac
          </button>
          <UpdateLine />
        </div>
      </div>
    </div>
  );
}

// Settings footer: this version, and a manual check (the app also checks every 4 hours).
function UpdateLine() {
  const [u, setU] = useState<UpdateState>({ status: "idle" });
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    window.ou.getUpdate().then(setU);
    return window.ou.onUpdate(setU);
  }, []);
  const label =
    u.status === "ready"
      ? null
      : u.status === "downloading"
        ? `Downloading ${u.version}…`
        : u.status === "checking"
          ? "Checking…"
          : u.status === "error" && asked
            ? "Update failed, try later"
            : asked
              ? "Up to date"
              : "Check for updates";
  return (
    <span className="flex items-center gap-2 text-[12px] text-fg-3">
      <span>v{u.current}</span>
      {u.status === "ready" ? (
        <button onClick={() => window.ou.installUpdate()} className="font-medium text-fg hover:underline">
          Relaunch to update to {u.version}
        </button>
      ) : (
        <button
          disabled={u.status === "checking" || u.status === "downloading"}
          onClick={() => {
            setAsked(true);
            window.ou.checkForUpdate();
          }}
          className="hover:text-fg disabled:hover:text-fg-3"
        >
          {label}
        </button>
      )}
    </span>
  );
}

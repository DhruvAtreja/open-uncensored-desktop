import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Chat, Check, ChevronRight, File, Folder, Gear, ImageIcon, Pencil, Pin, Plus, Sidebar, Spinner, Square, Terminal, Trash, X } from "./icons";
import {
  agentError,
  type AgentItem,
  type Attachment,
  baseName,
  balance,
  branchContext,
  type Conversation,
  FEEDBACK_KINDS,
  fetchModels,
  isEphemeralPath,
  isShownImage,
  md,
  type ModelInfo,
  pollPurchase,
  sendFeedback,
  settleRunning,
  splitAttachments,
  startPurchase,
  suggestTitle,
  uid,
  type UpdateState,
  withAttachments,
} from "./lib";

// A new conversation's title before the model names it: what the user typed, else what they attached.
const titleOf = (prompt: string) => {
  const m = splitAttachments(prompt);
  const t = m.text || (m.attachments[0]?.image ? "Image" : baseName(m.attachments[0]?.file ?? ""));
  return t.replace(/\s+/g, " ").slice(0, 60);
};
import logo from "./logo.svg";
import { ModelPicker } from "./ModelPicker";

// Drives tools reliably through the agent; the default for new conversations.
// Windows draws its minimize/maximize/close buttons over the right of the 52px header; Mac puts its
// traffic lights on the left. Labels use the platform's modifier key.
const WIN = window.ou.platform === "win32";
const MOD = WIN ? "Ctrl+" : "⌘";

// New chats start on the #1 model in the rankings; this is only used until the list has loaded.
// New conversations start on DeepSeek V4.1 Flash 1017 whatever the hourly ranking says (it and GLM 5.3
// Flash trade #1 by a tenth of a point, and DeepSeek costs about a third as much per agent request).
// The current #1 only if DeepSeek ever drops out of the model list.
const DEFAULT_MODEL = "deepseek-v4.1-flash-1017-uncensored";
const topModel = (models: ModelInfo[]) =>
  !models.length || models.some((m) => m.id === DEFAULT_MODEL)
    ? DEFAULT_MODEL
    : (models.find((m) => m.rank === 1)?.id ?? DEFAULT_MODEL);
const PACKS = [1000, 2500, 5000];
// Emails a new key with the same credits to the address a purchase was paid with.
const RECOVER_URL = "https://openuncensored.com/credits/recover";
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
  const [feedback, setFeedback] = useState(false);
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
    window.ou.getConversations().then((list) =>
      setConvos(list.filter((c) => c.kind === "agent" && (c.turns.length > 0 || c.named || c.pinned)).map((c) => ({ ...c, turns: settleRunning(c.turns) }))),
    );
    fetchModels().then(setModels).catch(() => setModels([]));
  }, []);

  // Empty chats the user did not pick a model for move to the default (topModel), e.g. ones opened on
  // GLM while it was #1. Chats with messages or a chosen model keep theirs.
  useEffect(() => {
    if (!models.length) return;
    const top = topModel(models);
    setConvos((list) => {
      if (!list.some((c) => c.turns.length === 0 && !c.modelPicked && c.model !== top)) return list;
      const next = list.map((c) => (c.turns.length === 0 && !c.modelPicked ? { ...c, model: top } : c));
      persist(next);
      return next;
    });
  }, [models]);

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
  const runs = useAgentRuns(update, refreshCredit, convos);

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
      model: topModel(models),
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
  // A new conversation with the first `upTo` turns of `from`, in the same folder and on the same model.
  // "Edit in a branch" also passes the user's message, which lands in the composer to change and send.
  const branch = (from: Conversation, upTo: number, draft?: string) => {
    const convo: Conversation = {
      id: uid(),
      kind: "agent",
      title: `${from.title} (branch)`,
      named: true,
      model: from.model,
      modelPicked: true,
      folder: from.folder,
      turns: structuredClone(from.turns.slice(0, upTo)),
      branchedFrom: { id: from.id, title: from.title },
      draft,
      updated: Date.now(),
    };
    setConvos((list) => {
      const next = [convo, ...list];
      persist(next);
      return next;
    });
    setActiveId(convo.id);
  };
  const remove = (id: string) => {
    runs.stop(id); // a deleted conversation's task stops too
    setConvos((list) => {
      const next = list.filter((c) => c.id !== id);
      persist(next);
      if (activeId === id) setActiveId(null);
      return next;
    });
  };

  if (key === undefined) return <div className="h-full bg-ink" />;
  if (!key) return <KeySetup onKey={(k) => window.ou.setKey(k).then(() => setKey(k))} />;

  const active = convos.find((c) => c.id === activeId) ?? null;
  const sorted = [...convos].sort((a, b) => b.updated - a.updated);
  const pinned = sorted.filter((c) => c.pinned);
  const recent = sorted.filter((c) => !c.pinned);
  const togglePin = (id: string) => update(id, (c) => ({ ...c, pinned: !c.pinned || undefined }));
  const row = (c: Conversation) => (
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
              {runs.busy.has(c.id) && (
                <span title="Working" className="shrink-0 text-fg-3 group-hover:hidden">
                  <Spinner className="h-3.5 w-3.5" />
                </span>
              )}
              <div className="hidden shrink-0 items-center group-hover:flex">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePin(c.id);
                  }}
                  title={c.pinned ? "Unpin" : "Pin"}
                  className={`rounded-md p-1 hover:bg-white/[0.08] hover:text-fg ${c.pinned ? "text-fg" : "text-fg-3"}`}
                >
                  <Pin className="h-3.5 w-3.5" />
                </button>
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
            </div>);
  return (
    <div className="flex h-full text-fg">
      {sidebar && (
      <aside style={{ width }} className="relative flex shrink-0 flex-col border-r border-white/[0.06] bg-ink-2">
        <div className={`drag flex h-[52px] shrink-0 items-center pr-2 ${WIN ? "pl-3" : "pl-[84px]"}`}>
          <img src={logo} alt="" className="h-[18px] w-[18px] rounded-[5px]" />
          <span className="ml-2 min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight">OpenUncensored</span>
          <button onClick={() => setSidebar(false)} title={`Hide sidebar (${MOD}\\)`} className="no-drag rounded-md p-1.5 text-fg-3 hover:bg-white/[0.07] hover:text-fg">
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
          {pinned.length > 0 && <p className="px-2.5 pb-1.5 pt-1 text-[10.5px] font-medium uppercase tracking-wider text-fg-3">Pinned</p>}
          {pinned.map(row)}
          {recent.length > 0 && (
            <p className={`px-2.5 pb-1.5 text-[10.5px] font-medium uppercase tracking-wider text-fg-3 ${pinned.length ? "pt-4" : "pt-1"}`}>Recent</p>
          )}
          {recent.map(row)}
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
          onClick={() => setFeedback(true)}
          className="mx-3 -mb-1 mt-2 flex items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-fg-2 transition-colors hover:bg-white/[0.05] hover:text-fg"
        >
          <Chat className="h-4 w-4 text-fg-3" />
          <span className="flex-1">Submit feedback</span>
        </button>
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
            runs={runs}
            update={update}
            onSpent={refreshCredit}
            onBranch={(upTo, draft) => branch(active, upTo, draft)}
            onOpen={(id) => convos.some((c) => c.id === id) && setActiveId(id)}
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
      {feedback && <Feedback model={active?.model} onClose={() => setFeedback(false)} />}
    </div>
  );
}

// "Submit feedback" (sidebar): a message to the team, sent with the account, app version, OS and model.
function Feedback({ model, onClose }: { model?: string; onClose: () => void }) {
  const [kind, setKind] = useState<string>("bug");
  const [message, setMessage] = useState("");
  const [contact, setContact] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState("");
  const submit = useCallback(async () => {
    if (!message.trim() || state === "sending") return;
    setState("sending");
    setError("");
    const r = await sendFeedback({ message: message.trim(), category: kind, contact: contact.trim(), model });
    if (r.ok) setState("sent");
    else {
      setState("idle");
      setError(r.error);
    }
  }, [message, kind, contact, model, state]);
  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [onClose, submit]);
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-[2px]" onClick={onClose}>
      <div className="w-full max-w-[460px] rounded-2xl border border-white/10 bg-ink-2 p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-[16px] font-semibold">Submit feedback</h2>
          <button onClick={onClose} className="rounded-md p-1 text-fg-3 hover:bg-white/[0.07] hover:text-fg">
            <X className="h-4 w-4" />
          </button>
        </div>
        {state === "sent" ? (
          <div className="mt-6 text-center">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-white/[0.06]">
              <Check className="h-5 w-5 text-ok" />
            </div>
            <p className="mt-3 text-[14px] font-medium">Thanks, we got it.</p>
            <p className="mt-1 text-[12.5px] text-fg-3">A person on the team reads every message.</p>
            <button onClick={onClose} className="mt-5 rounded-xl bg-fg px-4 py-2 text-[13px] font-medium text-ink hover:opacity-90">
              Close
            </button>
          </div>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {FEEDBACK_KINDS.map((k) => (
                <button
                  key={k.id}
                  onClick={() => setKind(k.id)}
                  className={`rounded-full border px-3 py-1 text-[12px] transition-colors ${
                    kind === k.id ? "border-white/25 bg-white/[0.1] text-fg" : "border-white/[0.08] text-fg-3 hover:text-fg-2"
                  }`}
                >
                  {k.label}
                </button>
              ))}
            </div>
            <textarea
              autoFocus
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={5000}
              rows={6}
              placeholder={
                kind === "bug"
                  ? "What happened, and what did you expect?"
                  : kind === "model_request"
                    ? "Which model should we add?"
                    : "What should we add or change?"
              }
              className="mt-3 w-full resize-none rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-[13.5px] leading-relaxed outline-none placeholder:text-fg-3 focus:border-white/20"
            />
            <input
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder="Your email, if you want a reply (optional)"
              className="mt-2 w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[13px] outline-none placeholder:text-fg-3 focus:border-white/20"
            />
            {error && <p className="mt-2 text-[12px] text-bad">{error}</p>}
            <div className="mt-4 flex justify-end">
              <button
                onClick={() => void submit()}
                disabled={!message.trim() || state === "sending"}
                className="flex shrink-0 items-center gap-2 rounded-xl bg-fg px-4 py-2 text-[13px] font-medium text-ink transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {state === "sending" && <Spinner />}
                Send
              </button>
            </div>
          </>
        )}
      </div>
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
      <button onClick={onOpen} title={`Show sidebar (${MOD}\\)`} className={`no-drag rounded-md p-1.5 text-fg-3 hover:bg-white/[0.07] hover:text-fg ${WIN ? "ml-1" : "ml-[72px]"}`}>
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
          Ask anything, generate and edit images, or open a project and let the agent read, write and run code for you.
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
  // Attachments (pasted, dropped or added with +): images show as thumbnails, other files as chips. They
  // are sent after the text as <image_attached> / <file_attached> paths, never typed into the message.
  const [attached, setAttached] = useState<(Attachment & { src: string })[]>([]);
  const addPaths = async (paths: string[]) => {
    const loaded = await Promise.all(
      paths.map(async (file) => {
        const src = isShownImage(file) ? ((await window.ou.readImage(file)) ?? "") : "";
        return { file, image: Boolean(src), src };
      }),
    );
    setAttached((prev) => [...prev, ...loaded.filter((a) => !prev.some((p) => p.file === a.file))]);
    box.current?.focus();
  };
  // A draft that carries attachments ("Edit in a branch") shows them as thumbnails and chips again.
  useEffect(() => {
    const { text, attachments } = splitAttachments(draft);
    if (!attachments.length) return;
    setDraft(text);
    void addPaths(attachments.map((a) => a.file));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Dropped or pasted files are attached from where they are on disk. An image with no file behind it (a
  // screenshot, an image dragged out of a web page), or in a format the app cannot show, is saved to the
  // temp folder as PNG, JPEG or WebP first.
  // Any other file without a path (dragged out of a browser, an email or a zip) is saved there under its
  // own name; an image the app cannot convert is attached as a plain file. Nothing is dropped silently.
  const [dropNote, setDropNote] = useState<string | null>(null);
  const addFiles = async (files: File[]) => {
    const paths: string[] = [];
    const failed: string[] = [];
    for (const f of files) {
      // A file in a system temp folder (a screenshot dragged from the macOS thumbnail lives in
      // TemporaryItems/NSIRD_screencaptureui_...) is readable by the app thanks to the drag, but not by
      // the agent, and macOS deletes it soon after. Such files are copied in, like files with no path.
      const found = window.ou.pathForFile(f);
      const where = found && !isEphemeralPath(found) ? found : "";
      const image = f.type.startsWith("image/");
      if (where && (!image || isShownImage(where))) {
        paths.push(where);
        continue;
      }
      const bytes = await f.arrayBuffer().catch(() => null);
      const saved = bytes
        ? found && !where
          ? await window.ou.saveFile(bytes, f.name || baseName(found)) // a temp file: same name, same format
          : (image ? await window.ou.pasteImage(bytes, f.type) : null) ?? (where || (await window.ou.saveFile(bytes, f.name || "file")))
        : where || null;
      if (saved) paths.push(saved);
      else failed.push(f.name || "a file");
    }
    if (paths.length) await addPaths(paths);
    setDropNote(failed.length ? `Could not attach ${failed.join(", ")} (over 100 MB or unreadable).` : null);
  };
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const blobs = [...e.clipboardData.items]
      .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
      .map((i) => i.getAsFile())
      .filter((f): f is File => Boolean(f));
    // Copied text often comes with a picture of itself (Word, web pages): that pastes as text. An image
    // file copied in Finder also brings its name as text, but it is a real file, so it is attached.
    const onDisk = blobs.some((b) => window.ou.pathForFile(b));
    if (!blobs.length || (e.clipboardData.getData("text/plain") && !onDisk)) return;
    e.preventDefault();
    void addFiles(blobs);
  };
  // Drag and drop anywhere in the window while a conversation is open.
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes("Files"));
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e) || --depth > 0) return;
      depth = 0;
      setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      void addFiles([...(e.dataTransfer?.files ?? [])]);
    };
    // Without this the page may refuse the drop for some sources and the drop event never fires.
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const send = () => {
    const t = draft.trim();
    if ((!t && !attached.length) || busy) return;
    setDraft("");
    setAttached([]);
    onSend(withAttachments(t, attached));
  };
  const attach = async () => {
    const paths = await window.ou.pickFiles();
    if (paths.length) await addPaths(paths);
  };
  return (
    <div className="px-6 pb-4 pt-2">
      <div className="mx-auto max-w-[760px]">
        <div
          className={`rounded-[16px] border transition-colors ${dragging ? "border-white/40 bg-[#383838]" : "border-[#404040] bg-[#303030] focus-within:border-[#4a4a4a]"}`}
        >
        {dragging && <div className="px-4 pt-3 text-[13px] text-fg-2">Drop images or files to attach them</div>}
        {dropNote && !dragging && <div className="px-4 pt-3 text-[12.5px] text-bad">{dropNote}</div>}
        {attached.length > 0 && (
          <div className="flex flex-wrap items-center gap-2.5 px-3 pb-1 pt-3">
            {attached.map((a) => (
              <div key={a.file} className="relative">
                {a.image ? (
                  <button onClick={() => window.ou.openImage(a.file)} title={a.file} className="block overflow-hidden rounded-lg border border-white/10 hover:border-white/25">
                    <img src={a.src} alt="" className="block h-16 w-16 object-cover" />
                  </button>
                ) : (
                  <FileChip file={a.file} />
                )}
                <button
                  onClick={() => setAttached((prev) => prev.filter((p) => p.file !== a.file))}
                  title="Remove"
                  className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-white/20 bg-[#1f1f1f] text-fg-2 transition-colors hover:text-fg"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-1 py-[3px] pl-1.5 pr-1.5">
          <button
            onClick={attach}
            title="Attach files or images (you can also paste or drop them)"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-fg transition-colors hover:bg-white/[0.08]"
          >
            <Plus className="h-4 w-4" />
          </button>
          <textarea
            ref={box}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder="Ask anything, or describe a task"
            className="block max-h-[220px] min-h-[32px] flex-1 resize-none bg-transparent py-[6px] text-[14.5px] leading-[20px] text-fg outline-none placeholder:text-[#878787]"
          />
          {busy ? (
            <button onClick={onStop} title="Stop" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-fg transition-colors hover:bg-white/20">
              <Square className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              onClick={send}
              disabled={!draft.trim() && !attached.length}
              title="Send (↵)"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-fg text-ink transition-opacity hover:bg-white disabled:bg-transparent disabled:text-fg-3"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>
        </div>
        <div className="mt-2 flex items-center justify-end gap-4 pr-1 text-[13px]">
          {picker}
          <span className="text-fg" title="The agent can read, edit and run anything your account can">
            Full access
          </span>
          {busy && <Spinner className="h-3.5 w-3.5 text-fg-3" />}
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


// Agent runs belong to the app, not to the open conversation's view: a run keeps reporting into its own
// conversation while the user looks at another one (before 0.1.29 its events were dropped when the user
// switched away, so the transcript froze while the work went on), and Stop / busy survive switching.
type AgentRuns = {
  busy: Set<string>; // conversation ids with a run in progress
  send: (convo: Conversation, prompt: string) => Promise<void>;
  stop: (convoId: string) => void;
};

function useAgentRuns(update: Update, onSpent: () => void, convos: Conversation[]): AgentRuns {
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const runOf = useRef(new Map<string, string>()); // runId -> conversation id
  const stopped = useRef(new Set<string>()); // runs the user pressed Stop on
  const convosRef = useRef(convos);
  convosRef.current = convos;

  const setRunning = useCallback((convoId: string, on: boolean) => {
    setBusy((prev) => {
      if (prev.has(convoId) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(convoId);
      else next.delete(convoId);
      return next;
    });
  }, []);

  const finish = useCallback(
    (runId: string) => {
      const convoId = runOf.current.get(runId);
      runOf.current.delete(runId);
      stopped.current.delete(runId);
      if (convoId && ![...runOf.current.values()].includes(convoId)) setRunning(convoId, false);
      onSpent();
    },
    [onSpent, setRunning],
  );

  const upsert = useCallback(
    (convoId: string, item: AgentItem) =>
      update(convoId, (c) => {
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
    [update],
  );

  useEffect(
    () =>
      window.ou.onAgentEvent(({ runId, event }) => {
        const convoId = runOf.current.get(runId);
        if (!convoId) return;
        const put = (item: AgentItem) => upsert(convoId, item);
        // The same failure is often reported twice (as an item and as turn.failed): show it once.
        const putError = (text: string) =>
          update(convoId, (c) => {
            const last = c.turns[c.turns.length - 1];
            if (last?.items?.some((i) => i.kind === "error" && i.text === text)) return c;
            const turns = [...c.turns];
            turns[turns.length - 1] = { ...last, items: [...(last.items ?? []), { kind: "error", id: uid(), text }] };
            return { ...c, turns, updated: Date.now() };
          });
        const hasError = () => {
          const c = convosRef.current.find((x) => x.id === convoId);
          return Boolean(c?.turns[c.turns.length - 1]?.items?.some((i) => i.kind === "error"));
        };
        const type = event.type as string;
        const item = (event.item ?? {}) as Record<string, unknown>;
        if (type === "thread.started") {
          update(convoId, (c) => ({ ...c, threadId: event.thread_id as string }));
        } else if (type.startsWith("item.")) {
          const id = String(item.id);
          switch (item.type) {
            case "agent_message":
              put({ kind: "message", id, text: String(item.text ?? "") });
              break;
            case "reasoning":
              put({ kind: "reasoning", id, text: String(item.text ?? "") });
              break;
            case "command_execution":
              put({
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
              put({ kind: "file", id, summary: changes.map((c) => `${c.kind}\t${c.path}`).join("\n") });
              break;
            }
            case "mcp_tool_call": {
              // The image tool (electron/image-tool.cjs); other MCP tools are not configured.
              if (item.tool !== "generate_image") break;
              const args = (item.arguments ?? {}) as { prompt?: string; model?: string; reference_images?: string[] };
              const result = (item.result ?? {}) as { content?: { type: string; text?: string }[]; structured_content?: { files?: string[] } };
              const files = result.structured_content?.files ?? [];
              const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
              const error = (item.error as { message?: string } | null)?.message ?? (item.status === "failed" || (!files.length && type === "item.completed") ? text || "Image generation failed." : "");
              put({ kind: "image", id, prompt: String(args.prompt ?? ""), model: String(args.model ?? (Array.isArray(args.reference_images) && args.reference_images.length ? "qwen-image-3-edit" : "z-image-turbo")), files, error, running: type !== "item.completed" });
              break;
            }
            case "error":
              if (!String(item.message).startsWith("Model metadata")) putError(agentError(String(item.message ?? "")));
              break;
          }
        } else if (type === "turn.failed" || type === "error") {
          const message = String((event.error as { message?: string })?.message ?? event.message ?? "The agent stopped.");
          putError(agentError(message));
        } else if (type === "run.exited") {
          // A run the user stopped exits with an error by design: nothing to report.
          // The exit log only matters when nothing better was reported ("The agent stopped." after a real error is noise).
          if (event.code && event.stderr && !stopped.current.has(runId) && !hasError()) putError(agentError(String(event.stderr)));
          update(convoId, (c) => ({ ...c, turns: settleRunning(c.turns) }));
          finish(runId);
          // After the first exchange, a fast model names the conversation (unless the user did).
          const c = convosRef.current.find((x) => x.id === convoId);
          if (c && !c.named && c.turns.length === 2) {
            const first = splitAttachments(c.turns[0].text).text;
            if (first) suggestTitle(first).then((t) => t && update(convoId, (x) => (x.named ? x : { ...x, title: t })));
          }
        }
      }),
    [update, upsert, finish],
  );

  const send = useCallback(
    async (convo: Conversation, prompt: string) => {
      const runId = uid();
      runOf.current.set(runId, convo.id);
      setRunning(convo.id, true);
      update(convo.id, (c) => ({
        ...c,
        title: c.turns.length || c.title !== DEFAULT_TITLE ? c.title : titleOf(prompt),
        turns: [...c.turns, { role: "user", text: prompt }, { role: "assistant", text: "", items: [], model: c.model }],
        updated: Date.now(),
      }));
      // The first message of a branch starts a new agent session: give it the conversation so far.
      const agentPrompt = !convo.threadId && convo.turns.length > 0 ? branchContext(convo.turns) + prompt : prompt;
      const r = await window.ou.startAgent({ runId, threadId: convo.threadId, prompt: agentPrompt, cwd: convo.folder!, model: convo.model });
      if (r.error) {
        upsert(convo.id, { kind: "error", id: uid(), text: agentError(r.error) });
        finish(runId);
      }
    },
    [update, upsert, finish, setRunning],
  );

  // Stop ends the run and everything it started. If the run has not reported back within 3 seconds, the
  // conversation is freed anyway, so it can never stay stuck on "working".
  const stop = useCallback(
    (convoId: string) => {
      const ids = [...runOf.current].filter(([, c]) => c === convoId).map(([r]) => r);
      if (!ids.length) return setRunning(convoId, false);
      update(convoId, (c) => ({ ...c, turns: settleRunning(c.turns) }));
      for (const runId of ids) {
        stopped.current.add(runId);
        void window.ou.stopAgent(runId);
        setTimeout(() => runOf.current.has(runId) && finish(runId), 3000);
      }
    },
    [update, finish, setRunning],
  );

  return useMemo(() => ({ busy, send, stop }), [busy, send, stop]);
}

function AgentView({
  convo,
  models,
  runs,
  update,
  onSpent,
  onBranch,
  onOpen,
  bar,
}: {
  convo: Conversation;
  models: ModelInfo[];
  runs: AgentRuns;
  update: Update;
  onSpent: () => void;
  onBranch: (upTo: number, draft?: string) => void;
  onOpen: (id: string) => void;
  bar: React.ReactNode;
}) {
  const busy = runs.busy.has(convo.id);
  const [editingTitle, setEditingTitle] = useState(false);
  const [draft, setDraft] = useState(convo.draft ?? "");
  // A branch made with "Edit in a branch" opens with the message in the composer, once.
  useEffect(() => {
    if (convo.draft !== undefined) update(convo.id, (c) => ({ ...c, draft: undefined }));
  }, [convo.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const scroller = useAutoScroll(convo.turns);
  const send = (prompt: string) => runs.send(convo, prompt);
  const stop = () => runs.stop(convo.id);

  const modelName = (id?: string) => models.find((m) => m.id === id)?.name ?? id ?? "";
  const lastItems = convo.turns[convo.turns.length - 1]?.items ?? [];
  const running = lastItems.findLast((i) => i.kind === "command" && i.running) as Extract<AgentItem, { kind: "command" }> | undefined;
  const drawing = lastItems.some((i) => i.kind === "image" && i.running);

  return (
    <>
      <header className={`drag flex h-[52px] shrink-0 items-center gap-3 border-b border-white/[0.06] pl-3 ${WIN ? "pr-[150px]" : "pr-6"}`}>
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
      </header>

      <div ref={scroller} className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-6 py-8">
          {convo.turns.length === 0 && (
            <div className="mt-[12vh] text-center">
              <p className="text-[20px] font-semibold tracking-tight">How can I help?</p>
              <p className="mt-1.5 text-[13px] text-fg-3">Working in {convo.folder}</p>
            </div>
          )}
          {convo.branchedFrom && (
            <button
              onClick={() => onOpen(convo.branchedFrom!.id)}
              className="self-center rounded-full bg-white/[0.05] px-3 py-1 text-[11.5px] text-fg-3 transition-colors hover:text-fg"
            >
              Branched from {convo.branchedFrom.title}
            </button>
          )}
          {convo.turns.map((t, i) =>
            t.role === "user" ? (
              <div key={i} className="group flex flex-col items-end gap-1">
                <UserMessage text={t.text} />
                {!busy && (
                  <button
                    onClick={() => onBranch(i, t.text)}
                    title="Start a new conversation from just before this message, with it in the composer to change"
                    className="text-[11.5px] text-fg-3 opacity-0 transition-opacity hover:text-fg group-hover:opacity-100"
                  >
                    Edit in a branch
                  </button>
                )}
              </div>
            ) : (
              <div key={i} className="group flex flex-col gap-2">
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
                    <span className="truncate">{drawing ? "Generating image" : running ? `Running ${cleanCommand(running.command).slice(0, 60)}` : "Thinking"}</span>
                  </div>
                )}
                {!(busy && i === convo.turns.length - 1) && (
                  <button
                    onClick={() => onBranch(i + 1)}
                    title="Start a new conversation that continues from this reply; this one stays as it is"
                    className="self-start text-[11.5px] text-fg-3 opacity-0 transition-opacity hover:text-fg group-hover:opacity-100"
                  >
                    Branch from here
                  </button>
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
        onStop={stop}
        picker={<ModelPicker value={convo.model} models={models} onChange={(m) => update(convo.id, (c) => ({ ...c, model: m, modelPicked: true }))} />}
      />
    </>
  );
}

// Shell wrappers Codex adds around a command: /bin/zsh -lc on Mac, PowerShell -Command on Windows.
const cleanCommand = (cmd: string) =>
  cmd
    .replace(/^\/bin\/(zsh|bash) -lc /, "")
    .replace(/^"?(?:[^"]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-\w+\s+)*?-Command\s+/i, "")
    .replace(/^(["'])([\s\S]*)\1$/, "$2");

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
    case "image":
      return (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-[12.5px] text-fg-3">
            <span className={item.running ? "text-blue" : item.error ? "text-bad" : "text-ok"}>
              {item.running ? <Spinner /> : item.error ? <X className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
            </span>
            <ImageIcon className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">
              {item.running ? "Generating" : "Generated"} with {item.model}: <span className="text-fg-2">{item.prompt}</span>
            </span>
          </div>
          {item.files.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {item.files.map((f) => (
                <LocalImage key={f} file={f} />
              ))}
            </div>
          )}
          {item.error && <div className="whitespace-pre-wrap break-words rounded-lg border border-bad/30 bg-bad/[0.06] px-3 py-2 text-[12.5px] text-bad">{item.error}</div>}
        </div>
      );
    case "error":
      return <div className="whitespace-pre-wrap break-words rounded-lg border border-bad/30 bg-bad/[0.06] px-3 py-2 text-[12.5px] text-bad">{agentError(item.text)}</div>;
  }
}

// What the user sent: their attachments (thumbnails and chips), then their text. The <..._attached> tags
// stay in the stored text for the agent; they are never shown.
function UserMessage({ text }: { text: string }) {
  const m = splitAttachments(text);
  return (
    <>
      {m.attachments.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap items-center justify-end gap-2">
          {m.attachments.map((a) => (a.image ? <LocalImage key={a.file} file={a.file} small /> : <FileChip key={a.file} file={a.file} />))}
        </div>
      )}
      {m.text && (
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-white/[0.08] px-4 py-2.5 text-[14.5px] leading-relaxed">
          {m.text}
        </div>
      )}
    </>
  );
}

// An attached file that is not a picture: its name; a click shows it in Finder / Explorer.
function FileChip({ file }: { file: string }) {
  return (
    <button
      onClick={() => window.ou.showFile(file)}
      title={file}
      className="flex max-w-[260px] items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[12.5px] text-fg-2 transition-colors hover:border-white/25 hover:text-fg"
    >
      <File className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{baseName(file)}</span>
    </button>
  );
}

// A picture the image tool saved in the conversation's folder, or one the user pasted (small);
// opens in the default image viewer on click.
function LocalImage({ file, small = false }: { file: string; small?: boolean }) {
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    window.ou.readImage(file).then((s) => live && setSrc(s));
    return () => {
      live = false;
    };
  }, [file]);
  if (src === null) return <span className="rounded-md bg-white/[0.04] px-2 py-1 font-mono text-[11.5px] text-fg-3">{file.split(/[\\/]/).pop()} (moved or deleted)</span>;
  return (
    <button onClick={() => window.ou.openImage(file)} title={file} className="overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.03] hover:border-white/20">
      {src ? (
        <img src={src} alt="" className={`block object-contain ${small ? "max-h-[180px] max-w-[240px]" : "max-h-[360px] max-w-[360px]"}`} />
      ) : (
        <div className={`grid place-items-center ${small ? "h-[100px] w-[100px]" : "h-[200px] w-[200px]"}`}>
          <Spinner />
        </div>
      )}
    </button>
  );
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
          <h1 className="mt-5 text-[26px] font-semibold tracking-tight">OpenUncensored</h1>
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
            <button
              onClick={() => window.ou.openUrl(RECOVER_URL)}
              className="mt-3 block text-left text-[12px] text-fg-3 underline decoration-white/20 underline-offset-4 transition-colors hover:text-fg hover:decoration-white/60"
            >
              Lost your key? Get a new one by email, with the same credits
            </button>
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
  // The key lives only on this computer and, when bought in the app, was never shown: removing it
  // without a copy loses the credits on it. So removal asks first and offers a copy.
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await window.ou.copyKey()) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (confirmRemove) setConfirmRemove(false);
      else onClose();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose, confirmRemove]);
  const device = WIN ? "PC" : "Mac";
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
          <div className="mt-1 flex items-center justify-between gap-3">
            <p className="text-[11.5px] text-fg-3">Key ending …{apiKey.slice(-4)}, stored only on this computer</p>
            <button
              onClick={copy}
              className="shrink-0 rounded-md border border-white/10 px-2 py-1 text-[11.5px] text-fg-2 transition-colors hover:border-white/25 hover:text-fg"
            >
              {copied ? "Copied" : "Copy key"}
            </button>
          </div>
        </div>
        <p className="mb-2.5 mt-5 text-[13px] font-medium">Add credit</p>
        <Purchase topUpKey={apiKey} onDone={onRefresh} />
        {confirmRemove ? (
          <div className="mt-6 rounded-xl border border-bad/30 bg-bad/[0.06] p-4">
            <p className="text-[13px] font-medium">Remove your key from this {device}?</p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-fg-2">
              This is the only copy of your key
              {typeof credit === "number" && credit > 0 ? `, and it holds $${credit.toFixed(2)} of credit` : ""}. Copy it
              first to use it again later. Without it you have to get a new key by email.
            </p>
            <div className="mt-3.5 flex flex-wrap gap-2">
              <button onClick={copy} className="rounded-lg bg-fg px-3 py-1.5 text-[12px] font-medium text-ink">
                {copied ? "Copied" : "Copy key"}
              </button>
              <button
                onClick={onSignOut}
                className="rounded-lg border border-bad/40 px-3 py-1.5 text-[12px] text-bad transition-colors hover:bg-bad/10"
              >
                Remove
              </button>
              <button
                onClick={() => setConfirmRemove(false)}
                className="rounded-lg px-3 py-1.5 text-[12px] text-fg-3 transition-colors hover:text-fg"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        <div className="mt-6 flex items-center justify-between border-t border-white/[0.06] pt-4">
          {confirmRemove ? (
            <span />
          ) : (
            <button onClick={() => setConfirmRemove(true)} className="text-[12px] text-fg-3 transition-colors hover:text-bad">
              Remove key from this {device}
            </button>
          )}
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

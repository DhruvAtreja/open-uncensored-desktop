import { marked } from "marked";

// Shared types, the OpenUncensored API calls and safe markdown.

export const SITE = "https://openuncensored.com";
export const API = `${SITE}/api/v1`;

export interface ModelInfo {
  id: string;
  name: string;
  rank: number | null;
  score: number | null;
  agentic?: number;
  intelligence?: number;
}

export type AgentItem =
  | { kind: "message"; id: string; text: string }
  | { kind: "reasoning"; id: string; text: string }
  | { kind: "command"; id: string; command: string; output: string; exitCode: number | null; running: boolean }
  | { kind: "file"; id: string; summary: string }
  | { kind: "image"; id: string; prompt: string; model: string; files: string[]; error: string; running: boolean }
  | { kind: "error"; id: string; text: string };

export interface Turn {
  role: "user" | "assistant";
  text: string; // chat text, or the user's prompt in agent mode
  items?: AgentItem[]; // agent mode: what the agent did
  model?: string;
  error?: string;
}

export interface Conversation {
  id: string;
  kind: "chat" | "agent";
  title: string;
  model: string;
  folder?: string; // agent mode: the project folder
  threadId?: string; // agent mode: Codex thread to resume
  named?: boolean; // the user renamed it: never auto-title over it
  modelPicked?: boolean; // the user chose the model: never switch it to the current #1
  branchedFrom?: { id: string; title: string }; // made with "Branch from here" / "Edit in a branch"
  draft?: string; // text to put in the composer when the conversation opens (an edited message)
  turns: Turn[];
  updated: number;
}

export interface UpdateState {
  status: "idle" | "checking" | "downloading" | "ready" | "error";
  version?: string; // the new version
  current?: string; // this app's version
  message?: string;
}

declare global {
  interface Window {
    ou: {
      platform: string;
      getKey(): Promise<string | null>;
      setKey(key: string | null): Promise<void>;
      getConversations(): Promise<Conversation[]>;
      setConversations(list: Conversation[]): Promise<void>;
      pickFolder(): Promise<string | null>;
      pickFiles(): Promise<string[]>;
      defaultFolder(): Promise<string>;
      openUrl(url: string): Promise<void>;
      readImage(file: string): Promise<string | null>;
      openImage(file: string): Promise<void>;
      request(opts: { url: string; method?: string; body?: unknown; auth?: boolean; claim?: string }): Promise<{ status: number; json: unknown }>;
      startChat(opts: { streamId: string; model: string; messages: { role: string; content: string }[] }): Promise<boolean>;
      stopChat(streamId: string): Promise<boolean>;
      onChatEvent(fn: (p: { streamId: string; type: string; text?: string; message?: string; status?: number; model?: string | null; stopped?: boolean }) => void): () => void;
      startAgent(opts: { runId: string; threadId?: string; prompt: string; cwd: string; model: string }): Promise<{ ok?: boolean; error?: string }>;
      stopAgent(runId: string): Promise<boolean>;
      onAgentEvent(fn: (p: { runId: string; event: Record<string, unknown> }) => void): () => void;
      getUpdate(): Promise<UpdateState>;
      checkForUpdate(): Promise<void>;
      installUpdate(): Promise<boolean>;
      onUpdate(fn: (s: UpdateState) => void): () => void;
    };
  }
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// Model output is untrusted: raw HTML in it is shown as text, never rendered.
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
marked.use({ renderer: { html: ({ text }) => escape(text) } });
export const md = (text: string) => marked.parse(text, { async: false }) as string;

const get = async (url: string, auth = false) => (await window.ou.request({ url, auth })).json as Record<string, unknown>;

export async function fetchModels(): Promise<ModelInfo[]> {
  const [rankings, catalog] = await Promise.all([get(`${SITE}/api/rankings.json`), get(`${API}/models`)]);
  const scores = new Map<string, Record<string, unknown>>(
    ((rankings.models as Record<string, unknown>[]) ?? []).map((m) => [m.id as string, m]),
  );
  return ((catalog.data as { id: string; name?: string }[]) ?? [])
    .map((m) => {
      const s = scores.get(m.id) ?? scores.get(m.id.replace(/-thinking$/, ""));
      return {
        id: m.id,
        name: (s?.name as string) || m.name || m.id,
        rank: m.id.endsWith("-thinking") ? null : ((s?.rank as number | null) ?? null),
        score: (s?.score as number | undefined) ?? null,
        agentic: s?.agentic as number | undefined,
        intelligence: s?.intelligence as number | undefined,
      };
    })
    .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999) || a.name.localeCompare(b.name));
}

// A short title for a conversation, written by a fast model from the first message.
export async function suggestTitle(prompt: string): Promise<string | null> {
  const r = await window.ou.request({
    url: `${API}/chat/completions`,
    method: "POST",
    body: {
      model: "venice-uncensored",
      max_tokens: 20,
      temperature: 0.2,
      messages: [
        { role: "system", content: "You name chat conversations. You never answer or continue the conversation." },
        {
          role: "user",
          content: `<conversation>\nUser: ${prompt.slice(0, 2000)}\n</conversation>\n\nGive this conversation a short title of 2 to 6 words, like a chat app sidebar would. Output only the title.`,
        },
      ],
    },
  });
  const text = (r.json as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "";
  const title = text.replace(/["'*#]/g, "").split("\n").find((l) => l.trim())?.trim().replace(/[.:]$/, "");
  // Anything longer than a title means the model answered instead: keep the prompt-based title.
  return r.status === 200 && title && title.split(/\s+/).length <= 8 ? title : null;
}

export async function balance(): Promise<number | null> {
  const r = await window.ou.request({ url: `${API}/credits` });
  const usd = (r.json as { data?: { remaining_usd?: unknown } }).data?.remaining_usd;
  return r.status === 200 && typeof usd === "number" ? usd : null;
}

// Buying credits without the website: a payment link for the human, then poll for the key.
export async function startPurchase(credits: number, key?: string) {
  const r = await window.ou.request({
    url: `${SITE}/api/agent/checkout`,
    method: "POST",
    auth: false,
    body: { credits, ...(key ? { key } : {}) },
  });
  const body = r.json as { payment_url: string; session_id: string; claim_token: string; error?: string };
  if (r.status !== 200) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
}

export async function pollPurchase(sessionId: string, claim: string) {
  // The claim token goes in the body of a GET-like call through the main process.
  const r = await window.ou.request({ url: `${SITE}/api/agent/checkout/${sessionId}`, auth: false, claim });
  return r.json as { status: string; api_key?: string | null; balance_cents?: number; error?: string };
}

// What a branched conversation tells the agent the first time: the conversation so far, compact,
// because the branch starts a new agent session that has not seen any of it. Newest turns are kept
// when it is long.
export function branchContext(turns: Turn[], maxChars = 40_000): string {
  const parts = turns.map((t) => {
    if (t.role === "user") return `User: ${t.text}`;
    const lines: string[] = [];
    for (const it of t.items ?? []) {
      if (it.kind === "message") lines.push(it.text);
      else if (it.kind === "command") lines.push(`[ran: ${it.command}${it.exitCode ? ` (exit ${it.exitCode})` : ""}]${it.output ? `\n${it.output.slice(-1500)}` : ""}`);
      else if (it.kind === "file") lines.push(`[edited files: ${it.summary}]`);
      else if (it.kind === "image") lines.push(`[generated image${it.files.length ? `: ${it.files.join(", ")}` : ""} with ${it.model}: ${it.prompt}]`);
      else if (it.kind === "error") lines.push(`[error: ${it.text}]`);
    }
    if (t.text) lines.push(t.text);
    return `You: ${lines.join("\n") || "(no reply)"}`;
  });
  let text = parts.join("\n\n");
  if (text.length > maxChars) text = "(earlier turns omitted)\n\n" + text.slice(text.length - maxChars);
  return (
    "This conversation was branched from an earlier one. Here is that conversation so far, for context. You are " +
    "in the same working folder, so files it created or changed may already exist.\n\n<conversation>\n" +
    text +
    "\n</conversation>\n\nThe user's new message:\n"
  );
}


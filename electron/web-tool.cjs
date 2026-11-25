// Web tool for the agent: a minimal MCP server (stdio, newline-delimited JSON-RPC) that the bundled
// Codex starts for every agent run, like image-tool.cjs (see codexHome() in main.cjs).
//
// web_search: POST /v1/search on the OpenUncensored API with the user's key (Brave results, about half a
//   cent per search from the user's credits). Added in 0.1.45 after a model with no way to search
//   invented "search results" for a customer (2026-11-25).
// read_page: fetches a page from this computer (free) and returns its readable text, not raw HTML,
//   so a page does not flood the agent's context.
//
// Run by the app's own Electron binary with ELECTRON_RUN_AS_NODE=1. Environment: OU_API_KEY, OU_API_BASE.
"use strict";

const readline = require("node:readline");

const API = process.env.OU_API_BASE || "https://api.openuncensored.com/v1";
const PAGE_MAX_BYTES = 5 * 1024 * 1024;
const PAGE_DEFAULT_CHARS = 20000;
const PAGE_MAX_CHARS = 60000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

const TOOLS = [
  {
    name: "web_search",
    description:
      "Search the web (results are not filtered by safe search). Returns titles, links, page ages and snippets. " +
      "Use it for anything current or that you cannot know from memory: news, prices, people, accounts, products, releases, docs. " +
      "Each search costs the user about half a cent from their OpenUncensored credits, so search with purpose, then use read_page on the best links. " +
      "Never present results you did not get from this tool.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query, in the language of the pages you want." },
        count: { type: "integer", minimum: 1, maximum: 20, description: "Number of results, 1 to 20. Default 8." },
        freshness: { type: "string", enum: ["day", "week", "month", "year"], description: "Only pages from the last day, week, month or year." },
      },
      required: ["query"],
    },
  },
  {
    name: "read_page",
    description:
      "Fetch a web page or text file by URL and return its readable text (scripts, styles and markup removed). Free. " +
      `Returns up to ${PAGE_DEFAULT_CHARS} characters by default; pass start to read further into a long page.`,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "An http or https URL." },
        start: { type: "integer", minimum: 0, description: "Character offset to start from, for long pages. Default 0." },
        max_chars: { type: "integer", minimum: 1000, maximum: PAGE_MAX_CHARS, description: `Characters to return. Default ${PAGE_DEFAULT_CHARS}.` },
      },
      required: ["url"],
    },
  },
];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const text = (t, extra = {}) => ({ content: [{ type: "text", text: t }], ...extra });

async function webSearch(args) {
  const key = process.env.OU_API_KEY;
  if (!key) return text("No OpenUncensored API key is set in the app, so web search is unavailable.", { isError: true });
  const query = String(args.query || "").trim();
  if (!query) return text("query is required.", { isError: true });
  const body = { query: query.slice(0, 400) };
  if (Number.isInteger(args.count)) body.count = Math.max(1, Math.min(20, args.count));
  if (["day", "week", "month", "year"].includes(args.freshness)) body.freshness = args.freshness;
  let data;
  try {
    const res = await fetch(`${API}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Title": "OpenUncensored Desktop", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
    data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  } catch (e) {
    return text(`Web search failed: ${e.message}. Tell the user the search did not work rather than guessing results.`, { isError: true });
  }
  const results = Array.isArray(data.results) ? data.results : [];
  if (!results.length) return text(`No web results for "${query}".`);
  const lines = results.map((r, i) => {
    const extra = (r.extra_snippets || []).filter((s) => s && s !== r.snippet).map((s) => `   ${s}`);
    return [`${i + 1}. ${r.title || r.url}`, `   ${r.url}`, r.age ? `   (${r.age})` : null, r.snippet ? `   ${r.snippet}` : null, ...extra]
      .filter(Boolean)
      .join("\n");
  });
  return text(`Web results for "${query}":\n\n${lines.join("\n\n")}`);
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...", copy: "(c)", reg: "(R)", trade: "(TM)" };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Readable text from HTML without a DOM: drop non-content elements, turn block ends into line breaks,
// keep link targets, strip the remaining tags.
function htmlToText(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|footer|form)\b[\s\S]*?<\/\1>/gi, " ");
  s = s
    .replace(/<h([1-6])[^>]*>/gi, (m, n) => "\n\n" + "#".repeat(Number(n)) + " ")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<a\b[^>]*href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      return label && /^https?:/i.test(href) ? `${label} (${href})` : label;
    })
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|tr|table|ul|ol|blockquote|pre|h[1-6])>/gi, "\n\n")
    .replace(/<\/(td|th)>/gi, "\t")
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s)
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return title ? `# ${decodeEntities(title.trim())}\n\n${s}` : s;
}

function charsetOf(contentType, head) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || "");
  if (fromHeader) return fromHeader[1];
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  return fromMeta ? fromMeta[1] : "utf-8";
}

async function readPage(args) {
  let url;
  try {
    url = new URL(String(args.url || ""));
  } catch {
    return text("url must be a full http or https address.", { isError: true });
  }
  if (!/^https?:$/.test(url.protocol)) return text("Only http and https pages can be read.", { isError: true });
  const start = Number.isInteger(args.start) && args.start > 0 ? args.start : 0;
  const maxChars = Number.isInteger(args.max_chars) ? Math.max(1000, Math.min(PAGE_MAX_CHARS, args.max_chars)) : PAGE_DEFAULT_CHARS;
  let res, buf;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5", "Accept-Language": "en,*;q=0.5" },
      redirect: "follow",
      signal: AbortSignal.timeout(25000),
    });
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      chunks.push(value);
      if (size > PAGE_MAX_BYTES) {
        await reader.cancel();
        break;
      }
    }
    buf = Buffer.concat(chunks);
  } catch (e) {
    return text(`Could not fetch ${url.href}: ${e.message}`, { isError: true });
  }
  const type = res.headers.get("content-type") || "";
  if (!res.ok) return text(`${url.href} answered HTTP ${res.status}.`, { isError: true });
  if (/pdf|image\/|audio\/|video\/|zip|octet-stream/i.test(type)) {
    return text(`${url.href} is not a text page (${type}). Download it with a shell command and open it with a suitable tool instead.`);
  }
  let raw;
  try {
    raw = new TextDecoder(charsetOf(type, buf.subarray(0, 4096).toString("latin1"))).decode(buf);
  } catch {
    raw = buf.toString("utf8");
  }
  const body = /html|xml/i.test(type) || /^\s*</.test(raw) ? htmlToText(raw) : raw;
  const slice = body.slice(start, start + maxChars);
  const more = start + maxChars < body.length ? `\n\n[${body.length - start - maxChars} more characters: call read_page again with start=${start + maxChars}]` : "";
  const final = res.url && res.url !== url.href ? ` (redirected to ${res.url})` : "";
  return text(`Page ${url.href}${final}, characters ${start} to ${start + slice.length} of ${body.length}:\n\n${slice}${more}`);
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "open-uncensored-web", version: "1.0.0" },
    });
  }
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    if (name === "web_search") return reply(id, await webSearch(args));
    if (name === "read_page") return reply(id, await readPage(args));
    return fail(id, -32602, `Unknown tool ${name}`);
  }
  if (method === "ping") return reply(id, {});
  if (id !== undefined && id !== null) return fail(id, -32601, `Method not found: ${method}`);
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  handle(msg).catch((e) => msg.id !== undefined && fail(msg.id, -32603, String(e && e.message ? e.message : e)));
});

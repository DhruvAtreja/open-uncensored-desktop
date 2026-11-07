// Image generation tool for the agent: a minimal MCP server (stdio, newline-delimited JSON-RPC)
// that the bundled Codex starts for every agent run (see codexHome() in main.cjs). It calls the
// Open Uncensored images API with the user's key and saves the pictures into the conversation's
// folder, returning their paths so the agent can use them and the app can show them.
//
// Run by the app's own Electron binary with ELECTRON_RUN_AS_NODE=1, so it needs no Node install.
// Environment: OU_API_KEY (the user's key), OU_IMAGE_DIR (the conversation's folder),
// OU_API_BASE (defaults to the public API).
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const API = process.env.OU_API_BASE || "https://openuncensored.com/api/v1";
const DEFAULT_MODEL = "z-image-turbo";
const SIZES = ["1024x1024", "1024x1536", "1536x1024", "1024x1792", "1792x1024", "512x512"];

const TOOLS = [
  {
    name: "generate_image",
    description:
      "Generate images from a text prompt with an uncensored image model (adult content allowed; nothing involving minors or real people without consent). " +
      "Saves the images as files in the working folder (or `directory`) and returns their paths. Each image is billed to the user's Open Uncensored credits, about $0.01 to $0.04. " +
      "Call list_image_models to see every model. Good picks: z-image-turbo (fast photoreal, default), lustify-v8 (explicit photo), " +
      "wai-illustrious (anime; start the prompt with 'masterpiece, best quality'), pony-diffusion-v6 (stylised; start with 'score_9, score_8_up, score_7_up'), chroma (strong prompt following).",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to draw. Be specific about subject, style, lighting and composition." },
        model: { type: "string", description: `Image model id. Default ${DEFAULT_MODEL}.` },
        size: { type: "string", enum: SIZES, description: "Image size. Default 1024x1024." },
        n: { type: "integer", minimum: 1, maximum: 4, description: "Number of images, 1 to 4. Default 1." },
        negative_prompt: { type: "string", description: "What to keep out of the image (used by the Civitai models)." },
        filename: { type: "string", description: "Base file name without extension. Default: derived from the prompt." },
        directory: { type: "string", description: "Absolute folder to save into. Default: the conversation's working folder." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "list_image_models",
    description: "List the available image models with their price per image and a one line description.",
    inputSchema: { type: "object", properties: {} },
  },
];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const text = (t, extra = {}) => ({ content: [{ type: "text", text: t }], ...extra });

function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "image"
  );
}

function extOf(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "webp";
  return "png";
}

async function api(pathname, init = {}) {
  const key = process.env.OU_API_KEY;
  const res = await fetch(API + pathname, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Title": "Open Uncensored Desktop",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(180000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  return body;
}

async function generateImage(args) {
  if (!process.env.OU_API_KEY) return text("No Open Uncensored API key is set in the app.", { isError: true });
  const prompt = String(args.prompt || "").trim();
  if (!prompt) return text("prompt is required.", { isError: true });
  const model = String(args.model || DEFAULT_MODEL);
  const n = Math.max(1, Math.min(4, Number(args.n) || 1));
  const dir = path.resolve(String(args.directory || process.env.OU_IMAGE_DIR || process.cwd()));
  const body = { model, prompt, n, response_format: "b64_json" };
  if (args.size && SIZES.includes(args.size)) body.size = args.size;
  if (args.negative_prompt) body.negative_prompt = String(args.negative_prompt);
  let data;
  try {
    data = await api("/images/generations", { method: "POST", body: JSON.stringify(body) });
  } catch (e) {
    return text(`Image generation failed: ${e.message}`, { isError: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  const base = slugify(args.filename || prompt);
  const d = new Date();
  const two = (x) => String(x).padStart(2, "0");
  const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
  const files = [];
  for (const [i, item] of (data.data || []).entries()) {
    if (!item.b64_json) continue;
    const buf = Buffer.from(item.b64_json, "base64");
    const file = path.join(dir, `${base}-${stamp}${n > 1 ? `-${i + 1}` : ""}.${extOf(buf)}`);
    fs.writeFileSync(file, buf);
    files.push(file);
  }
  if (!files.length) return text("The provider returned no image.", { isError: true });
  const cost = data.ou && typeof data.ou.cost_usd === "number" ? data.ou.cost_usd : null;
  const failed = data.ou && data.ou.images_failed ? ` ${data.ou.images_failed} more failed.` : "";
  return text(
    `Saved ${files.length} image${files.length > 1 ? "s" : ""} with ${model}${cost !== null ? ` (provider cost $${cost.toFixed(4)})` : ""}:\n${files.join("\n")}${failed}`,
    { structuredContent: { files, model, cost_usd: cost } },
  );
}

async function listModels() {
  try {
    const body = await api("/images/models");
    const lines = (body.data || []).map(
      (m) => `${m.id}: ${m.name}, about $${Number(m.price_per_image_usd).toFixed(4)} per image. ${m.description || ""}`,
    );
    return text(lines.join("\n") || "No image models are available right now.");
  } catch (e) {
    return text(`Could not list image models: ${e.message}`, { isError: true });
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "open-uncensored-images", version: "1.0.0" },
    });
  }
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    if (name === "generate_image") return reply(id, await generateImage(args));
    if (name === "list_image_models") return reply(id, await listModels());
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

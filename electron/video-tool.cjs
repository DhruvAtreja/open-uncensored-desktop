// Video generation tool for the agent: a minimal MCP server (stdio, newline-delimited JSON-RPC) that
// the bundled Codex starts for every agent run, like image-tool.cjs (see codexHome() in main.cjs).
// Image-to-video only: it animates one picture (a file on this computer) into a short clip through the
// OpenUncensored videos API with the user's key. Jobs are asynchronous on the API (create, poll,
// download), so one generate_video call creates the job, polls it every 5 s and saves the MP4 into the
// conversation's folder, returning its path so the agent can use it and the app can show it.
// A clip is charged only when it completes; a failed one costs nothing.
//
// Run by the app's own Electron binary with ELECTRON_RUN_AS_NODE=1, so it needs no Node install.
// Environment: OU_API_KEY (the user's key), OU_IMAGE_DIR (the conversation's folder),
// OU_API_BASE (defaults to the public API).
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { fileURLToPath } = require("node:url");

const API = process.env.OU_API_BASE || "https://api.openuncensored.com/v1";
const DEFAULT_MODEL = "minimax-h3-chili-image-to-video"; // cheapest, fastest and best at the prompt (tests, Nov 2026)
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // the API's image_too_large limit
const POLL_MS = 5000;
const GIVE_UP_MS = 10 * 60 * 1000; // inside Codex's tool_timeout_sec (900) with room for the upload and download

const TOOLS = [
  {
    name: "generate_video",
    description:
      "Animate one picture into a short video clip (image to video) with an uncensored video model (adult content allowed; nothing involving minors or real people without consent). " +
      "Needs a source picture: pass the path of an attached image or of one generate_image saved (make one first with generate_image if there is none). " +
      "The prompt says what happens in the clip: the motion, the action, the camera. " +
      "A clip takes about 1 to 4 minutes; this call waits for it and saves it as an MP4 in the working folder (or `directory`), returning its path. " +
      "Each clip is billed to the user's OpenUncensored credits, roughly $0.20 to $0.50, and only if it completes (a failed clip costs nothing), so make one clip unless the user asks for more. " +
      `The default model ${DEFAULT_MODEL} is the cheapest, the fastest and the best at following the prompt; call list_video_models to compare lengths, resolutions, audio and prices. ` +
      "If a call gives up waiting, call it again with the same arguments plus its video_id to fetch that clip instead of paying for a new one.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What happens in the clip: subject motion, action, camera movement, mood. Up to 4000 characters." },
        image: {
          type: "string",
          description: "Path of the picture to animate (PNG, JPEG or WebP, up to 20 MB); it becomes the first frame. Relative paths are in the working folder. A public https URL also works.",
        },
        model: { type: "string", description: `Video model id. Default ${DEFAULT_MODEL}.` },
        seconds: { type: "integer", description: "Clip length in seconds; must be one the model supports (see list_video_models). Default: the model's default (usually 5)." },
        resolution: { type: "string", description: "Resolution such as 720p or 480p; must be one the model supports. Default: the model's default." },
        filename: { type: "string", description: "Base file name without extension. Default: derived from the prompt." },
        directory: { type: "string", description: "Absolute folder to save into. Default: the conversation's working folder." },
        video_id: { type: "string", description: "Only to fetch a clip an earlier call gave up waiting for: its id (video_...). No new clip is made." },
      },
      required: ["prompt", "image"],
    },
  },
  {
    name: "list_video_models",
    description: "List the available video models with their clip lengths, resolutions, audio, price per clip and typical wait.",
    inputSchema: { type: "object", properties: {} },
  },
];

// Codex may close the pipe while a clip is still rendering (the user pressed Stop): the clip is already
// queued and will be charged when it completes, so the call carries on and still saves the file; only
// writes to the closed pipe are dropped instead of crashing the process.
process.stdout.on("error", () => {});
const send = (msg) => {
  try {
    process.stdout.write(JSON.stringify(msg) + "\n");
  } catch {}
};
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const text = (t, extra = {}) => ({ content: [{ type: "text", text: t }], ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "video"
  );
}

function imageMime(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "image/webp";
  return null;
}

// MP4 (and QuickTime) files carry "ftyp" at byte 4; WebM starts with the EBML magic.
function videoExt(buf) {
  if (buf.length > 12 && buf.slice(4, 8).toString() === "ftyp") return "mp4";
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "webm";
  return null;
}

function headers(extra = {}) {
  const key = process.env.OU_API_KEY;
  const install = process.env.OU_INSTALL_ID ? { "X-OU-Install": process.env.OU_INSTALL_ID } : {};
  return { "X-Title": "OpenUncensored Desktop", ...install, ...(key ? { Authorization: `Bearer ${key}` } : {}), ...extra };
}

async function api(pathname, init = {}, timeoutMs = 60000) {
  const res = await fetch(API + pathname, {
    ...init,
    headers: headers({ "Content-Type": "application/json", ...(init.headers || {}) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body?.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = body?.error?.code;
    throw err;
  }
  return body;
}

// GET /videos/{id}/content: the clip's bytes (JSON error body on failure).
async function download(id) {
  const res = await fetch(`${API}/videos/${encodeURIComponent(id)}/content`, { headers: headers(), signal: AbortSignal.timeout(180000) });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body?.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}

function stamp() {
  const d = new Date();
  const two = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

// The picture as the API takes it: a data URL read here (so the agent only names a file), or an https URL as is.
function readImage(image, workDir) {
  let ref = String(image || "").trim();
  if (/^https:\/\//i.test(ref)) return { url: ref };
  if (/^data:image\//i.test(ref)) return { url: ref };
  if (/^file:\/\//i.test(ref)) {
    try {
      ref = fileURLToPath(ref);
    } catch {}
  }
  const file = path.isAbsolute(ref) ? ref : path.join(workDir, ref);
  let buf;
  try {
    if (fs.statSync(file).size > MAX_IMAGE_BYTES) return { error: `${file} is larger than 20 MB.` };
    buf = fs.readFileSync(file);
  } catch {
    return { error: `Image not found: ${file}` };
  }
  const mime = imageMime(buf);
  if (!mime) return { error: `${file} is not a PNG, JPEG or WebP picture. Convert it to one of those first.` };
  return { url: `data:${mime};base64,${buf.toString("base64")}`, file };
}

async function generateVideo(args, progressToken) {
  if (!process.env.OU_API_KEY) return text("No OpenUncensored API key is set in the app.", { isError: true });
  const prompt = String(args.prompt || "").trim();
  const workDir = path.resolve(String(process.env.OU_IMAGE_DIR || process.cwd()));
  const dir = path.resolve(String(args.directory || workDir));
  const model = String(args.model || DEFAULT_MODEL);
  let reported = -1;
  const progress = (value, message) => {
    // MCP progress notifications, only when the client asked for them, and only ever increasing.
    if (progressToken === undefined || progressToken === null || value <= reported) return;
    reported = value;
    send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: value, total: 100, message } });
  };

  let video;
  if (args.video_id) {
    try {
      video = await api(`/videos/${encodeURIComponent(String(args.video_id))}`);
    } catch (e) {
      return text(`Could not find video ${args.video_id}: ${e.message}`, { isError: true });
    }
  } else {
    if (!prompt) return text("prompt is required.", { isError: true });
    if (!args.image) return text("image is required: the path of the picture to animate. Make one with generate_image first if there is none.", { isError: true });
    const img = readImage(args.image, workDir);
    if (img.error) return text(img.error, { isError: true });
    const body = { model, prompt, image: img.url };
    if (args.seconds !== undefined && args.seconds !== null && args.seconds !== "") body.seconds = args.seconds;
    if (args.resolution) body.resolution = String(args.resolution);
    try {
      // The picture travels in the request (up to 20 MB, more as base64): give the upload time.
      video = await api("/videos", { method: "POST", body: JSON.stringify(body) }, 180000);
    } catch (e) {
      return text(`Video generation failed: ${e.message}`, { isError: true });
    }
  }
  const id = String(video.id || args.video_id || "");
  if (!id) return text("The API returned no video id.", { isError: true });
  progress(0, "Queued");

  // Poll until it is done. Network errors and router restarts (5xx, about 40 s per deploy) are waited
  // out; only answers that will not change (the video is gone, the key is refused) stop early.
  const started = Date.now();
  let lastError = "";
  while (video.status !== "completed" && video.status !== "failed") {
    if (Date.now() - started > GIVE_UP_MS) {
      return text(
        `Gave up waiting after 10 minutes: video ${id} is still ${video.status || "pending"}${lastError ? ` (last error: ${lastError})` : ""}. ` +
          `It is charged only if it completes. To fetch it later, call generate_video again with video_id "${id}".`,
        { isError: true, structuredContent: { files: [], model: video.model || model, cost_usd: null, video_id: id } },
      );
    }
    await sleep(POLL_MS);
    try {
      video = await api(`/videos/${encodeURIComponent(id)}`, {}, 30000);
      lastError = "";
      const p = Number(video.progress);
      if (Number.isFinite(p)) progress(Math.min(99, Math.max(0, Math.round(p))), video.status === "queued" ? "Queued" : "Rendering");
    } catch (e) {
      if ([401, 403, 404, 410].includes(e.status)) return text(`Video ${id} failed: ${e.message}`, { isError: true });
      lastError = e.message;
    }
  }
  const used = String(video.model || model);
  if (video.status === "failed") {
    const why = String((video.error && (video.error.message || video.error.code)) || "the provider gave no reason").replace(/[.\s]+$/, "");
    return text(`Video ${id} failed with ${used}: ${why}. A failed clip is not charged.`, {
      isError: true,
      structuredContent: { files: [], model: used, cost_usd: 0, video_id: id },
    });
  }

  // Completed: download it. The content can lag the status for a moment (409 video_not_ready), so retry briefly.
  let buf;
  for (let attempt = 1; ; attempt++) {
    try {
      buf = await download(id);
      break;
    } catch (e) {
      if (attempt >= 4 || [401, 403, 404, 410].includes(e.status)) {
        return text(`Video ${id} completed but could not be downloaded: ${e.message}. Try generate_video again with video_id "${id}".`, {
          isError: true,
          structuredContent: { files: [], model: used, cost_usd: null, video_id: id },
        });
      }
      await sleep(3000);
    }
  }
  const ext = videoExt(buf);
  if (!ext) return text(`Video ${id}: the download was not a video file (${buf.length} bytes).`, { isError: true });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slugify(args.filename || prompt || id)}-${stamp()}.${ext}`);
  fs.writeFileSync(file, buf);
  progress(100, "Saved");
  const cost = video.ou && typeof video.ou.price_usd === "number" ? video.ou.price_usd : null;
  const details = [video.seconds ? `${video.seconds} s` : "", video.size || "", video.ou && video.ou.audio ? "with audio" : ""].filter(Boolean).join(", ");
  return text(`Saved a video${details ? ` (${details})` : ""} with ${used}${cost !== null ? ` (cost $${cost.toFixed(4)})` : ""}:\n${file}`, {
    structuredContent: { files: [file], model: used, cost_usd: cost, video_id: id },
  });
}

async function listModels() {
  try {
    const body = await api("/videos/models");
    const lines = (body.data || []).map((m) => {
      const secs = Array.isArray(m.seconds) && m.seconds.length ? m.seconds : [];
      const range = secs.length > 2 && secs[secs.length - 1] - secs[0] === secs.length - 1 ? `${secs[0]} to ${secs[secs.length - 1]}` : secs.join(" or ");
      const length = range ? `${range} s (default ${m.default_seconds ?? secs[0]})` : "";
      const res = Array.isArray(m.resolutions) && m.resolutions.length ? `resolutions ${m.resolutions.join(", ")} (default ${m.default_resolution || m.resolutions[0]})` : "";
      const price = typeof m.price_per_clip_usd === "number" ? `about $${m.price_per_clip_usd.toFixed(2)} per clip at the default length and resolution` : "";
      const wait = Array.isArray(m.typical_wait_s) && m.typical_wait_s.length === 2 ? `typical wait ${m.typical_wait_s[0]} to ${m.typical_wait_s[1]} s` : "";
      const parts = [length, res, m.audio ? "with audio" : "no audio", price, wait].filter(Boolean).join(", ");
      return `${m.id}: ${m.name || m.id}, ${parts}. ${m.description || ""}`.trim();
    });
    return text(lines.join("\n") || "No video models are available right now.");
  } catch (e) {
    return text(`Could not list video models: ${e.message}`, { isError: true });
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "open-uncensored-videos", version: "1.0.0" },
    });
  }
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const progressToken = params && params._meta ? params._meta.progressToken : undefined;
    if (name === "generate_video") return reply(id, await generateVideo(args, progressToken));
    if (name === "list_video_models") return reply(id, await listModels());
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

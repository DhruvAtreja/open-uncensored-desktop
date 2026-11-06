// Electron main process: the window, the API key (encrypted with the OS keychain), saved
// conversations, and the coding agent, which is the open source Codex CLI pointed at the
// Open Uncensored API (it speaks the Responses API, which the router serves at /v1/responses).
const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const updater = require("./updater.cjs");

const API = "https://openuncensored.com/api/v1";
const data = (...p) => path.join(app.getPath("userData"), ...p);

// ---------------------------------------------------------------------------- key

function readKey() {
  if (!app.isPackaged && process.env.OU_DEV_KEY) return process.env.OU_DEV_KEY; // development only
  try {
    const raw = fs.readFileSync(data("key.bin"));
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString("utf8");
  } catch {
    return null;
  }
}

function writeKey(key) {
  if (!key) {
    fs.rmSync(data("key.bin"), { force: true });
    return;
  }
  const raw = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key) : Buffer.from(key, "utf8");
  fs.writeFileSync(data("key.bin"), raw, { mode: 0o600 });
}

// ---------------------------------------------------------------------------- usage events
// A random install id (no name, email, key or prompts) and a handful of events: installed, opened,
// a key added, an agent task started. They show how many downloads become users; the website's
// privacy page lists them. Development builds send nothing.

let installIdCache = null;
let freshInstall = false;

function installId() {
  if (installIdCache) return installIdCache;
  try {
    installIdCache = fs.readFileSync(data("install-id"), "utf8").trim();
  } catch {}
  if (!installIdCache) {
    installIdCache = require("node:crypto").randomUUID();
    freshInstall = true;
    try {
      fs.writeFileSync(data("install-id"), installIdCache);
    } catch {}
  }
  return installIdCache;
}

function appEvent(event, props = {}) {
  if (!app.isPackaged) return;
  fetch("https://openuncensored.com/api/e", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Title": "Open Uncensored Desktop" },
    body: JSON.stringify({ event, vid: installId(), ref: "desktop-app", props: { version: app.getVersion(), ...props } }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

// ---------------------------------------------------------------------------- conversations

function readConversations() {
  try {
    return JSON.parse(fs.readFileSync(data("conversations.json"), "utf8"));
  } catch {
    return [];
  }
}

function writeConversations(list) {
  fs.writeFileSync(data("conversations.json"), JSON.stringify(list));
}

// ---------------------------------------------------------------------------- agent (Codex)

function codexBinary() {
  const arch = process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  const pkg = process.arch === "arm64" ? "codex-darwin-arm64" : "codex-darwin-x64";
  const base = app.isPackaged
    ? path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", "@openai", pkg, "vendor", arch)
    : path.join(__dirname, "..", "node_modules", "@openai", pkg, "vendor", arch);
  return { bin: path.join(base, "bin", "codex"), toolsDir: path.join(base, "codex-path") };
}

// A private Codex home, so the app never touches the user's own ~/.codex setup. Our own system
// prompt (agent-prompt.md) replaces Codex's, and Codex's extras (skills, including the user's
// personal ones, memories, goals, sub-agents, apps, OpenAI-hosted tools) are switched off.
function codexHome() {
  const home = data("codex");
  fs.mkdirSync(home, { recursive: true });
  const prompt = path.join(home, "agent-prompt.md");
  fs.writeFileSync(prompt, fs.readFileSync(path.join(__dirname, "agent-prompt.md"), "utf8"));
  fs.writeFileSync(
    path.join(home, "config.toml"),
    [
      'model_provider = "openuncensored"',
      'approval_policy = "never"',
      // Full access: the agent starts in the conversation's folder but can read, edit and run
      // anything the user's account can, network included (the user's choice for this app).
      'sandbox_mode = "danger-full-access"',
      `model_instructions_file = ${JSON.stringify(prompt)}`,
      "include_permissions_instructions = false",
      "",
      "[skills]",
      "include_instructions = false",
      "",
      "[features]",
      "apps = false",
      "goals = false",
      "memories = false",
      "multi_agent = false",
      "image_generation = false",
      "standalone_web_search = false",
      "request_permissions_tool = false",
      "",
      "[tools.experimental_request_user_input]",
      "enabled = false",
      "",
      "[model_providers.openuncensored]",
      'name = "Open Uncensored"',
      `base_url = "${API}"`,
      'env_key = "OU_API_KEY"',
      'wire_api = "responses"',
      // Names the app in the request log, so agent traffic from here is told apart from other Codex users.
      'http_headers = { "X-Title" = "Open Uncensored Desktop" }',
      "",
    ].join("\n"),
  );
  return home;
}

const runs = new Map(); // runId -> child process

function startAgent(win, { runId, threadId, prompt, cwd, model }) {
  const key = readKey();
  if (!key) return { error: "Add an API key first." };
  const { bin, toolsDir } = codexBinary();
  const args = ["exec", "--json", "--skip-git-repo-check", "-m", model, "-C", cwd];
  if (threadId) args.push("resume", threadId, prompt);
  else args.push(prompt);
  const child = spawn(bin, args, {
    cwd,
    env: { ...process.env, OU_API_KEY: key, CODEX_HOME: codexHome(), PATH: `${toolsDir}:${process.env.PATH}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  runs.set(runId, child);
  if (!threadId) appEvent("app_agent_run", { model });
  const send = (event) => !win.isDestroyed() && win.webContents.send("agent:event", { runId, event });
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      send(JSON.parse(line));
    } catch {
      /* not an event line */
    }
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
  child.on("close", (code) => {
    runs.delete(runId);
    send({ type: "run.exited", code, stderr: code ? stderr : "" });
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------- network
// All HTTP happens here, in the main process: no CORS limits, and the page never holds the key.

async function request({ url, method = "GET", body, auth = true, claim }) {
  if (!url.startsWith("https://openuncensored.com/")) return { status: 0, json: { error: "blocked" } };
  const key = readKey();
  const headers = { "Content-Type": "application/json", "X-Title": "Open Uncensored Desktop", "X-OU-Install": installId() };
  if (auth && key) headers.Authorization = `Bearer ${key}`;
  if (claim) headers.Authorization = `Bearer ${claim}`; // agent checkout polling
  try {
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, json: { error: { message: String(e.message || e) } } };
  }
}

const streams = new Map(); // streamId -> AbortController

async function chatStream(win, { streamId, model, messages }) {
  const send = (event) => !win.isDestroyed() && win.webContents.send("chat:event", { streamId, ...event });
  const key = readKey();
  if (!key) return send({ type: "error", message: "Add an API key first." });
  const ctrl = new AbortController();
  streams.set(streamId, ctrl);
  try {
    const res = await fetch(`${API}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "Open Uncensored Desktop" },
      body: JSON.stringify({ model, messages, stream: true }),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}));
      return send({ type: "error", status: res.status, message: body?.error?.message ?? `HTTP ${res.status}` });
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let cut;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let data;
          try {
            data = JSON.parse(payload);
          } catch {
            continue;
          }
          if (data.error) return send({ type: "error", message: data.error.message ?? "Stream error" });
          const delta = data.choices?.[0]?.delta ?? {};
          const reasoning = delta.reasoning_content ?? delta.reasoning;
          if (reasoning) send({ type: "reasoning", text: reasoning });
          if (delta.content) send({ type: "delta", text: delta.content });
        }
      }
    }
    send({ type: "done", model: res.headers.get("x-ou-model") });
  } catch (e) {
    send(ctrl.signal.aborted ? { type: "done", stopped: true } : { type: "error", message: String(e.message || e) });
  } finally {
    streams.delete(streamId);
  }
}

// ---------------------------------------------------------------------------- window

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: "#181818",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Links in model output open in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://") && !url.startsWith("http://localhost")) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });
  if (!app.isPackaged && process.env.OU_DEV_DRIVE) {
    win.webContents.once("did-finish-load", () => require("./devdrive.cjs")(win, process.env.OU_DEV_DRIVE));
  }
  if (process.env.OU_DEV_URL) win.loadURL(process.env.OU_DEV_URL);
  else win.loadFile(path.join(__dirname, "..", "dist", "index.html"));

  ipcMain.handle("key:get", () => readKey());
  ipcMain.handle("key:set", (_e, key) => {
    writeKey(key);
    if (key) appEvent("app_key");
  });
  ipcMain.handle("conversations:get", () => readConversations());
  ipcMain.handle("conversations:set", (_e, list) => writeConversations(list));
  ipcMain.handle("folder:pick", async () => {
    if (!app.isPackaged && process.env.OU_DEV_FOLDER) return process.env.OU_DEV_FOLDER; // development only
    const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle("files:pick", async () => {
    const r = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"] });
    return r.canceled ? [] : r.filePaths;
  });
  // Conversations without a project work in ~/Open Uncensored.
  ipcMain.handle("folder:default", () => {
    const dir = path.join(app.getPath("home"), "Open Uncensored");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  });
  ipcMain.handle("open:url", (_e, url) => /^https:\/\//.test(url) && shell.openExternal(url));
  ipcMain.handle("net:request", (_e, opts) => request(opts));
  ipcMain.handle("chat:start", (_e, opts) => {
    chatStream(win, opts);
    return true;
  });
  ipcMain.handle("chat:stop", (_e, streamId) => {
    streams.get(streamId)?.abort();
    return true;
  });
  ipcMain.handle("update:get", () => ({ ...updater.getState(), current: app.getVersion() }));
  ipcMain.handle("update:check", () => updater.checkNow());
  ipcMain.handle("update:install", () => {
    for (const child of runs.values()) child.kill("SIGINT"); // agent tasks stop; they resume from the conversation
    return updater.install();
  });
  updater.onChange((s) => !win.isDestroyed() && win.webContents.send("update:state", { ...s, current: app.getVersion() }));
  ipcMain.handle("agent:start", (_e, opts) => startAgent(win, opts));
  ipcMain.handle("agent:stop", (_e, runId) => {
    runs.get(runId)?.kill("SIGINT");
    return true;
  });
}

app.whenReady().then(() => {
  createWindow();
  installId();
  if (freshInstall) appEvent("app_install");
  appEvent("app_launch");
  updater.start();
});
app.on("window-all-closed", () => {
  for (const child of runs.values()) child.kill("SIGINT");
  app.quit();
});

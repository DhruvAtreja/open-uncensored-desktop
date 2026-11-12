// Electron main process: the window, the API key (a user-only file in the data folder), saved
// conversations, and the coding agent, which is the open source Codex CLI pointed at the
// OpenUncensored API (it speaks the Responses API, which the router serves at /v1/responses).
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, safeStorage, shell } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const updater = require("./updater.cjs");

// The app was called "Open Uncensored" until 0.1.8. Electron names the data folder and the
// Keychain entry that encrypts the saved key ("<name> Safe Storage") after app.name, so it
// keeps the old name internally: renaming it would lose every user's key and conversations.
// Everything the user sees says OpenUncensored (bundle name, menus, About panel, window).
const DISPLAY_NAME = "OpenUncensored";
app.setName("Open Uncensored");
app.setAboutPanelOptions({ applicationName: DISPLAY_NAME });

const API = "https://openuncensored.com/api/v1";
const data = (...p) => path.join(app.getPath("userData"), ...p);

// ---------------------------------------------------------------------------- key

// The key lives in a file only this user can read (mode 0600 in the app's data folder), the way
// CLI tools keep API keys. Up to 0.1.8 it was encrypted with the macOS Keychain, but the app is
// not signed with a stable Developer ID, so every update looked like a new app and macOS asked
// for the login password again. A key saved by an older version (key.bin) is decrypted once,
// which is the last Keychain prompt, moved to the plain file, and the old file removed.
const KEY_FILE = "api-key";
const LEGACY_KEY_FILE = "key.bin";
let keyCache;

function saveKeyFile(key) {
  const file = data(KEY_FILE);
  fs.writeFileSync(file, key, { mode: 0o600 });
  fs.chmodSync(file, 0o600); // writeFileSync keeps the mode of a file that already exists
}

function readKey() {
  if (!app.isPackaged && process.env.OU_DEV_KEY) return process.env.OU_DEV_KEY; // development only
  if (keyCache !== undefined) return keyCache;
  try {
    keyCache = fs.readFileSync(data(KEY_FILE), "utf8").trim() || null;
    return keyCache;
  } catch {}
  try {
    const raw = fs.readFileSync(data(LEGACY_KEY_FILE));
    const key = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString("utf8");
    if (key) {
      saveKeyFile(key);
      fs.rmSync(data(LEGACY_KEY_FILE), { force: true });
    }
    keyCache = key || null;
  } catch {
    keyCache = null; // no key yet, or the user declined the one-time Keychain prompt
  }
  return keyCache;
}

function writeKey(key) {
  keyCache = key || null;
  fs.rmSync(data(LEGACY_KEY_FILE), { force: true });
  if (!key) {
    fs.rmSync(data(KEY_FILE), { force: true });
    return;
  }
  saveKeyFile(key);
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
    headers: { "Content-Type": "application/json", "X-Title": "OpenUncensored Desktop" },
    body: JSON.stringify({ event, vid: installId(), ref: "desktop-app", props: { version: app.getVersion(), platform: process.platform, ...props } }),
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

const IS_WIN = process.platform === "win32";

// The Codex CLI for this platform, from the matching @openai/codex-<os>-<arch> package (npm installs
// only the one for the machine that builds the app, so each platform's build carries its own).
function codexBinary() {
  const arm = process.arch === "arm64";
  const [pkg, triple] = IS_WIN
    ? [arm ? "codex-win32-arm64" : "codex-win32-x64", arm ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc"]
    : [arm ? "codex-darwin-arm64" : "codex-darwin-x64", arm ? "aarch64-apple-darwin" : "x86_64-apple-darwin"];
  const base = app.isPackaged
    ? path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", "@openai", pkg, "vendor", triple)
    : path.join(__dirname, "..", "node_modules", "@openai", pkg, "vendor", triple);
  return { bin: path.join(base, "bin", IS_WIN ? "codex.exe" : "codex"), toolsDir: path.join(base, "codex-path") };
}

// The image generation tool (image-tool.cjs), an MCP server the agent can call. It runs on the app's
// own Electron binary in Node mode; packaged, it sits unpacked next to app.asar (see asarUnpack).
function imageToolPath() {
  return path.join(__dirname, "image-tool.cjs").replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

// A private Codex home, so the app never touches the user's own ~/.codex setup. Our own system
// prompt (agent-prompt.md) replaces Codex's, and Codex's extras (skills, including the user's
// personal ones, memories, goals, sub-agents, apps, OpenAI-hosted tools) are switched off.
function codexHome() {
  const home = data("codex");
  fs.mkdirSync(home, { recursive: true });
  const prompt = path.join(home, "agent-prompt.md");
  // On Windows, Codex runs commands in PowerShell; say so up front, or models reach for bash
  // syntax (heredocs, cat > file) first and only switch after a failed command.
  const windowsNote = IS_WIN
    ? "\n\n# This computer\n\nThe user is on Windows. Your shell commands run in PowerShell, not bash: use PowerShell syntax " +
      "(Set-Content, Get-ChildItem, here-strings @' '@), and Windows paths. Do not use bash heredocs (<<EOF), cat > file or && chains " +
      "that PowerShell 5 rejects; to write a file, pipe a here-string to Set-Content (@'...'@ | Set-Content -Path f -Encoding utf8).\n"
    : "";
  fs.writeFileSync(prompt, fs.readFileSync(path.join(__dirname, "agent-prompt.md"), "utf8") + windowsNote);
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
      // Our models read text only: an image the agent opens would reach them as base64 text.
      "view_image = false",
      "standalone_web_search = false",
      "request_permissions_tool = false",
      "",
      "[tools.experimental_request_user_input]",
      "enabled = false",
      "",
      "[model_providers.openuncensored]",
      'name = "OpenUncensored"',
      `base_url = "${API}"`,
      'env_key = "OU_API_KEY"',
      'wire_api = "responses"',
      // Names the app in the request log, so agent traffic from here is told apart from other Codex users.
      'http_headers = { "X-Title" = "OpenUncensored Desktop" }',
      "",
      // generate_image / list_image_models: pictures from the uncensored image models, saved into
      // the conversation's folder (OU_IMAGE_DIR) and billed to the same key.
      "[mcp_servers.images]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(imageToolPath())}]`,
      'env = { ELECTRON_RUN_AS_NODE = "1" }',
      'env_vars = ["OU_API_KEY", "OU_IMAGE_DIR"]',
      "startup_timeout_sec = 20",
      "tool_timeout_sec = 300",
      "",
    ].join("\n"),
  );
  return home;
}

const runs = new Map(); // runId -> child process

// Each model's context window, from the public model list. Codex has no metadata for our models,
// so without this it guesses a window and compacts the conversation too late (or never).
let contextWindows = null;
async function contextWindow(model) {
  if (!contextWindows) {
    try {
      const res = await fetch(`${API}/models`, { headers: { "X-Title": "OpenUncensored Desktop" }, signal: AbortSignal.timeout(5000) });
      const body = await res.json();
      contextWindows = Object.fromEntries((body.data || []).map((m) => [m.id, m.context_length]));
    } catch {
      return null; // try again next run
    }
  }
  return contextWindows[model] || null;
}

async function startAgent(win, { runId, threadId, prompt, cwd, model }) {
  const key = readKey();
  if (!key) return { error: "Add an API key first." };
  const { bin, toolsDir } = codexBinary();
  const args = ["exec", "--json", "--skip-git-repo-check", "-m", model, "-C", cwd];
  const window = await contextWindow(model);
  if (window) {
    // Compact at 80% of the window, and by 250K tokens at most so long sessions stay cheap.
    const compactAt = Math.min(Math.floor(window * 0.8), 250000);
    args.push("-c", `model_context_window=${window}`, "-c", `model_auto_compact_token_limit=${compactAt}`);
  }
  if (threadId) args.push("resume", threadId, prompt);
  else args.push(prompt);
  const child = spawn(bin, args, {
    cwd,
    env: { ...process.env, OU_API_KEY: key, OU_IMAGE_DIR: cwd, CODEX_HOME: codexHome(), PATH: `${toolsDir}${path.delimiter}${process.env.PATH}` },
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
  const headers = { "Content-Type": "application/json", "X-Title": "OpenUncensored Desktop", "X-OU-Install": installId() };
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
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "OpenUncensored Desktop" },
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

let mainWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: "#181818",
    // Mac: traffic lights inset into the app's own 52px header. Windows: the native minimize,
    // maximize and close buttons drawn over the right end of that header (the page leaves room).
    ...(IS_WIN
      ? { titleBarStyle: "hidden", titleBarOverlay: { color: "#181818", symbolColor: "#b8b8b8", height: 52 } }
      : { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 18 } }),
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
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

// The window that sent an IPC message (a closed window is reopened from the Dock as a new one, so
// handlers never hold on to a particular window).
const senderWindow = (e) => BrowserWindow.fromWebContents(e.sender);
const openDialog = (e, properties) => {
  const owner = senderWindow(e);
  return owner ? dialog.showOpenDialog(owner, { properties }) : dialog.showOpenDialog({ properties });
};

// Registered once at startup: Electron refuses a second handler for the same channel.
function registerIpc() {
  ipcMain.handle("key:get", () => readKey());
  ipcMain.handle("key:set", (_e, key) => {
    writeKey(key);
    if (key) appEvent("app_key");
  });
  ipcMain.handle("conversations:get", () => readConversations());
  ipcMain.handle("conversations:set", (_e, list) => writeConversations(list));
  ipcMain.handle("folder:pick", async (e) => {
    if (!app.isPackaged && process.env.OU_DEV_FOLDER) return process.env.OU_DEV_FOLDER; // development only
    const r = await openDialog(e, ["openDirectory", "createDirectory"]);
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle("files:pick", async (e) => {
    const r = await openDialog(e, ["openFile", "multiSelections"]);
    return r.canceled ? [] : r.filePaths;
  });
  // Conversations without a project work in ~/OpenUncensored (~/Open Uncensored before 0.1.8,
  // moved over once; if it cannot be moved the old folder keeps being used).
  ipcMain.handle("folder:default", () => {
    const dir = path.join(app.getPath("home"), "OpenUncensored");
    const old = path.join(app.getPath("home"), "Open Uncensored");
    if (!fs.existsSync(dir) && fs.existsSync(old)) {
      try {
        fs.renameSync(old, dir);
      } catch {
        return old;
      }
    }
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  });
  ipcMain.handle("open:url", (_e, url) => /^https:\/\//.test(url) && shell.openExternal(url));
  // Pictures the image tool saved, shown inline in the chat and opened in the default image viewer on click.
  // Only image files, so the page cannot read or open anything else through these.
  const isImage = (p) => typeof p === "string" && path.isAbsolute(p) && /\.(png|jpe?g|webp)$/i.test(p);
  ipcMain.handle("image:read", (_e, file) => {
    if (!isImage(file)) return null;
    try {
      if (fs.statSync(file).size > 25 * 1024 * 1024) return null;
      const ext = path.extname(file).slice(1).toLowerCase().replace("jpg", "jpeg");
      return `data:image/${ext};base64,${fs.readFileSync(file).toString("base64")}`;
    } catch {
      return null;
    }
  });
  ipcMain.handle("image:open", (_e, file) => isImage(file) && fs.existsSync(file) && shell.openPath(file));
  // An attached file's chip: shows the file in Finder / Explorer (never opens or runs it).
  ipcMain.handle("file:show", (_e, file) => typeof file === "string" && path.isAbsolute(file) && fs.existsSync(file) && shell.showItemInFolder(file));
  // An image pasted into the message box: saved to a temp folder, and its path goes in the message
  // (<image_attached>path</image_attached>) for the agent to open. PNG, JPEG and WebP are kept as
  // they are; anything else the clipboard holds (TIFF, BMP, GIF) is converted to PNG.
  ipcMain.handle("image:paste", (_e, { bytes, type }) => {
    try {
      let buf = Buffer.from(bytes);
      if (!buf.length || buf.length > 20 * 1024 * 1024) return null;
      let ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[type];
      if (!ext) {
        const img = nativeImage.createFromBuffer(buf);
        if (img.isEmpty()) return null;
        buf = img.toPNG();
        ext = "png";
      }
      const dir = path.join(os.tmpdir(), "OpenUncensored", "pasted");
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const file = path.join(dir, `pasted-${stamp}-${crypto.randomBytes(3).toString("hex")}.${ext}`);
      fs.writeFileSync(file, buf);
      return file;
    } catch {
      return null;
    }
  });
  ipcMain.handle("net:request", (_e, opts) => request(opts));
  ipcMain.handle("chat:start", (_e, opts) => {
    chatStream(senderWindow(_e), opts);
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
  updater.onChange((s) => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send("update:state", { ...s, current: app.getVersion() }));
  ipcMain.handle("agent:start", (_e, opts) => startAgent(senderWindow(_e), opts));
  ipcMain.handle("agent:stop", (_e, runId) => {
    runs.get(runId)?.kill("SIGINT");
    return true;
  });
}

// Electron's default menu takes its labels from app.name, which stays "Open Uncensored" (above).
function setMenu() {
  // Windows: no menu bar (the title bar is the app's own header). Text editing shortcuts work without it.
  if (IS_WIN) return Menu.setApplicationMenu(null);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: DISPLAY_NAME,
        submenu: [
          { role: "about", label: `About ${DISPLAY_NAME}` },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide", label: `Hide ${DISPLAY_NAME}` },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit", label: `Quit ${DISPLAY_NAME}` },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

app.whenReady().then(() => {
  setMenu();
  registerIpc();
  createWindow();
  installId();
  if (freshInstall) appEvent("app_install");
  appEvent("app_launch");
  updater.start();
});
// Agent tasks and chat streams report to the window that started them, so they stop when it closes
// (the conversation keeps what was done; sending again carries on) and when the app quits.
function stopWork() {
  for (const child of runs.values()) child.kill("SIGINT");
  for (const ctrl of streams.values()) ctrl.abort();
}
// Mac: closing the window leaves the app running in the Dock, like other Mac apps; clicking the
// Dock icon opens a new window. Windows: closing the window quits.
app.on("window-all-closed", () => {
  stopWork();
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (app.isReady() && BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on("before-quit", stopWork);

// Self-updates from the GitHub releases of this app, the way Claude's desktop app does: a new
// version downloads in the background and the sidebar offers "Relaunch to update".
//
// Electron's built-in updater (Squirrel.Mac) only accepts apps signed with an Apple Developer ID,
// and this app is ad-hoc signed, so the swap is done here instead:
//   1. every 4 hours (and at launch) read the latest release; if its version is newer, download its
//      "-mac-<arch>.zip", check the size and SHA-256 GitHub publishes, unpack it with ditto and check
//      the new app's code signature is intact;
//   2. on "Relaunch to update", a small detached shell script waits for this process to exit,
//      replaces the app bundle (keeping the old one until the new one is in place), clears the
//      quarantine flag and opens the new version.
// Development builds and copies running from a DMG or a translocated path never update themselves.
//
// Windows: the release's "-win-<arch>.exe" installer (per-user NSIS, no admin) is downloaded and
// checked the same way, then run silently with --force-run, which replaces the app and reopens it.
// A download made by the app itself carries no "from the internet" mark, so SmartScreen does not
// stop it the way it stops a browser download of the same unsigned installer.
const { app } = require("electron");
const { execFile, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");

const REPO = "DhruvAtreja/open-uncensored-desktop";
const FEED = process.env.OU_UPDATE_FEED || `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

let state = { status: "idle" }; // idle | checking | downloading | ready | error
let listeners = [];
let checking = null;

const set = (next) => {
  state = next;
  for (const fn of listeners) fn(state);
};

const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 1 << 20 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))),
  );

function newer(a, b) {
  const pa = String(a).replace(/^v/, "").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, "").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

// /Applications/OpenUncensored.app, from .../OpenUncensored.app/Contents/MacOS/OpenUncensored
function currentBundle() {
  const exe = app.getPath("exe");
  const i = exe.indexOf(".app/Contents/MacOS/");
  return i < 0 ? null : exe.slice(0, i + 4);
}

const IS_WIN = process.platform === "win32";

function canSelfUpdate() {
  if (IS_WIN) {
    // Only the installed app (under %LOCALAPPDATA%\Programs), never a portable or unpacked copy.
    return app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR && /\\Programs\\/i.test(app.getPath("exe"));
  }
  const bundle = currentBundle();
  if (!app.isPackaged || process.platform !== "darwin" || !bundle) return false;
  if (bundle.startsWith("/Volumes/") || bundle.includes("/AppTranslocation/")) return false;
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function check() {
  if (!canSelfUpdate() || state.status === "downloading" || state.status === "ready") return;
  set({ status: "checking" });
  try {
    const res = await fetch(FEED, { headers: { Accept: "application/vnd.github+json", "User-Agent": "open-uncensored-desktop" } });
    if (!res.ok) throw new Error(`release feed: HTTP ${res.status}`);
    const release = await res.json();
    const version = String(release.tag_name || "").replace(/^v/, "");
    if (!version || !newer(version, app.getVersion())) return set({ status: "idle" });
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const suffix = IS_WIN ? `-win-${arch}.exe` : `-mac-${arch}.zip`;
    const asset = (release.assets || []).find((a) => a.name.endsWith(suffix));
    if (!asset) return set({ status: "idle" });

    const dir = path.join(app.getPath("userData"), "update");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const zip = path.join(dir, asset.name);
    set({ status: "downloading", version });
    const dl = await fetch(asset.browser_download_url, { headers: { "User-Agent": "open-uncensored-desktop" } });
    if (!dl.ok || !dl.body) throw new Error(`download: HTTP ${dl.status}`);
    await pipeline(Readable.fromWeb(dl.body), fs.createWriteStream(zip));

    if (asset.size && fs.statSync(zip).size !== asset.size) throw new Error("download is incomplete");
    const want = typeof asset.digest === "string" && asset.digest.startsWith("sha256:") ? asset.digest.slice(7) : null;
    if (want) {
      const hash = crypto.createHash("sha256");
      await pipeline(fs.createReadStream(zip), hash);
      if (hash.digest("hex") !== want) throw new Error("download does not match the published checksum");
    }

    if (IS_WIN) return set({ status: "ready", version, app: zip }); // the installer itself

    const out = path.join(dir, "app");
    await run("/usr/bin/ditto", ["-x", "-k", zip, out]);
    const found = fs.readdirSync(out).find((n) => n.endsWith(".app"));
    if (!found) throw new Error("no app in the update");
    const next = path.join(out, found);
    await run("/usr/bin/codesign", ["--verify", "--deep", next]);
    fs.rmSync(zip, { force: true });
    set({ status: "ready", version, app: next });
  } catch (e) {
    console.error("update failed:", e);
    set({ status: "error", message: String(e.message || e) });
  }
}

function checkNow() {
  checking ??= check().finally(() => (checking = null));
  return checking;
}

function install() {
  if (state.status !== "ready") return false;
  if (IS_WIN) {
    // /S: silent, per-user install over the current one; --force-run: reopen the app afterwards.
    spawn(state.app, ["/S", "--force-run"], { detached: true, stdio: "ignore" }).unref();
    app.quit();
    return true;
  }
  const bundle = currentBundle();
  const next = state.app;
  const backup = `${bundle}.old`;
  // The update lands under its own bundle name (OpenUncensored.app since 0.1.8), so a copy installed
  // as "Open Uncensored.app" is replaced by the renamed one rather than keeping the old file name.
  const target = path.join(path.dirname(bundle), path.basename(next));
  const script = path.join(app.getPath("userData"), "update", "install.sh");
  // Paths go in as arguments, never into the script text.
  fs.writeFileSync(
    script,
    [
      "#!/bin/sh",
      'pid="$1"; bundle="$2"; next="$3"; backup="$4"; target="$5"',
      'while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done',
      'rm -rf "$backup"',
      'mv "$bundle" "$backup" || exit 1',
      '[ "$target" = "$bundle" ] || rm -rf "$target"',
      'if /usr/bin/ditto "$next" "$target"; then rm -rf "$backup"; else rm -rf "$target"; mv "$backup" "$bundle"; target="$bundle"; fi',
      '/usr/bin/xattr -dr com.apple.quarantine "$target" 2>/dev/null',
      'rm -rf "$(dirname "$next")"',
      '/usr/bin/open "$target"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  spawn("/bin/sh", [script, String(process.pid), bundle, next, backup, target], { detached: true, stdio: "ignore" }).unref();
  app.quit();
  return true;
}

function start() {
  if (!canSelfUpdate()) return;
  setTimeout(checkNow, 10_000);
  setInterval(checkNow, CHECK_EVERY_MS).unref?.();
}

module.exports = {
  start,
  checkNow,
  install,
  getState: () => state,
  onChange: (fn) => {
    listeners.push(fn);
    return () => (listeners = listeners.filter((l) => l !== fn));
  },
};

// Automatic update install test (2026-11-26). A build of this code with a lower version than the
// latest release is launched with its own data folder; once it has downloaded the latest release
// ("Relaunch to update" shows), nobody clicks anything:
//   quit: the app is quit, and the update must be installed with the app NOT reopened;
//   idle: the app is left alone (OU_UPDATE_IDLE_S short), and it must relaunch into the update.
// Windows CI runs both (.github/workflows/windows.yml, auto_update_test=true); on a Mac the quit mode
// runs against a copy of the app in a writable folder.
//
//   node scripts/auto-update-test.cjs <app dir (Windows) or .app (Mac)> <want version> <out dir> <quit|idle>
const { _electron } = require("playwright");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const [where, want, out, mode] = process.argv.slice(2);
if (!where || !want || !out || !["quit", "idle"].includes(mode)) {
  console.error("usage: auto-update-test.cjs <app> <want version> <out dir> <quit|idle>");
  process.exit(2);
}
const IS_WIN = process.platform === "win32";
const exe = IS_WIN ? path.join(where, "OpenUncensored.exe") : path.join(where, "Contents", "MacOS", "OpenUncensored");
fs.mkdirSync(out, { recursive: true });
const log = (...a) => {
  console.log(a.join(" "));
  fs.appendFileSync(path.join(out, `auto-update-${mode}.log`), a.join(" ") + "\n");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function version() {
  if (IS_WIN) {
    return execSync(`powershell -NoProfile -Command "(Get-Item '${exe}').VersionInfo.ProductVersion"`).toString().trim();
  }
  return execSync(`/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "${path.join(where, "Contents", "Info.plist")}"`)
    .toString()
    .trim();
}

function running() {
  if (IS_WIN) return /OpenUncensored\.exe/i.test(execSync('tasklist /FI "IMAGENAME eq OpenUncensored.exe" /NH').toString());
  try {
    execSync(`pgrep -f "${exe}"`);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(test, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (test()) return true;
    } catch {}
    await sleep(3000);
  }
  return false;
}

(async () => {
  const before = version();
  log("installed before:", before, "| want:", want, "| mode:", mode);
  const app = await _electron.launch({
    executablePath: exe,
    args: [`--user-data-dir=${path.join(out, `data-${mode}`)}`],
    env: { ...process.env, OU_UPDATE_IDLE_S: mode === "idle" ? "20" : "100000" },
    timeout: 90_000,
  });
  const win = await app.firstWindow();
  // The updater checks 10 s after launch, then downloads the release.
  await win.getByText("Relaunch to update").first().waitFor({ state: "visible", timeout: 420_000 });
  await win.screenshot({ path: path.join(out, `auto-update-${mode}-ready.png`) }).catch(() => {});
  log("update downloaded and ready; nothing is clicked");

  if (mode === "quit") {
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    await app.close().catch(() => {});
    const updated = await waitFor(() => version().startsWith(want), 180_000);
    log("installed after quit:", version());
    await sleep(15_000);
    const reopened = running();
    log("reopened after quit (should be false):", reopened);
    const ok = updated && !reopened;
    log(ok ? "PASS install on quit" : "FAIL install on quit");
    process.exit(ok ? 0 : 1);
  }

  // idle: wait for the app to relaunch itself into the update
  const updated = await waitFor(() => version().startsWith(want), 240_000);
  log("installed after idle:", version());
  await app.close().catch(() => {});
  const reopened = await waitFor(running, 60_000);
  log("running the new version:", reopened);
  const ok = updated && reopened;
  log(ok ? "PASS install when idle" : "FAIL install when idle");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  log("FATAL", e.stack || String(e));
  process.exit(2);
});

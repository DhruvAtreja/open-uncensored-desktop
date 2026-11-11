// Windows self-update test (run by .github/workflows/windows.yml with update_test=true): the
// previous release is installed and launched with a key; the app must find the latest release,
// download and verify it, show "Relaunch to update", and after the click end up with the new
// version installed and running.
const { _electron } = require("playwright");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const exe = path.join(process.argv[2], "OpenUncensored.exe");
const want = process.argv[3]; // e.g. 0.1.12
const out = process.argv[4];
fs.mkdirSync(out, { recursive: true });
const log = (...a) => {
  console.log(a.join(" "));
  fs.appendFileSync(path.join(out, "update.log"), a.join(" ") + "\n");
};
const version = () => execSync(`powershell -NoProfile -Command "(Get-Item '${exe}').VersionInfo.ProductVersion"`).toString().trim();

(async () => {
  log("installed before:", version());
  const app = await _electron.launch({ executablePath: exe, timeout: 90_000 });
  const win = await app.firstWindow();
  const button = win.getByText("Relaunch to update").first();
  // The updater checks 10 s after launch, then downloads about 230 MB.
  await button.waitFor({ state: "visible", timeout: 300_000 });
  await win.screenshot({ path: path.join(out, "update-ready.png") });
  log("update downloaded and ready; clicking Relaunch to update");
  await button.click();
  await new Promise((r) => setTimeout(r, 2000));
  await app.close().catch(() => {}); // the app quits by itself; this only cleans up the Playwright handle
  // The silent installer replaces the app and reopens it.
  const t0 = Date.now();
  let now = "";
  while (Date.now() - t0 < 180_000) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      now = version();
    } catch {}
    if (now.startsWith(want)) break;
  }
  log("installed after:", now, `(${Math.round((Date.now() - t0) / 1000)} s)`);
  await new Promise((r) => setTimeout(r, 15000));
  const running = execSync('tasklist /FI "IMAGENAME eq OpenUncensored.exe" /NH').toString();
  const isRunning = /OpenUncensored\.exe/i.test(running);
  log("reopened after update:", isRunning);
  const ok = now.startsWith(want) && isRunning;
  log(ok ? "PASS self-update" : "FAIL self-update");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  log("FATAL", e.stack || String(e));
  process.exit(2);
});

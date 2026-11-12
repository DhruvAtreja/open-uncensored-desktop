// End-to-end test of the installed Windows app with a real key (run by .github/workflows/windows.yml
// when started with e2e=true). Drives the UI like a user: new conversation, ask the agent for an
// image, then for a Python program it must write and run; checks the files on disk, the inline image,
// the output in the chat, that the conversation is saved, that closing the window hides it to the
// tray and a second launch shows it, and that the page logged no errors.
const { _electron } = require("playwright");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const exe = path.join(process.argv[2], "OpenUncensored.exe");
const out = process.argv[3];
fs.mkdirSync(out, { recursive: true });
const log = (...a) => {
  const line = a.join(" ");
  console.log(line);
  fs.appendFileSync(path.join(out, "e2e.log"), line + "\n");
};
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  log(ok ? "PASS" : "FAIL", name, detail ? `(${detail})` : "");
};
const pageErrors = [];

async function launch() {
  const app = await _electron.launch({ executablePath: exe, timeout: 90_000 });
  app.process().stdout?.on("data", (d) => fs.appendFileSync(path.join(out, "main.log"), d));
  app.process().stderr?.on("data", (d) => fs.appendFileSync(path.join(out, "main.log"), d));
  const win = await app.firstWindow();
  win.on("console", (m) => fs.appendFileSync(path.join(out, "renderer.log"), `[${m.type()}] ${m.text()}\n`));
  win.on("pageerror", (e) => pageErrors.push(String(e)));
  await win.waitForLoadState("domcontentloaded");
  return { app, win };
}

async function runTask(win, label, prompt, timeoutMs) {
  const ta = win.locator('textarea[placeholder="Ask anything, or describe a task"]');
  await ta.fill(prompt);
  await ta.press("Enter");
  const stop = win.locator('button[title="Stop"]');
  await stop.waitFor({ state: "visible", timeout: 30_000 }).catch(() => log(label, "stop button never appeared"));
  const t0 = Date.now();
  let lastShot = 0;
  while (await stop.isVisible()) {
    if (Date.now() - t0 > timeoutMs) {
      log(label, "TIMEOUT, stopping the run");
      await stop.click().catch(() => {});
      break;
    }
    if (Date.now() - lastShot > 30_000) {
      lastShot = Date.now();
      await win.screenshot({ path: path.join(out, `${label}-progress-${Math.round((Date.now() - t0) / 1000)}s.png`) });
    }
    await win.waitForTimeout(1000);
  }
  log(label, `finished in ${Math.round((Date.now() - t0) / 1000)} s`);
  await win.waitForTimeout(1500);
  await win.screenshot({ path: path.join(out, `${label}.png`) });
  const text = await win.locator("main").innerText();
  fs.writeFileSync(path.join(out, `${label}.txt`), text);
  return text;
}

(async () => {
  let { app, win } = await launch();
  await win.getByText("New conversation").first().click({ timeout: 60_000 });
  const working = await win.getByText(/^Working in /).first().textContent({ timeout: 30_000 });
  const folder = working.replace(/^Working in /, "").trim();
  log("folder:", folder);
  check("conversation folder exists", fs.existsSync(folder), folder);
  await win.screenshot({ path: path.join(out, "01-new-conversation.png") });

  const imageText = await runTask(
    win,
    "02-image",
    "Generate one picture with your image tool: a red fox standing in fresh snow, photo style. Name the file fox. Then reply with just the saved file name.",
    300_000,
  );
  const images = fs.readdirSync(folder).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
  check("image file saved in the conversation folder", images.length > 0, images.join(", "));
  const big = images.filter((f) => fs.statSync(path.join(folder, f)).size > 10_000);
  check("image file has real content (>10 KB)", big.length > 0, images.map((f) => `${f}=${fs.statSync(path.join(folder, f)).size}B`).join(", "));
  const inline = await win.locator('main img[src^="data:image/png"], main img[src^="data:image/jpeg"], main img[src^="data:image/webp"]').count();
  check("image shown inline in the chat", inline > 0, `${inline} inline images`);
  check("no image error shown", !/Image generation failed/i.test(imageText));

  // Editing: the agent reuses its own picture as a reference image (POST /images/edits).
  const editText = await runTask(
    win,
    "02b-edit",
    "Use the fox picture you just made as a reference image and draw the same fox sitting in a green summer meadow. Name the file fox-summer.",
    300_000,
  );
  const edited = fs.readdirSync(folder).filter((f) => /summer.*\.(png|jpe?g|webp)$/i.test(f));
  check("edited image saved from the reference picture", edited.length > 0, edited.join(", "));
  check("edit ran on an editing model", /qwen-edit-uncensored|seedream|kontext|klein|qwen-image-3-edit/i.test(editText));
  check("no editing error shown", !/editing failed|Image generation failed/i.test(editText.split("summer meadow")[1] ?? ""));

  const codeText = await runTask(
    win,
    "03-code",
    "Write a Python script fib.py in this folder that prints the first 15 Fibonacci numbers starting 0 1, one per line. Then run it with python and show me its output.",
    300_000,
  );
  const fib = path.join(folder, "fib.py");
  check("fib.py written to disk", fs.existsSync(fib));
  if (fs.existsSync(fib)) {
    let stdout = "";
    try {
      stdout = execFileSync("python", [fib], { timeout: 20_000 }).toString();
    } catch (e) {
      stdout = String(e);
    }
    check("fib.py runs and prints 377", stdout.includes("377"), stdout.replace(/\s+/g, " ").slice(0, 120));
  }
  check("program output (377) shown in the chat", codeText.includes("377"));
  check("commands shown without the PowerShell wrapper", !/(powershell|pwsh)(\.exe)?"?\s+(-\w+\s+)*-Command/i.test(codeText));
  check("agent used PowerShell syntax first time (no bash heredoc)", !/<<\s*'?EOF/.test(codeText));

  // Branching: continue from the image reply in a new conversation; the original stays as it is.
  const origTitle = (await win.locator("header").first().innerText()).split("\n")[0].trim();
  await win.getByText("Branch from here").first().click({ force: true });
  await win.getByText(/^Branched from /).first().waitFor({ timeout: 10_000 });
  const branchText0 = await win.locator("main").innerText();
  check("branch opens with the turns up to that reply", branchText0.includes("red fox") && !branchText0.includes("fib.py"));
  const memo = await runTask(win, "05-branch", "What file name did you give the image you made earlier? Reply with just the file name.", 180_000);
  check("branch remembers the earlier conversation", /fox[-\w]*\.png/i.test(memo.split("What file name")[1] ?? ""), (memo.split("What file name")[1] ?? "").replace(/\s+/g, " ").slice(0, 160));
  await win.getByText(/^Branched from /).first().click();
  await win.waitForTimeout(1000);
  const backText = await win.locator("main").innerText();
  check("original conversation unchanged", backText.includes("fib.py") && !backText.includes("What file name"), origTitle);
  await win.getByText("Edit in a branch").first().click({ force: true });
  await win.waitForTimeout(1000);
  const composer = await win.locator('textarea[placeholder="Ask anything, or describe a task"]').inputValue();
  check("edit in a branch puts the message in the composer", composer.startsWith("Generate one picture"), composer.slice(0, 60));
  await win.screenshot({ path: path.join(out, "06-edit-branch.png") });

  for (const f of fs.readdirSync(folder)) {
    if (/\.(png|jpe?g|webp|py)$/i.test(f)) fs.copyFileSync(path.join(folder, f), path.join(out, `made-${f}`));
  }

  // Tray: closing the window hides it and the app keeps running; launching the app again brings that
  // window back instead of starting a second copy. (app.close() below must still really quit.)
  const windows = () =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), destroyed: w.isDestroyed() })));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await win.waitForTimeout(1500);
  const hidden = await windows();
  check("closing the window hides it to the tray, app still running", hidden.length === 1 && !hidden[0].visible, JSON.stringify(hidden));
  await win.screenshot({ path: path.join(out, "07-hidden.png") }).catch(() => {});
  const second = require("node:child_process").spawn(exe, [], { detached: true, stdio: "ignore" });
  second.unref();
  await win.waitForTimeout(8000);
  const shown = await windows();
  check("opening the app again shows the same window", shown.length === 1 && shown[0].visible, JSON.stringify(shown));
  let secondGone = false;
  try {
    process.kill(second.pid, 0);
  } catch {
    secondGone = true;
  }
  check("the second launch quit instead of running a second copy", secondGone, `pid ${second.pid}`);
  await app.close();

  // Relaunch: the conversation is still there.
  const store = path.join(process.env.APPDATA, "Open Uncensored", "conversations.json");
  const saved = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, "utf8")) : [];
  const main = saved.find((c) => !c.branchedFrom && c.turns.length >= 4);
  check("conversations saved to disk (original + branch)", Boolean(main) && saved.some((c) => c.branchedFrom), `${saved.length} saved`);
  ({ app, win } = await launch());
  const sidebarHasIt = await win.getByText(main?.title ?? "__none__", { exact: true }).first().isVisible({ timeout: 20_000 }).catch(() => false);
  check("conversation listed again after a restart", sidebarHasIt, main?.title);
  await win.screenshot({ path: path.join(out, "04-after-restart.png") });
  await app.close();

  check("no JavaScript errors in the page", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 400));
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  log(`${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  log("FATAL", e.stack || String(e));
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
  process.exit(2);
});

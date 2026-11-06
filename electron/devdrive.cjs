// Development only: drives the UI end to end and saves screenshots, so the app can be checked
// without anyone clicking. Run with OU_DEV_DRIVE=<output dir> (see README).
const fs = require("node:fs");
const path = require("node:path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function drive(win, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const js = (code) => win.webContents.executeJavaScript(code);
  win.webContents.setBackgroundThrottling(false); // keep painting while the window is behind others
  const shot = async (name) => {
    win.webContents.invalidate();
    await sleep(400);
    fs.writeFileSync(path.join(outDir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const click = (text) =>
    js(`[...document.querySelectorAll("button")].find(b => b.title === ${JSON.stringify(text)} || b.textContent.trim().startsWith(${JSON.stringify(text)}))?.click()`);
  const type = (text) =>
    js(`(() => { const t = document.querySelector("textarea");
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(t, ${JSON.stringify(text)});
      t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  const waitIdle = async (max) => {
    for (let i = 0; i < max; i++) {
      await sleep(1000);
      const busy = await js(`[...document.querySelectorAll("button")].some(b => b.title === "Stop")`);
      if (!busy) return;
    }
  };
  try {
    await sleep(2500);
    await shot("1-home");
    await click("New conversation");
    await sleep(500);
    await type("In one sentence, what is an abliterated language model, and why would someone want one for a long running agent?");
    await click("Send");
    await sleep(1500);
    await waitIdle(60);
    await shot("2-chat");
    await js(`[...document.querySelectorAll("button")].find(b => b.querySelector("svg") && b.textContent.includes("GLM 5.3 Flash Uncensored"))?.click()`);
    await sleep(400);
    await shot("2b-picker");
    await js(`document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))`);
    await click("Open a project folder");
    await sleep(800);
    await type("Fix the bug in calc.py so add returns the sum, then verify it with python3.");
    await click("Send");
    await sleep(1500);
    await waitIdle(150);
    await sleep(500);
    // expand command outputs for the screenshot
    await js(`[...document.querySelectorAll("button")].filter(b => b.querySelector(".font-mono") && b.closest(".overflow-hidden")).forEach(b => b.click())`);
    await sleep(300);
    await shot("3-agent");
    await sleep(6000); // auto title arrives after the first exchange
    await js(`document.querySelector("header button[title='Rename']")?.click()`);
    await sleep(300);
    await js(`(() => { const i = document.querySelector("header input");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, "Fix calc bug");
      i.dispatchEvent(new Event("input", { bubbles: true }));
      i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
    await sleep(400);
    await shot("4-renamed");
    await js(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "\\\\", metaKey: true }))`);
    await sleep(400);
    await shot("5-collapsed");
    fs.writeFileSync(path.join(outDir, "conversations.json"), JSON.stringify(await js("window.ou.getConversations()"), null, 1));
  } catch (e) {
    fs.writeFileSync(path.join(outDir, "error.txt"), String(e && e.stack || e));
  }
  require("electron").app.quit();
};

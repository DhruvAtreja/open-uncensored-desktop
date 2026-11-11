// Windows smoke test for the installed app (run by .github/workflows/windows.yml after a silent
// install): the bundled Codex CLI runs, and the image tool answers MCP initialize + tools/list
// when started the way the agent starts it (the app's own exe in Node mode).
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const dir = process.argv[2];
const app = path.join(dir, "OpenUncensored.exe");
const unpacked = path.join(dir, "resources", "app.asar.unpacked");
const codex = path.join(unpacked, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
const tool = path.join(unpacked, "electron", "image-tool.cjs");

for (const f of [app, codex, tool]) {
  if (!fs.existsSync(f)) throw new Error(`missing: ${f}`);
  console.log("found", f);
}
console.log("codex:", execFileSync(codex, ["--version"]).toString().trim());

const child = spawn(app, [tool], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["pipe", "pipe", "inherit"] });
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ci", version: "1" } } }) + "\n");
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
setTimeout(() => {
  child.kill();
  const ok = out.includes("generate_image") && out.includes("list_image_models");
  console.log("image tool:", ok ? "answers tools/list" : `no tools in output: ${out.slice(0, 500)}`);
  process.exit(ok ? 0 : 1);
}, 8000);

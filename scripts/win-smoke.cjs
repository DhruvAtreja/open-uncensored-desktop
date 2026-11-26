// Windows smoke test for the installed app (run by .github/workflows/windows.yml after a silent
// install): the bundled Codex CLI runs, and the image and video tools answer MCP initialize +
// tools/list when started the way the agent starts them (the app's own exe in Node mode).
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const dir = process.argv[2];
const app = path.join(dir, "OpenUncensored.exe");
const unpacked = path.join(dir, "resources", "app.asar.unpacked");
const codex = path.join(unpacked, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
const servers = [
  { label: "image tool", file: path.join(unpacked, "electron", "image-tool.cjs"), tools: ["generate_image", "list_image_models"] },
  { label: "video tool", file: path.join(unpacked, "electron", "video-tool.cjs"), tools: ["generate_video", "list_video_models"] },
];

for (const f of [app, codex, ...servers.map((s) => s.file)]) {
  if (!fs.existsSync(f)) throw new Error(`missing: ${f}`);
  console.log("found", f);
}
console.log("codex:", execFileSync(codex, ["--version"]).toString().trim());

// Starts one tool server, sends initialize + tools/list, and after 8 s checks that every tool is listed.
function check({ label, file, tools }) {
  return new Promise((resolve) => {
    const child = spawn(app, [file], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ci", version: "1" } } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    setTimeout(() => {
      child.kill();
      const ok = tools.every((t) => out.includes(t));
      console.log(`${label}:`, ok ? "answers tools/list" : `no tools in output: ${out.slice(0, 500)}`);
      resolve(ok);
    }, 8000);
  });
}

(async () => {
  let ok = true;
  for (const s of servers) ok = (await check(s)) && ok;
  process.exit(ok ? 0 : 1);
})();

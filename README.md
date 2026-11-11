# OpenUncensored Desktop

A desktop agent for uncensored models. Chat with it, or point it at a folder and let it read, write and
run code for you, on any of the uncensored and abliterated models served by
[OpenUncensored](https://openuncensored.com).

- **One app for chat and agent work.** Every conversation is an agent: ask a question and it answers;
  give it a task and it edits files and runs commands, showing each step as it goes.
- **Every model, ranked.** The model picker shows the [OpenUncensored Score](https://openuncensored.com/rankings)
  for each model, so you can pick one that actually finishes agent tasks.
- **No account.** Buy prepaid credits by card from inside the app and the key arrives by itself, or paste
  an existing key. It is stored encrypted in your macOS keychain.
- **Your conversations stay on your Mac.** OpenUncensored does not store prompts or replies.

## Install

Paste this into Terminal (Apple Silicon Macs):

```bash
curl -fsSL https://openuncensored.com/install.sh | sh
```

It downloads the latest release from this repo, checks it against the published SHA-256, puts
**OpenUncensored** in Applications and opens it. After that the app updates itself: new versions
download in the background and the sidebar shows **Relaunch to update**.

That is the only way to install it: the app is not notarized by Apple yet, so the script installs
the release zip and clears the download flag that would otherwise make macOS block the first launch.

### Windows

Windows 10 or 11, 64-bit. In PowerShell:

```powershell
irm https://openuncensored.com/install.ps1 | iex
```

Or download the installer from [openuncensored.com/download](https://openuncensored.com/download#windows). It is not
code-signed yet, so Windows may show "Windows protected your PC": click **More info**, then **Run anyway**. The app
installs for your user only (no admin rights) and updates itself. The Windows installer is built and smoke-tested on a
clean Windows runner by `.github/workflows/windows.yml` and attached to each release.

## How it works

- `electron/main.cjs`: the window, the API key (encrypted with the OS keychain), saved conversations, all
  network calls, and the agent runner.
- The agent engine is the open source [Codex CLI](https://github.com/openai/codex) (Apache 2.0), bundled
  and run in the background with its own private settings, pointed at the OpenUncensored API (which serves
  the Responses API Codex speaks). The app replaces Codex's system prompt with
  `electron/agent-prompt.md` and turns off its extras (skills, memories, sub-agents, hosted tools).
- The agent starts in the conversation's folder (`~/OpenUncensored` by default) with full access to your
  user account, the same as running commands in Terminal yourself.
- `src/`: the interface (React): conversations, the agent view, the model picker, key setup and credit
  purchases.

## Build from source

```bash
npm install
npm start      # build the interface and open the app
npm run dist   # macOS arm64 zip in release/ (the file install.sh and the updater use)
```

End-to-end check without clicking (development only): set `OU_DEV_KEY` to an OpenUncensored key,
`OU_DEV_FOLDER` to a test folder and `OU_DEV_DRIVE` to an output directory, then run `npx electron .`.
`electron/devdrive.cjs` sends a message and an agent task and saves screenshots there.

## License

MIT. See [LICENSE](LICENSE). Bundled and adapted third party components are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

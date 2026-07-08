# Claude Sessions

A local dashboard and native macOS menubar app for people running multiple Claude Code accounts.

If you juggle several Claude Max/Pro accounts across clients or projects, this gives you one place to see every account's usage limits at a glance, browse and resume any past session, and switch active accounts without digging through Keychain or re-running `claude /login`.

## Features

- **Session dashboard** (browser, `localhost:8934`) — indexes every Claude Code session from `~/.claude/projects/*/*.jsonl`, searchable by title/prompt/project, with full transcript view and one-click "resume in Terminal" (`claude --resume <id>`).
- **Menubar app** (native SwiftUI, no Dock icon) — three columns:
  - every account with live usage bars (current session, all-models weekly, per-model weekly)
  - your last 20 sessions across all projects, click to resume
  - account management: add via real browser OAuth sign-in, set active (with confirmation), remove
- **Menubar icon** shows the AI Makers diamond plus the active account's worst usage percentage, tinted by severity (green/amber/red) so you can tell you're near a limit without opening the menu.
- **Multi-account under the hood** — accounts are stored as separate macOS Keychain items; switching rewrites the active slot (`Claude Code-credentials`) and mirrors it to `~/.claude/credentials.json`, exactly like the `claude` CLI does.
- **Real OAuth add-account flow** — authorization-code + PKCE against Claude's own endpoints, browser sign-in only, no manual code paste.
- **Zero dependencies** — pure `node:*` built-ins for the server, vanilla JS for the dashboard, pure Swift/SwiftUI for the menubar app (no npm, no SPM).

## Requirements

- macOS 13+ (required for the menubar app; the dashboard alone runs anywhere Node runs)
- Node 18+
- Claude Code CLI installed and logged in at least once (`claude`)
- Xcode Command Line Tools (`swiftc`) to build the menubar app — install with `xcode-select --install` if you don't have them

## Quick start

Clone this repo anywhere on disk.

### Dashboard

```bash
./launch.sh
```

Starts `server.mjs` on port 8934 if it isn't already running, then opens `http://localhost:8934` in your browser. Or run the server directly:

```bash
node server.mjs
```

The server binds to `127.0.0.1` only — it is not reachable from other machines on your network.

### Menubar app

```bash
bash menubar/build.sh
open "Claude Sessions Menubar.app"
```

This compiles `menubar/main.swift` headlessly with `swiftc` and assembles `Claude Sessions Menubar.app` in this directory. It ad-hoc code-signs the bundle so `SMAppService` (Start at Login) works reliably on Apple Silicon. The menubar app talks to the same local server, so `launch.sh` or `node server.mjs` should be running (the menubar app does not start the server itself).

An optional **Start at Login** toggle lives in the app's footer, backed by `SMAppService`.

## Adding / switching accounts

- **Add an account**: click **+ Add account** in the menubar app (or the dashboard's account panel). This opens your default browser to Claude's real sign-in page. Once you approve, the browser redirects back to the local server, which exchanges the code for tokens and stores the account in Keychain. Adding an account never switches your active one — it's stored alongside your existing accounts until you deliberately activate it.
- **Switch active account**: click **Set active** on any account card. You'll get a confirmation dialog first (`Switch to <email>?`) because this rewrites your Keychain and `~/.claude/credentials.json`.
- **Running sessions keep their account.** A `claude` process already running in a Terminal window keeps using whichever account was active when it started — switching only affects new sessions. Restart (exit + relaunch) any session you want on the new account.
- **Remove an account**: also confirmed. You cannot remove the active credentials slot — switch to another account first.

## First-run notes

- **Keychain prompts.** The first time the app reads or writes a `Claude Code-credentials*` item, macOS will ask for Keychain access — choose **Always Allow** so you're not prompted every time.
- **Terminal automation.** Resuming a session from the dashboard drives Terminal via AppleScript (`osascript`), so macOS will ask for Automation permission for Terminal the first time you resume.
- **Login Items approval.** If you enable Start at Login, macOS may ask you to approve the app under System Settings → General → Login Items.

## How it works

- **Keychain layout**: `Claude Code-credentials` is the active slot the `claude` CLI itself reads. `Claude Code-credentials-<hash>` (hash of the access token) holds every other stored account. Switching re-stashes whatever was active before overwriting it, so nothing is lost.
- **Usage data** comes from Claude's own OAuth endpoints — `https://api.anthropic.com/api/oauth/profile` and `/api/oauth/usage`. These are undocumented internal endpoints the `claude` CLI itself uses; they may change or break without notice.
- **Security**: tokens never leave your machine. The server binds to `127.0.0.1` only, tokens are never sent to the dashboard/menubar UI (only derived info like email, plan, and usage numbers), and access/refresh tokens are never written to `server.log` or the console.

## Security notes / disclaimer

This project is not affiliated with or endorsed by Anthropic. It reads and writes real Claude Code credentials in your macOS Keychain and on disk (`~/.claude/credentials.json`). Use at your own risk — review `server.mjs` and `menubar/main.swift` before running if you want to verify exactly what it does with your tokens. Your credentials stay in your own Keychain; nothing is sent to any third-party server.

## Credits

Built by [AI Makers](https://aimakers.co).

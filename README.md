# AI Ops

A local **AI operations command center** for your Mac — one place to see every Claude and Codex subscription's usage, switch active accounts, browse and resume Claude Code sessions, and keep an eye on your automations, MCP servers, and skills.

Built for people who run multiple AI subscriptions and hit rate limits mid-task. Everything is local: your tokens never leave your machine, and the server binds to `127.0.0.1` only.

Built by [AI Makers](https://aimakers.co).

## Features

- **Multi-provider accounts** — Claude (Max/Pro) and OpenAI Codex (ChatGPT) side by side. Live usage bars (session / weekly / per-model), plan, and reset times for each account.
- **One-click account switching** — flip the active account without logging in and out of the CLI. Confirm-before-switch; new sessions pick it up.
- **Add accounts by browser login** — real OAuth flow for both Claude and Codex; no manual token pasting (paste-import is available as a fallback).
- **Resilient usage** — the usage endpoints throttle under load; AI Ops retries and caches last-known values (persisted across restarts) so an active account never blanks.
- **Automations** — see your `cron` + `launchd` jobs: status, schedule, next/last run. Run now, enable/disable, and tail logs.
- **MCP** — every configured MCP server (user + project scope) with its full config, including env/keys, masked with reveal + copy (it's your own machine).
- **Skills** — all your Claude and Codex skills in one searchable list.
- **Session resume** — browse and search every Claude Code session; resume any of them in Terminal.
- **Native menubar app** — a quick-glance popover: account usage, resume list, account switching, and an automations health indicator.

## Requirements

- **macOS 13+** (for the menubar app; the dashboard alone runs anywhere Node does)
- **Node 18+**
- **Claude Code CLI** and/or **Codex CLI**, logged in
- **Xcode Command Line Tools** (`swiftc`) to build the menubar app

## Quick start

```bash
git clone https://github.com/AiMakers-co/ai-ops.git
cd ai-ops

# Dashboard (browser) — http://localhost:8934
./launch.sh          # starts the server if needed and opens the browser
# or: node server.mjs

# Menubar app
bash menubar/build.sh
open "AI Ops.app"
```

The menubar app can start at login via the toggle in its footer.

## Accounts

- **Add** — click **＋ Add Claude account** or **＋ Add Codex account** → sign in in the browser → done. (Import from a pasted credential blob is available under "Advanced".)
- **Switch** — **Make active** on any account (asks to confirm). Running CLI sessions keep their account until restarted; new sessions use the newly-active one. Adding an account does **not** change your active one.
- **Codex** — disconnect removes the active Codex account (backs it up first); re-add via login anytime.

## First-run notes

- macOS **Keychain** prompts the first time it reads each Claude credential — click "Always Allow".
- Adding a Codex account opens a loopback listener on port **1455** (the port OpenAI's client expects), just like the Codex CLI.
- Resume and login flows open **Terminal / your browser**; macOS may ask to allow automation once.

## How it works

- **Claude** credentials live in the macOS Keychain (`Claude Code-credentials` = active slot, `Claude Code-credentials-<hash>` = stored accounts). **Codex** credentials live in `~/.codex/auth.json` (active) and `~/.codex/accounts/` (stored).
- Usage/plan come from each provider's OAuth endpoints (`api.anthropic.com/api/oauth/*` for Claude; the ChatGPT backend for Codex). These are undocumented and may change without notice.
- Expired access tokens are auto-refreshed via their refresh tokens (rotated tokens are persisted back).
- The server binds to `127.0.0.1` only. Tokens are never logged and never sent to the browser UI (usage/plan/status only). Because it's a single-user local tool, the MCP view intentionally shows your own configured keys.

## Security

Your credentials stay in your Keychain / `~/.codex`. Nothing is uploaded anywhere. Not affiliated with Anthropic or OpenAI — use at your own risk.

## License

MIT © 2026 Mark Austen / AI Makers LLC

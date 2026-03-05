# CLI Timeline

**GitLens for AI Prompts — see what every CLI prompt changed.**

> Git Timeline shows commits. Local History shows saves. CLI Timeline shows what your CLI agent changed.

Supports **GitHub Copilot CLI** and **Claude Code** out of the box.

<!-- TODO: Add a hero screenshot or GIF here showing the Session Explorer with prompts and file changes -->

---

## The Problem

CLI agents (Copilot CLI, Claude Code) make file changes **directly at the OS level — outside VS Code.** VS Code doesn't see these edits happening:

- ❌ **Undo/Redo** — only for edits made inside VS Code
- ❌ **Local History** — only for files VS Code was watching
- ❌ **Git History** — only for committed changes

If something breaks 10 prompts in, your only option is to manually `git diff` and hope for the best.

## When to Use CLI Timeline

**🔙 "Something broke — which prompt did it?"**
You're 15 prompts into a session and your app won't build. Instead of guessing, open CLI Timeline, browse each prompt's file changes, and diff exactly what happened. Revert the offending prompt — or revert everything back to a known good state.

**🔍 "What did this AI session actually do?"**
You're reviewing a colleague's PR and they used Copilot CLI or Claude Code to make the changes. If they shared their session (committed to `.cli-sessions/`), you can browse every prompt, see every file touched, and understand the reasoning behind the changes — not just the final diff.

**🛠️ Vibe coding gone wrong**
You're iterating fast with a CLI agent — "add auth", "refactor the API", "fix the tests" — and things spiral. CLI Timeline gives you per-prompt checkpoints to rewind to, so you can keep the good changes and undo the rest.

**🆘 "Can someone help me fix this?"**
You're stuck and need a teammate (or a senior dev) to help untangle what your CLI agent did. Share your session to the repo — they can see every prompt you ran, every file that changed, and exactly where things went off track. No screen-sharing or "walk me through what you did" needed.

---

## Features

### 🗂️ Session Explorer
Browse all sessions → see prompts → see files changed per prompt. Search and filter sessions by name or prompt text.

<!-- TODO: Add screenshot of the Session Explorer sidebar -->

### 🔍 Prompt Diffs
Click any file change to see a side-by-side diff of what the prompt changed. For Copilot CLI, diffs use exact pre-prompt backup snapshots. For Claude Code, diffs are reconstructed from the recorded edit operations.

<!-- TODO: Add screenshot of a prompt diff view -->

### ⏪ Revert to Any Prompt
Revert a single file — or all files changed by a prompt — back to their pre-prompt state. The extension confirms before applying any changes, so you can revert with confidence.

<!-- TODO: Add screenshot or GIF of the revert flow -->

### 🤝 Session Sharing
Commit a session to `.cli-sessions/` in your repo so teammates can browse what your CLI agent did. Shared sessions appear in a dedicated "Shared Sessions" panel (read-only) — great for code reviews, onboarding, and knowledge sharing.

### 📂 Reverse Lookup
Right-click any file in the Explorer → **"Show AI Prompts That Changed This File"** to jump straight to the prompts that touched it.

### 🔄 Live Reload
A file watcher monitors for new Copilot CLI activity and auto-refreshes sessions — no manual reload needed during active sessions.

---

## Supported CLI Tools

| Tool | Session History | Diff | Revert |
|------|----------------|------|--------|
| **GitHub Copilot CLI** | ✅ | ✅ Exact (backup snapshots) | ✅ |
| **Claude Code** | ✅ | ✅ Reconstructed from edits | 🔜 Coming soon |

> **Claude Code note:** Diffs are reconstructed from the edit data recorded in the session (the exact `old_string`/`new_string` pairs Claude Code used), which is accurate for individual edits but may be approximate when edits overlap. Session history and diff views are fully supported. Revert support is planned for a future release.

---

## How It Works

CLI Timeline reads session data that CLI tools **already persist** — no extra logging, plugins, or configuration needed:

- **Copilot CLI** stores session data in `~/.copilot/session-state/`:
  - `workspace.yaml` — session metadata (working directory, git root, branch)
  - `events.jsonl` — every user message and tool call
  - `rewind-snapshots/` — pre-prompt file backups (used for exact diffs and revert)

- **Claude Code** stores session data in `~/.claude/projects/`:
  - Per-session `.jsonl` files containing user messages, assistant responses, and tool calls with `old_string`/`new_string` edit data

**Everything is local.** CLI Timeline only reads files already on your machine. Nothing is sent anywhere.

---

## Commands

| Command | Description |
|---------|-------------|
| `CLI Timeline: Refresh Sessions` | Reload session data |
| `CLI Timeline: Search` | Filter sessions by name or prompt text |
| `CLI Timeline: Clear Search` | Clear the active search filter |
| `CLI Timeline: Show Prompts for This File` | See all prompts that changed the active file |
| `CLI Timeline: Revert File to Prompt State` | Revert the active file to its state before a selected prompt |
| `Revert to Pre-Prompt State` | Revert a single file (inline action in tree view) |
| `Revert All Files in Prompt` | Revert every file changed by a prompt (inline action in tree view) |
| `Copy Session ID` | Copy a session's ID to the clipboard |
| `Share Session to Repo` | Commit session data to `.cli-sessions/` for team sharing |

## Settings

These settings let you point CLI Timeline at custom session storage locations if your CLI tools are configured to use non-default paths.

| Setting | Default | Description |
|---------|---------|-------------|
| `cliTimeline.sessionPaths.copilotCLI` | `~/.copilot/session-state` | Path to Copilot CLI session storage |
| `cliTimeline.sessionPaths.claudeCode` | `~/.claude` | Path to Claude Code session storage |

## License

MIT

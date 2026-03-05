# CLI Timeline

**GitLens for AI Prompts — see what every CLI prompt changed.**

> Git Timeline shows commits. Local History shows saves. CLI Timeline shows what your AI assistant did.

Supports **GitHub Copilot CLI** and **Claude Code** out of the box.

---

## The Problem

CLI agents (Copilot CLI, Claude Code) make file changes **directly at the OS level — outside VS Code.** VS Code doesn't see these edits happening:

- ❌ **Undo/Redo** — only for edits made inside VS Code
- ❌ **Local History** — only for files VS Code was watching
- ❌ **Git History** — only for committed changes

If something breaks 20 prompts in, your only option is to manually figure out what changed.

## The Solution

CLI Timeline reads the session data that CLI tools **already store** and surfaces it as a native VS Code experience:

### 🗂️ Session Explorer
Browse all sessions → see prompts → see files changed per prompt.

### 📝 Inline Prompt Blame
Like GitLens blame, but for AI prompts. See which prompt last changed each line:

```
const auth = jwt.verify(token, secret);  🔵 "Add JWT auth" • Copilot CLI • 2h ago
```

### ⏱️ Timeline Provider
Integrates into VS Code's Timeline panel alongside Git and Local History. Open any file → see AI prompts that touched it.

### 🔍 Prompt Hover
Hover over any AI-modified line for rich details: full prompt text, all files changed, tools used.

### 📂 Reverse Lookup
Right-click any file → "Show AI Prompts That Changed This File"

---

## Supported CLI Tools

| Tool | Session History | Diff | Revert |
|------|----------------|------|--------|
| **GitHub Copilot CLI** | ✅ | ✅ Exact (backup file) | ✅ |
| **Claude Code** | ✅ | ✅ Reconstructed from edits | ❌ No backup files saved by Claude Code |
| **Cline** | 🔜 Coming | 🔜 Coming | 🔜 Coming |

> **Claude Code note:** Claude Code does not currently save pre-prompt backup files, so the revert feature is unavailable for Claude Code sessions. Diffs are reconstructed from the edit data recorded in the session (the exact `old_string`/`new_string` pairs Claude Code used), which is accurate for individual edits but may be incomplete if edits were ambiguous. The history and diff views are fully supported.

## Commands

| Command | Keybinding | Description |
|---------|-----------|-------------|
| `CLI Timeline: Toggle Prompt Blame` | `Alt+B` | Toggle inline blame annotations |
| `CLI Timeline: Show Prompts for This File` | — | See all prompts that changed the active file |
| `CLI Timeline: Previous Prompt Revision` | `Alt+[` | Step to previous prompt's file state |
| `CLI Timeline: Next Prompt Revision` | `Alt+]` | Step to next prompt's file state |
| `CLI Timeline: Refresh Sessions` | — | Reload session data |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `cliTimeline.blame.enabled` | `true` | Show inline prompt blame |
| `cliTimeline.blame.format` | `${icon} "${prompt}" • ${tool} • ${timeAgo}` | Blame text format |
| `cliTimeline.sessionPaths.copilotCLI` | `~/.copilot/session-state` | Custom Copilot CLI session path |
| `cliTimeline.sessionPaths.claudeCode` | `~/.claude` | Custom Claude Code session path |

## How It Works

CLI Timeline reads session data that CLI tools already persist:

- **Copilot CLI**: `~/.copilot/session-state/` — events.jsonl, rewind-snapshots, workspace.yaml
- **Claude Code**: `~/.claude/projects/` — session JSONL files

No extra logging or configuration needed. Pure local data — nothing is sent anywhere.

## License

MIT

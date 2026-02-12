# Ghost

Local AI session capture and search for Claude Code.

Ghost non-blockingly records Claude Code sessions as markdown, attaches them to commits via git notes, and indexes them into [QMD](https://github.com/tobi/qmd) for semantic search. The agent can query its own history, learn from past mistakes, and start every session warm.

## How It Works

Ghost installs as a set of [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) that fire on session start, prompt submit, file write, turn completion, and session end. Every hook exits in under 100ms. Heavy work (AI summarization, git notes, QMD indexing) runs in a detached background process after the session ends.

Sessions are stored as human-readable markdown in `.ai-sessions/completed/`, with YAML frontmatter for structured metadata. Git notes attach session context directly to commits. QMD exposes session history as an MCP server so Claude Code can search past reasoning within the current project.

```
.ai-sessions/
  active/              # Current in-progress session
  completed/           # Finalized session markdown files
  knowledge.md         # Auto-generated project knowledge base
  mistakes.md          # Mistake ledger (negative knowledge)
  decisions.md         # Decision log (ADR-lite)
  tags.json            # Tag -> session ID index
```

## Requirements

- [Bun](https://bun.sh) >= 1.0
- [Claude Code](https://claude.ai/download) (for AI summarization)
- [QMD](https://github.com/tobi/qmd) (for semantic search, optional)
- macOS: `brew install sqlite` (required by QMD)

## Install

```bash
bun install -g github:notkurt/ghost
```

Or clone and link:

```bash
git clone https://github.com/notkurt/ghost.git
cd ghost
bun install
bun link
```

## Setup

Enable ghost in any git repository:

```bash
cd your-project
ghost enable
```

This creates the `.ai-sessions/` directory, configures Claude Code hooks in `.claude/settings.json`, sets up git notes, and optionally creates a QMD collection for search.

To auto-install missing dependencies (QMD, sqlite):

```bash
ghost enable -f
```

To build an initial knowledge base from your codebase before any sessions:

```bash
ghost enable --genesis
```

To remove hooks (session files are preserved):

```bash
ghost disable
```

## What Gets Captured

Every Claude Code session automatically produces a markdown file like this:

```markdown
---
session: 2026-02-13-k8f2m9x1
branch: feature/cart-fees
base_commit: a1b2c3d4
started: 2026-02-13T09:30:00Z
ended: 2026-02-13T10:15:00Z
tags: [area:cart, fees, type:refactor]
---

## Prompt 1
> Refactor the cart to use percentage-based fees

- Modified: src/cart/fees.ts
- Modified: src/cart/types.ts

---
_turn completed: 2026-02-13T09:35:12Z_

## Prompt 2
> The fee calculation is wrong for orders over $500

- Modified: src/cart/fees.ts
- Modified: src/cart/__tests__/fees.test.ts

---
_turn completed: 2026-02-13T09:41:30Z_

## Summary

### Intent
Migrate cart fee system from fixed amounts to percentage-based with a cap.

### Changes
- src/cart/fees.ts: Replaced fixed fee lookup with percentage calc, added $50 cap
- src/cart/types.ts: Added FeeStrategy type

### Decisions
**Percentage with hard cap**: Client wanted flexible fees -> chose percentage
with $50 cap (simpler, client preferred)

### Mistakes
_None this session._

### Open Items
- Update metafield sync to include fee strategy
- Tax interaction with percentage fees untested

### Tags
area:cart, fees, type:refactor
```

## Commands

### Setup

| Command | Description |
|---------|-------------|
| `ghost enable` | Set up hooks, directories, git notes, QMD collection |
| `ghost enable -f` | Same, but auto-install missing dependencies |
| `ghost enable --genesis` | Same, plus build initial knowledge base from codebase |
| `ghost disable` | Remove hooks (keeps session files) |
| `ghost status` | Show current session, counts, dependency status |

### Search and Browse

| Command | Description |
|---------|-------------|
| `ghost search <query>` | Semantic search across sessions via QMD |
| `ghost search --tag <tag> <query>` | Search filtered by tag |
| `ghost log` | List recent sessions |
| `ghost show <commit>` | Show session note attached to a commit |

### Knowledge

| Command | Description |
|---------|-------------|
| `ghost knowledge build` | Rebuild knowledge base from all sessions |
| `ghost knowledge inject` | Append knowledge base to CLAUDE.md |
| `ghost knowledge show` | Print current knowledge base |
| `ghost knowledge diff` | Show current knowledge base (rebuild to update) |
| `ghost edit knowledge` | Open knowledge base for manual editing |
| `ghost edit mistakes` | Open mistake ledger for manual editing |
| `ghost edit decisions` | Open decision log for manual editing |

### Tagging

| Command | Description |
|---------|-------------|
| `ghost tag <session-id> <tags...>` | Add tags to a session |
| `ghost tag --last <tags...>` | Tag the most recent session |

### Context

| Command | Description |
|---------|-------------|
| `ghost resume [session-id]` | Context handoff from a previous session |
| `ghost brief "<description>"` | Generate scoped context brief for upcoming work |
| `ghost mistake "<description>"` | Add entry to mistake ledger |
| `ghost decisions` | Show decision log |

### Analytics

| Command | Description |
|---------|-------------|
| `ghost heatmap` | File modification frequency across sessions |
| `ghost heatmap --tag <tag>` | Heatmap filtered by tag |
| `ghost stats` | Session metrics and trends |
| `ghost stats --json` | Structured output |
| `ghost stats --since <date>` | Filter by date |
| `ghost reindex` | Rebuild QMD collection from all completed sessions |

## Session Hooks

Ghost registers these Claude Code hooks (all called automatically):

| Hook | Event | What It Does |
|------|-------|-------------|
| `ghost session-start` | SessionStart | Creates session file, injects warm resume context |
| `ghost session-end` | SessionEnd | Finalizes session, forks background processing |
| `ghost prompt` | UserPromptSubmit | Records user prompt |
| `ghost stop` | Stop | Records turn completion with timestamp |
| `ghost post-write` | PostToolUse(Write/Edit) | Records file modification |
| `ghost post-task` | PostToolUse(Task) | Records subtask completion |
| `ghost checkpoint` | post-commit (git hook) | Attaches session as git note to HEAD |

## Features

### Warm Resume

When you start a new session on the same branch within 24 hours, Ghost automatically injects context from the previous session: what you were doing, where you left off, which files were involved, key decisions made, and known pitfalls. No manual "continue where we left off" needed.

### Knowledge Base

After every N sessions (default 5), Ghost can rebuild a project knowledge base that captures architecture, conventions, decisions, gotchas, and patterns that work. This is CLAUDE.md that writes itself.

```bash
ghost knowledge build    # Rebuild now
ghost knowledge inject   # Append to CLAUDE.md so the agent sees it
```

### Mistake Ledger

Ghost tracks things that went wrong. Auto-extracted from session summaries, or added manually:

```bash
ghost mistake "Don't use cart.js API for bundles -- it drops line properties over 250 chars"
```

On session start, known pitfalls are injected into context so the agent avoids repeating past mistakes.

### Decision Log

Significant technical decisions are auto-extracted from sessions and logged with context and reasoning. Query them later:

```bash
ghost decisions
ghost decisions --tag "area:checkout"
```

### Scope Briefing

Before starting work, generate a context brief that pulls relevant sessions, decisions, known issues, and frequently modified files:

```bash
ghost brief "add a new payment method to checkout"
```

### Git Notes

Session data is attached to commits via `refs/notes/ai-sessions`. View them with:

```bash
git log --show-notes=ai-sessions
ghost show <commit-sha>
```

Push notes to a remote:

```bash
git push origin refs/notes/ai-sessions
```

### QMD MCP Server

When QMD is installed, Ghost configures an MCP server so Claude Code can search past sessions directly during a conversation. The agent can ask things like "what did we decide about fee calculation?" and get answers from its own history.

## Architecture

- Runtime: [Bun](https://bun.sh) (starts in ~6ms, critical for hook latency)
- Sessions: Markdown with YAML frontmatter in `.ai-sessions/`
- Git integration: Notes on `refs/notes/ai-sessions`
- Search: [QMD](https://github.com/tobi/qmd) with project-scoped collections (`ghost-<repo-name>`)
- Summarization: `claude -p` via Claude Code CLI
- Hooks: Registered in `.claude/settings.json`

All data is local. No SaaS, no external services. Everything is scoped to the individual repo.

## Development

```bash
bun src/index.ts <command>   # Run from source
bun test                     # Run all tests
bun link                     # Install globally as 'ghost'
```

## License

MIT

# Ghost — Local AI Session Capture & Search

Non-blocking, zero-friction capture of Claude Code sessions with semantic search via QMD. Sessions are logged as markdown, attached to commits via git notes, and indexed locally so the agent can query its own history.

## Principles

- **Never block the agent.** Session commits happen asynchronously in the background — no user confirmation, no pauses.
- **Everything is local.** No SaaS, no orphan branches, no external services. Git notes + QMD.
- **Strictly per-project.** All session data, knowledge bases, mistake ledgers, and QMD indexes are scoped to the individual repo. No cross-project leakage. Each project gets its own QMD index derived from the repo name.
- **Markdown is the format.** Sessions are human-readable markdown files. No proprietary formats.
- **The agent searches itself.** QMD exposes session history as an MCP server so Claude Code can query past reasoning within the current project.

---

## Project Structure

```
ghost/
├── ghost                     # Shell wrapper (like qmd's — do NOT replace with compiled binary)
├── src/
│   ├── index.ts              # CLI entrypoint — uses util.parseArgs for argument parsing
│   ├── hooks.ts              # All hook handlers (session-start, session-end, prompt, stop, post-write, post-task)
│   ├── hooks.test.ts         # Hook handler tests (colocated)
│   ├── session.ts            # Create, append, finalize session files + git notes checkpoint
│   ├── session.test.ts       # Session manager tests (colocated)
│   ├── summarize.ts          # AI summarization on session end
│   ├── knowledge.ts          # Knowledge base consolidation + mistake ledger + decision log + briefing
│   ├── knowledge.test.ts     # Knowledge tests (colocated)
│   ├── search.ts             # QMD indexing of session files (project-scoped)
│   ├── setup.ts              # Writes Claude Code hooks config + git notes ref setup
│   ├── setup.test.ts         # Setup tests (colocated)
│   ├── git.ts                # Git operations (notes, rev-parse, diff)
│   ├── env.ts                # Read Claude hook env vars
│   ├── paths.ts              # Session file paths, XDG compliance
│   └── qmd.ts                # Project-scoped QMD wrapper (--index per repo)
├── package.json
├── tsconfig.json
├── bun.lock
├── .gitignore
└── CLAUDE.md
```

Tests are colocated alongside source files (`*.test.ts`) and run with Bun's built-in test framework (`bun test`). Flat `src/` directory — no nested subdirectories unless complexity demands it.

## Runtime: Bun

Use Bun as the runtime (`bun` not `node`, `bun install` not `npm install`). It starts in ~6ms vs ~30ms for Node, which matters when every hook invocation adds latency to the agent loop.

## Package Configuration

**package.json:**

```json
{
  "name": "ghost",
  "version": "1.0.0",
  "description": "Local AI session capture & search for Claude Code",
  "type": "module",
  "bin": {
    "ghost": "./ghost"
  },
  "scripts": {
    "test": "bun test",
    "ghost": "bun src/index.ts",
    "link": "bun link"
  },
  "dependencies": {
    "yaml": "^2.8.2",
    "zod": "^4.2.1"
  },
  "devDependencies": {
    "@types/bun": "latest"
  },
  "peerDependencies": {
    "typescript": "^5.9.3"
  },
  "engines": {
    "bun": ">=1.0.0"
  },
  "license": "MIT"
}
```

Minimal dependencies. Zod for CLI arg and config validation. YAML for any structured config files. Everything else is Bun builtins, git, and QMD.

Session IDs use `crypto.randomBytes` — no nanoid dependency needed.

**tsconfig.json** (identical to qmd):

```json
{
  "compilerOptions": {
    // Environment setup & latest features
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "jsx": "react-jsx",
    "allowJs": true,

    // Bundler mode
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,

    // Best practices
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,

    // Some stricter flags (disabled by default)
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noPropertyAccessFromIndexSignature": false
  }
}
```

## Do NOT Compile

Never run `bun build --compile` — it creates a standalone binary but breaks the ability to find bun dynamically across environments. The `ghost` file is a shell wrapper script that runs `bun src/index.ts` — do not replace it.

## Shell Wrapper & Install

The `ghost` executable is a bash shell wrapper (same pattern as qmd):

```bash
#!/usr/bin/env bash
# ghost - Local AI Session Capture & Search
set -euo pipefail

# Find bun - prefer PATH, fallback to known locations
find_bun() {
  if command -v bun &>/dev/null; then
    local ver=$(bun --version 2>/dev/null || echo "0")
    if [[ "$ver" =~ ^1\. ]]; then
      command -v bun
      return 0
    fi
  fi

  : "${HOME:=$(eval echo ~)}"

  if [[ "${BASH_SOURCE[0]}" == */.bun/* ]]; then
    local bun_home="${BASH_SOURCE[0]%%/.bun/*}/.bun"
    if [[ -x "$bun_home/bin/bun" ]]; then
      echo "$bun_home/bin/bun"
      return 0
    fi
  fi

  local candidates=(
    "$HOME/.local/share/mise/installs/bun/latest/bin/bun"
    "$HOME/.local/share/mise/shims/bun"
    "$HOME/.asdf/shims/bun"
    "/opt/homebrew/bin/bun"
    "/usr/local/bin/bun"
    "$HOME/.bun/bin/bun"
  )
  for c in "${candidates[@]}"; do
    [[ -x "$c" ]] && { echo "$c"; return 0; }
  done

  return 1
}

BUN=$(find_bun) || { echo "Error: bun not found. Install from https://bun.sh" >&2; exit 1; }

SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"

exec "$BUN" "$SCRIPT_DIR/src/index.ts" "$@"
```

**Install globally:**

```bash
bun link    # Makes `ghost` available system-wide
```

## Code Style & Conventions

Follow the same patterns as qmd:

- **camelCase** for functions and variables: `createSession()`, `projectIndex()`
- **PascalCase** for types and interfaces: `type SessionConfig`, `interface HookEvent`
- **UPPER_SNAKE_CASE** for constants: `SESSION_DIR`, `HOOK_TIMEOUT_MS`, `DEFAULT_SUMMARY_PROMPT`
- **Section separators** between logical sections in files:
  ```typescript
  // =============================================================================
  // Session Management
  // =============================================================================
  ```
- **JSDoc comments** for exported functions explaining purpose
- **Strict TypeScript** — all exports explicitly typed, `noUncheckedIndexedAccess` enabled
- **async/await** throughout — no callbacks, no `.then()` chains
- **CLI argument parsing** via `util.parseArgs` (built into Bun/Node) — no third-party CLI framework
- **Error handling** via try/catch in CLI commands, silent failures in hooks
- **No ESLint or Prettier** — keep it simple, match the existing style by eye

## Testing

Tests use **Bun's built-in test framework** (`describe()`, `test()`, `expect()`):

```bash
bun test                        # Run all tests
bun test src/session.test.ts    # Specific test file
```

Test patterns:
- Each test gets a fresh temp directory for isolation
- Use environment variable overrides for paths (like qmd's `INDEX_PATH` pattern)
- CLI integration tests spawn actual `ghost` processes
- Tests must clean up after themselves

---

## Setup Phase (`ghost enable`)

Running `ghost enable` inside a git repo does the following:

### Create session storage directory

```
.ai-sessions/
├── active/          # Current in-progress session file
├── completed/       # Finalized session markdown files
├── knowledge.md     # Auto-generated project knowledge base
├── mistakes.md      # Mistake ledger
├── decisions.md     # Decision log
├── tags.json        # Tag → session ID index
└── .gitignore       # Ignore active/, keep completed/
```

### Initialize git notes ref

```bash
git config notes.displayRef refs/notes/ai-sessions
```

This makes `git log` automatically show session notes inline. No orphan branches.

### Write Claude Code hooks config

Generate `.claude/settings.json` (or merge into existing). All hooks call `ghost <event>` which dispatches to the appropriate handler.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "ghost session-start" }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "ghost session-end" }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "ghost prompt" }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "ghost stop" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          { "type": "command", "command": "ghost post-write" }
        ]
      },
      {
        "matcher": "Task",
        "hooks": [
          { "type": "command", "command": "ghost post-task" }
        ]
      }
    ]
  }
}
```

### Configure QMD MCP server (per-project)

Write to the project-level `.claude/settings.json` (not global) so the MCP server exposes session search to Claude Code:

```json
{
  "mcpServers": {
    "ghost-sessions": {
      "command": "qmd",
      "args": ["-c", "ghost-<project-name>", "mcp"]
    }
  }
}
```

Where `<project-name>` is derived from `basename $(git rev-parse --show-toplevel)`. The `-c` flag restricts search to the ghost collection for this project.

### Set up git post-commit hook

Install a standard git `post-commit` hook that runs `ghost checkpoint` asynchronously. This is the key non-blocking piece — it fires after every commit and attaches session context as a git note **in the background**:

```bash
#!/bin/sh
# .git/hooks/post-commit
ghost checkpoint &
```

The `&` is critical. The commit completes immediately. The note attachment happens after.

### QMD initial index

```bash
qmd collection add .ai-sessions/completed/ --name ghost-$(basename $(git rev-parse --show-toplevel))
qmd context add .ai-sessions/completed "AI coding session transcripts, decisions, and reasoning"
qmd embed
```

---

## Session Lifecycle

### SessionStart → `ghost session-start`

```
1. Generate session ID: YYYY-MM-DD-{crypto.randomBytes(4).toString('hex')}
2. Write session ID to .ai-sessions/active/current-id
3. Create session file: .ai-sessions/active/{session-id}.md
4. Write frontmatter:
   ---
   session: {session-id}
   branch: {current branch}
   base_commit: {HEAD sha}
   started: {ISO timestamp}
   tags: []
   ---
5. Check for recent session on same branch (<24h with open items)
   → If found, inject warm resume context (see Session Continuity below)
6. Inject condensed mistake ledger if .ai-sessions/mistakes.md exists
7. Exit 0 immediately
```

Execution budget: <50ms.

### UserPromptSubmit → `ghost prompt`

```
1. Read $CLAUDE_USER_PROMPT from env
2. Append to active session file:
   
   ## Prompt {n}
   > {user prompt text}
   
3. Exit 0
```

### PostToolUse(Write|Edit) → `ghost post-write`

```
1. Read $CLAUDE_TOOL_ARG_FILE_PATH from env
2. Append to active session file:
   
   - Modified: {filepath}
   
3. Increment file modification count in memory (for heatmap)
4. Exit 0
```

### PostToolUse(Task) → `ghost post-task`

```
1. Read task output from env if available
2. Append brief task completion note to session file
3. Exit 0
```

### Stop → `ghost stop`

This fires after each agent turn completes.

```
1. Append turn delimiter to session file:
   
   ---
   _turn completed: {timestamp}_
   
2. Snapshot current diff stat:
   git diff --stat >> session file (abbreviated)
   
3. Exit 0
```

### SessionEnd → `ghost session-end`

This is the only hook that does real work, and it still must not block.

```
1. Finalize the session file (close any open sections, write file heatmap data)
2. Fork a background process that:
   a. Generates an AI summary with tags, decisions, and mistakes (see below)
   b. Appends summary to the session file
   c. Auto-tags the session and updates tags.json
   d. Extracts decisions → appends to decisions.md
   e. Extracts mistakes → appends to mistakes.md
   f. Moves session file from active/ to completed/
   g. Attaches as git note to HEAD
   h. Indexes into project-scoped QMD
   i. Increments session counter — if threshold hit, triggers knowledge base rebuild
3. Exit 0 immediately (don't wait for background process)
```

The background process writes a PID file so `ghost status` can report if summarization is still running.

---

## Non-Blocking Guarantees

Every hook handler MUST exit in under 100ms. The rules:

1. **SessionStart, Prompt, PostWrite, PostTask, Stop**: File appends only. No network, no subprocess spawning, no git operations beyond `rev-parse`.
2. **SessionEnd**: Forks background process immediately, exits 0. All heavy work (summarize, git notes, qmd index) happens in the detached process.
3. **Post-commit hook**: Runs `ghost checkpoint &` — the ampersand ensures the commit returns instantly.
4. **If anything fails, fail silently.** A broken session log should never break the developer's workflow or block the agent.

---

## AI Summarization

On session end, the background process runs:

```typescript
// summarize.ts
async function summarize(sessionPath: string): Promise<string> {
  const result = await $`claude -p ${SUMMARY_PROMPT} < ${sessionPath}`;
  return result.stdout;
}
```

The prompt asks for a structured summary that also extracts tags, decisions, and mistakes in one pass:

```
Summarize this AI coding session. Return markdown with these sections:

## Intent
What was the developer trying to accomplish (1-2 sentences)

## Changes
Files modified and why (bullet list)

## Decisions
Key technical decisions made and reasoning. Only include significant decisions
involving architecture, technology choice, or approach selection.
Format each as:
**{short title}**: {context} → {decision} ({reasoning})

## Mistakes
Anything that went wrong, was reverted, or required multiple attempts.
Format each as:
**{short description}**: What happened → Why it failed → Correct approach

## Open Items
Anything left unfinished or flagged for follow-up

## Tags
Comma-separated topic tags inferred from the session content.
Use namespace:value format where appropriate (e.g. area:cart, type:bug-fix).
```

If `claude` CLI isn't available or the call fails, skip summarization silently. The raw session log is still valuable without it.

---

## Git Notes (Non-Blocking Checkpoint)

The checkpoint logic attaches session data to the relevant commit:

```typescript
// checkpoint.ts
async function checkpoint() {
  const sessionId = await readFile('.ai-sessions/active/current-id', 'utf8');
  const sessionPath = `.ai-sessions/completed/${sessionId.trim()}.md`;
  
  if (!existsSync(sessionPath)) return;
  
  await $`git notes --ref=ai-sessions add -f -F ${sessionPath} HEAD`;
}
```

**Why git notes:**
- No orphan branch pollution
- Attached directly to the commit they describe
- Visible in `git log` when `notes.displayRef` is configured
- Push with `git push origin refs/notes/ai-sessions`
- The semantically correct git primitive for commit metadata

**Reading notes later:**
```bash
git notes --ref=ai-sessions show abc123f    # View session for a specific commit
git log --show-notes=ai-sessions            # View all commits with session context
```

---

## QMD Integration (Per-Project Scoped)

Every project gets its own isolated QMD index. No leakage between projects.

**Collection naming:** Ghost creates a QMD collection per project, named `ghost-<repo>`:

```typescript
// qmd.ts
import { $ } from "bun";
import path from "path";

/**
 * Derive the QMD collection name from the git repo root.
 * Gives you collections like ghost-10sq, ghost-wine-direct, etc.
 */
async function collectionName(): Promise<string> {
  const root = (await $`git rev-parse --show-toplevel`.text()).trim();
  return `ghost-${path.basename(root)}`;
}
```

**Indexing on session end:**

```typescript
async function indexSession(sessionPath: string) {
  const name = await collectionName();
  await $`qmd collection add .ai-sessions/completed/ --name ${name}`;
  await $`qmd context add .ai-sessions/completed "AI coding session transcripts and reasoning"`;
  await $`qmd embed`;
}
```

**What this enables:**

Claude Code, via the QMD MCP server, can query past reasoning scoped to the current project:
- "Why did we choose that approach for fee calculation?"
- "What files did we touch when working on INP optimization?"
- "What decisions were made about the cart refactor?"
- "What's still open from last week's sessions?"

---

## Session Tagging & Topics

Tags are the filtering layer that makes everything else useful at scale.

### Auto-tagging

The summarization prompt already extracts tags. These get written into the session frontmatter:

```yaml
---
session: 2026-02-13-k8f2m9x1
branch: feature/fulfillment-retry
tags: [fulfillment, webhooks, area:api, type:bug-fix]
---
```

### Manual tagging

```bash
ghost tag k8f2m9x1 "client:10sq" "migration"
ghost tag --last "performance" "inp"
```

### Tag index

Ghost maintains `.ai-sessions/tags.json` for fast lookup without hitting QMD:

```json
{
  "fulfillment": ["2026-02-13-k8f2m9x1", "2026-02-10-m3n4o5p6"],
  "client:10sq": ["2026-02-12-a1b2c3d4"],
  "area:cart": ["2026-02-13-k8f2m9x1", "2026-02-11-q7r8s9t0"]
}
```

### Tag-scoped search

```bash
ghost search --tag "fulfillment" "retry logic"
ghost search --tag "client:10sq" "metafields"
```

Under the hood this runs `qmd query -c ghost-<project-name>` and filters results by checking frontmatter. Tags use a `namespace:value` convention for structured categorization — `client:x`, `area:cart`, `type:bug-fix`.

---

## Project Knowledge Base

### Problem

Claude starts every session cold. On a large project it spends the first 5-10 minutes re-reading files, re-discovering architecture, re-learning conventions. CLAUDE.md helps but it's static and manually maintained. The real knowledge lives in past sessions — what was tried, what failed, what patterns emerged — and Claude can't access any of it.

### Design: `ghost knowledge`

A persistent, auto-maintained knowledge base per project that distills session history into structured reference material. CLAUDE.md that writes itself.

After every N sessions (configurable, default 5) or on demand via `ghost knowledge build`, Ghost runs a consolidation pass:

```
1. Read all completed session summaries
2. Read current .ai-sessions/knowledge.md (if exists)
3. Prompt Claude to merge new session learnings into the knowledge base
4. Write updated knowledge.md
5. Index into project-scoped QMD
```

The knowledge base has fixed sections:

```markdown
# Project Knowledge Base
_Auto-generated by Ghost. Last updated: 2026-02-13_

## Architecture
- Shopify Plus store with custom checkout extensions
- Cart logic in src/cart/, uses strategy pattern for fee calculation
- Fulfillment handled by custom app at src/fulfillment-app/

## Conventions
- All monetary values stored as integers (cents)
- Shopify metafields prefixed with `app--custom.`
- Tests colocated in __tests__/ directories

## Key Decisions
- Chose percentage-based fees over tiered (2026-02-13, session k8f2m9x1)
- Kept Liquid for PDP, moved collection pages to sections (2026-02-10)
- Rejected headless approach for checkout — native performs better (2026-02-08)

## Gotchas
- API rate limits hit at ~40 req/s during bulk metafield updates
- Fulfillment webhook fires twice on partial fulfillment — dedupe by order ID
- Don't use cart.js API for bundles, use AJAX API with sections

## Patterns That Work
- For complex Liquid: break into snippets <50 lines, test with theme check
- For metafield migrations: batch via GraphQL admin, not REST
- For INP: defer all non-critical JS to requestIdleCallback

## Open Threads
- Tax interaction with percentage fees still untested
- Need to verify Flow triggers on custom fulfillment events
```

### CLAUDE.md injection

```bash
ghost knowledge build          # Rebuild now
ghost knowledge inject         # Symlink/append to CLAUDE.md
ghost knowledge show           # Print current knowledge base
ghost knowledge diff           # Show what changed since last build
```

`ghost knowledge inject` appends an include reference to CLAUDE.md or symlinks the knowledge file so the agent picks it up automatically. Every new session starts warm.

### QMD integration

The knowledge base gets indexed into the project's ghost collection:

```bash
qmd context add .ai-sessions/knowledge.md "Project knowledge base — architecture, conventions, decisions, gotchas"
qmd update
qmd embed
```

---

## Mistake Ledger

### Problem

Claude makes the same mistakes repeatedly across sessions. It'll try an approach that was already tried and rejected, or hit a known API quirk that was debugged two weeks ago. There's no negative feedback loop.

### Design

A dedicated file `.ai-sessions/mistakes.md` that captures things that went wrong and shouldn't be repeated.

**Auto-captured:** The summarization prompt specifically extracts mistakes. Ghost appends new entries to the ledger.

**Manual capture:**

```bash
ghost mistake "Don't use cart.js API for bundles — it silently drops line properties over 250 chars. Use AJAX sections API instead."
```

**Injection on session start:** When `SessionStart` fires, Ghost checks if mistakes.md exists and injects a condensed version into the session file header:

```markdown
---
session: 2026-02-14-x9y8z7w6
---

> ⚠️ Known project pitfalls (12 entries):
> - cart.js API drops line properties >250 chars — use AJAX sections API
> - Fulfillment webhook fires twice on partial — dedupe by order ID
> - Flow custom triggers require app proxy, not direct API
```

This is the negative knowledge base. Equally valuable to knowing what works.

---

## Decision Log

### Problem

On long-running projects, "why did we do it this way?" becomes unanswerable. The reasoning is buried in session transcripts nobody will re-read.

### Design

A standalone decision log at `.ai-sessions/decisions.md` capturing architectural and technical decisions in ADR-lite format:

```markdown
## 2026-02-13: Percentage fees with hard cap
**Context:** Client wanted flexible fee structure.
**Decision:** Percentage with $50 hard cap for orders >$500.
**Reasoning:** Simpler, client preferred it, tiered adds complexity with no UX benefit.
**Session:** k8f2m9x1

## 2026-02-10: Keep Liquid for PDP
**Context:** Considered moving PDP to headless React.
**Decision:** Stay on Liquid with section-based architecture.
**Reasoning:** PDP performance is already good. Migration cost not justified.
**Session:** m3n4o5p6
```

**Auto-captured:** The summarization prompt extracts significant decisions (architecture, technology choice, approach selection). Ghost appends them to the log.

**CLI access:**

```bash
ghost decisions                          # Show all
ghost decisions --tag "area:checkout"    # Filter by tag
ghost search --decisions "fee structure" # QMD search scoped to decisions
```

---

## Session Continuity (Warm Resume)

### Problem

Starting a new Claude Code session means losing all conversational context. The agent rebuilds its mental model from scratch.

### Design

On `SessionStart`, Ghost checks if there's a recent session on the same branch (within 24 hours, with open items) and auto-generates a continuity block injected at the top of the new session file:

```markdown
## Context from Previous Session (2026-02-13-k8f2m9x1)

**What we were doing:** Migrating cart fee calculation from fixed to percentage-based.

**Where we left off:** Fee calculation works. Tests pass. Still need to:
- Update metafield sync to include fee strategy
- Test tax interaction with percentage fees
- Update checkout extension to read new fee format

**Files we were working in:**
- src/cart/fees.ts (main changes)
- src/cart/types.ts (new FeeStrategy type)
- src/cart/__tests__/fees.test.ts

**Key decisions made:**
- Percentage with hard cap over tiered (simpler, client preferred)
- Backward compat: default strategy to 'percentage' if unset

**Watch out for:**
- Fee cap logic has an edge case at exactly $500 — boundary test is fragile
```

This also gets optionally auto-appended to CLAUDE.md so the agent picks it up immediately. No manual "continue where we left off" prompting needed.

**Manual resume:**

```bash
ghost resume            # Generate context handoff from last session on this branch
ghost resume k8f2m9x1   # Resume from a specific session
```

---

## Scope Briefing

### Problem

The biggest accelerator for Claude is starting a session with the right context already loaded. On a project with 500+ files, the agent reads the wrong things first.

### Design: `ghost brief`

Before starting work, generate a scoped context brief:

```bash
ghost brief "I need to add a new payment method to checkout"
```

Ghost does the following:
1. Searches QMD for relevant past sessions
2. Pulls relevant decisions from the decision log
3. Checks the mistake ledger for related gotchas
4. Runs the file heatmap for related tags
5. Synthesizes a brief:

```markdown
## Brief: Adding a New Payment Method

### Relevant Past Work
- Session k8f2m9x1 (2026-02-10): Integrated Afterpay via checkout extension
- Session m3n4o5p6 (2026-01-28): Fixed payment method display ordering bug

### Key Files
- src/checkout/extensions/payment-methods.ts (31 changes across sessions)
- src/checkout/extensions/payment-config.json
- src/shopify-app/api/payment-customize.ts

### Relevant Decisions
- Payment methods configured via metafields, not hardcoded (2026-01-15)
- Custom payment apps must use Payment Customization API, not Functions (2026-01-20)

### Watch Out For
- Payment method ordering is fragile — test with 3+ methods enabled
- Checkout extension sandbox doesn't support all Payment API fields in dev mode

### Suggested Starting Point
Start with payment-methods.ts and the Payment Customization API docs.
```

This is the "you are an expert on this project" context packet. Paste it as your first prompt or have Ghost auto-inject it.

---

## File Heat Map

Ghost tracks file modification frequency across all sessions from the `PostToolUse(Write|Edit)` data:

```bash
ghost heatmap
```

```
 42 changes │ src/cart/fees.ts
 38 changes │ src/cart/types.ts
 31 changes │ src/checkout/extensions/fee-display.ts
 28 changes │ src/fulfillment-app/webhooks/order.ts
 15 changes │ src/theme/sections/product.liquid
  9 changes │ src/utils/shopify-api.ts
```

**Per-tag heatmaps:**

```bash
ghost heatmap --tag "fulfillment"    # Which files matter for fulfillment work?
ghost heatmap --json --top 20        # Structured output for context injection
```

The heatmap feeds into both the knowledge base build and scope briefings. The "Architecture" section of the knowledge base auto-references which files are central vs peripheral.

---

## Session Diff Attribution

Ghost tracks prompt → file change mappings in order during the session:

```markdown
## Prompt 1 → Changes
> Refactor fee calculation to percentage-based

- src/cart/fees.ts (lines 42-89)
- src/cart/types.ts (lines 1-15)

## Prompt 2 → Changes
> Fix the edge case for orders over $500

- src/cart/fees.ts (lines 67-72)
- src/cart/__tests__/fees.test.ts (lines 30-45)
```

On `ghost show <commit>`, this renders as an annotated diff — each hunk attributed to the prompt that caused it.

---

## Session File Format

```markdown
---
session: 2026-02-13-k8f2m9x1
branch: feature/cart-fees
base_commit: a1b2c3d4e5f6
started: 2026-02-13T09:30:00+11:00
ended: 2026-02-13T10:15:00+11:00
tags: [area:cart, fees, type:refactor]
---

> ⚠️ Known project pitfalls (8 entries):
> - cart.js API drops line properties >250 chars — use AJAX sections API
> - Fulfillment webhook fires twice on partial — dedupe by order ID

## Context from Previous Session (2026-02-12-p4q5r6s7)
**Where we left off:** Scoped out the fee migration, decided on percentage-based approach.
**Open items:** Implementation not started.

## Prompt 1
> Refactor the cart to use percentage-based fees instead of fixed amounts

- Modified: src/cart/fees.ts
- Modified: src/cart/types.ts
- Modified: src/cart/__tests__/fees.test.ts

---
_turn completed: 2026-02-13T09:35:12+11:00_

## Prompt 2
> The fee calculation is wrong for orders over $500, there should be a cap

- Modified: src/cart/fees.ts
- Modified: src/cart/__tests__/fees.test.ts

---
_turn completed: 2026-02-13T09:41:30+11:00_

## Summary

### Intent
Migrate cart fee system from fixed dollar amounts to percentage-based with a cap for high-value orders.

### Changes
- `src/cart/fees.ts` — Replaced fixed fee lookup with percentage calc, added $50 cap for orders >$500
- `src/cart/types.ts` — Added `FeeStrategy` type union
- `src/cart/__tests__/fees.test.ts` — Added edge case tests for cap boundary

### Decisions
**Percentage with hard cap over tiered:** Client wanted flexible fees. Chose percentage with $50 cap — simpler, client preferred, tiered adds complexity with no UX benefit.

### Mistakes
_None this session._

### Open Items
- Need to update metafield sync to include fee strategy
- Tax interaction with percentage fees untested

### Tags
area:cart, fees, type:refactor, percentage-fees
```

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `ghost enable` | Run setup phase. Idempotent — safe to run multiple times. |
| `ghost disable` | Remove hooks from `.claude/settings.json`. Leave session files intact. |
| `ghost status` | Current session ID, completed count, QMD index status, background process state. |
| `ghost search <query>` | Shortcut for `qmd query -c ghost-<project-name> <query>`. Project-scoped. |
| `ghost search --tag <tag> <query>` | Tag-filtered search. |
| `ghost search --decisions <query>` | Search scoped to decision log. |
| `ghost log` | Pretty-print recent sessions with summaries. |
| `ghost show <commit-sha>` | Display session note attached to a specific commit. |
| `ghost tag <session-id> <tags...>` | Add tags to a session. |
| `ghost tag --last <tags...>` | Tag the most recent session. |
| `ghost knowledge build` | Rebuild project knowledge base from all sessions. |
| `ghost knowledge inject` | Symlink/append knowledge base to CLAUDE.md. |
| `ghost knowledge show` | Print current knowledge base. |
| `ghost knowledge diff` | Show what changed since last build. |
| `ghost mistake "<description>"` | Manually add entry to mistake ledger. |
| `ghost decisions` | Show all decisions. Supports `--tag` filter. |
| `ghost resume` | Generate context handoff from last session on this branch. |
| `ghost resume <session-id>` | Resume from a specific session. |
| `ghost brief "<description>"` | Generate scoped context brief for upcoming work. |
| `ghost heatmap` | Show file modification frequency across sessions. |
| `ghost stats` | Session metrics and trends. |
| `ghost reindex` | Rebuild the project's QMD collection from all completed sessions. |

---

## Metrics (`ghost stats`)

```bash
ghost stats
```

```
Sessions (last 30 days): 47
Avg session duration:     23 min
Avg prompts per session:  6.2
Files modified:           142 unique
Top areas:                cart (34%), checkout (28%), fulfillment (18%)
Mistakes logged:          8
Decisions recorded:       12
Knowledge base entries:   45

Trend: Session duration ↓12% vs previous 30 days
Trend: Prompts per session ↓8% (agent needs less guidance)
```

```bash
ghost stats --json              # For dashboards
ghost stats --tag "area:cart"   # Per-area stats
ghost stats --since 2026-01-01  # Date range
```

---

## Implementation Priority

| Phase | Feature | Why |
|-------|---------|-----|
| **Core** | Session capture + QMD search (project-scoped) | Foundation — everything else builds on this |
| **P1** | Knowledge base auto-generation | Biggest impact on context loss problem |
| **P1** | Session tagging (auto + manual) | Makes everything else filterable |
| **P1** | Warm resume / continuity | Immediate quality of life improvement |
| **P2** | Mistake ledger | Prevents repeated failures |
| **P2** | Decision log | Long-term project memory |
| **P2** | Scope briefing | The "10x accelerator" feature |
| **P3** | File heat map | Nice to have, improves briefings |
| **P3** | Diff attribution | Useful for code review |
| **P3** | Metrics | For proving ROI and refining workflows |

---

## Future Considerations

- **Multi-worktree support**: Each worktree gets its own active session directory. Use `git rev-parse --git-dir` to scope correctly. The QMD index is still per-project (shared across worktrees of the same repo).
- **Session linking**: If a session spans multiple commits, link the notes together via a shared session ID in the frontmatter.
- **CLAUDE.md injection**: On session start, optionally prepend a "recent context" section to CLAUDE.md with the last session's summary, giving the agent warm-start context.
- **Pruning**: `ghost prune --older-than 30d` to clean up old session files and re-index the project's QMD index.

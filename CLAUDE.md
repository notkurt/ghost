# Ghost - Local AI Session Capture & Search

Use Bun instead of Node.js (`bun` not `node`, `bun install` not `npm install`).

## Commands

```sh
ghost enable              # Set up hooks, dirs, git notes, QMD collection
ghost enable -f           # Auto-install missing dependencies
ghost enable --genesis    # Also build initial knowledge base from codebase
ghost disable             # Remove hooks, keep session files
ghost status              # Current session, counts, QMD status
ghost search <query>      # QMD search across sessions
ghost log                 # Recent sessions with summaries
ghost show <commit>       # Session note for a commit
ghost tag <id> <tags...>  # Tag a session
ghost knowledge build     # Rebuild knowledge base
ghost knowledge inject    # Append to CLAUDE.md
ghost genesis             # Build initial knowledge base from codebase
ghost edit <file>         # Edit knowledge, mistakes, or decisions
ghost mistake "desc"      # Add to mistake ledger
ghost decisions           # Show decision log
ghost resume [id]         # Context handoff from previous session
ghost brief "desc"        # Scoped context brief
ghost heatmap             # File modification frequency
ghost stats               # Session metrics
ghost validate            # Check session files for formatting errors
ghost validate -f         # Auto-fix fixable formatting issues
ghost reindex             # Rebuild QMD collection
```

## Development

```sh
bun src/index.ts <command>  # Run from source
bun test                    # Run all tests
bun run typecheck           # TypeScript type checking
bun run format              # Auto-format with Biome
bun run lint                # Biome linting + format check
bun run lint:fix            # Auto-fix lint + format issues
bun run check               # Run all checks (typecheck + lint + test)
bun link                    # Install globally as 'ghost'
```

Always run `bun run check` before committing to ensure typecheck, lint, and tests all pass. CI runs these same checks on push and PR.

## Architecture

- Sessions stored as markdown in `.ai-sessions/{active,completed}/`
- Git notes on `refs/notes/ai-sessions` for commit attribution
- QMD collection `ghost-<repo>` for semantic search
- Claude Code hooks for non-blocking capture (<50ms per hook)
- AI summarization via `claude -p` on session end (background process)

## Important

- Never run `bun build --compile` — it overwrites the shell wrapper
- The `ghost` file is a shell script that runs `bun src/index.ts` — do not replace it
- All hook handlers must exit in <100ms
- SessionEnd forks background work, exits immediately
- If anything fails in a hook, fail silently — never block the agent

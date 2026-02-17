import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkAllDeps,
  checkBrewSqlite,
  getMissingDeps,
  installBrewSqlite,
  installQmd,
  printDepsReport,
  resetDepCache,
} from "./deps.js";
import { configSet } from "./git.js";
import { activeDir, completedDir, SESSION_DIR } from "./paths.js";
import { collectionExists, collectionName, createCollection } from "./qmd.js";

// =============================================================================
// Terminal Colors
// =============================================================================

const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const c = {
  reset: useColor ? "\x1b[0m" : "",
  dim: useColor ? "\x1b[2m" : "",
  bold: useColor ? "\x1b[1m" : "",
  cyan: useColor ? "\x1b[36m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  green: useColor ? "\x1b[32m" : "",
  red: useColor ? "\x1b[31m" : "",
};

// =============================================================================
// Hook Configuration
// =============================================================================

const GHOST_HOOKS = {
  hooks: {
    SessionStart: [
      {
        matcher: "",
        hooks: [{ type: "command", command: "ghost session-start" }],
      },
    ],
    SessionEnd: [
      {
        matcher: "",
        hooks: [{ type: "command", command: "ghost session-end" }],
      },
    ],
    UserPromptSubmit: [
      {
        matcher: "",
        hooks: [{ type: "command", command: "ghost prompt" }],
      },
    ],
    Stop: [
      {
        matcher: "",
        hooks: [{ type: "command", command: "ghost stop" }],
      },
    ],
    PostToolUse: [
      {
        matcher: "Write|Edit",
        hooks: [{ type: "command", command: "ghost post-write" }],
      },
      {
        matcher: "Task",
        hooks: [{ type: "command", command: "ghost post-task" }],
      },
    ],
  },
};

// =============================================================================
// Enable
// =============================================================================

/** Set up ghost in the current git repo */
export async function enable(root: string, opts?: { install?: boolean; genesis?: boolean }): Promise<void> {
  // 1. Check dependencies
  console.log(`${c.bold}Checking dependencies...${c.reset}`);
  let report = await checkAllDeps();
  const missing = getMissingDeps(report);

  if (missing.length > 0 && opts?.install) {
    // Auto-install missing deps
    if (!report.sqlite.available && process.platform === "darwin") {
      await installBrewSqlite();
    }
    if (!report.qmd.available) {
      // sqlite is a prerequisite for qmd on macOS
      if (process.platform === "darwin") {
        const sqliteCheck = await checkBrewSqlite();
        if (!sqliteCheck.available) {
          console.log(`${c.yellow}  sqlite required for qmd. Installing...${c.reset}`);
          await installBrewSqlite();
        }
      }
      await installQmd();
    }
    // Refresh the report after installs
    resetDepCache();
    report = await checkAllDeps();
  }

  printDepsReport(report);

  if (!report.qmd.available && !opts?.install) {
    console.log(`\n${c.yellow}  qmd not found. Run with --force to auto-install:${c.reset}`);
    console.log(`    ghost enable -f`);
    console.log(`  ${c.dim}Or install manually: bun install -g github:tobi/qmd${c.reset}`);
  }

  if (!report.claude.available) {
    console.log(`\n${c.yellow}  claude CLI not found. AI summarization will be disabled.${c.reset}`);
    console.log(`  ${c.dim}Install: https://claude.ai/download${c.reset}`);
  }

  // 2. Create session storage directories
  mkdirSync(activeDir(root), { recursive: true });
  mkdirSync(completedDir(root), { recursive: true });

  // 3. Ensure .ai-sessions/ is in the project's .gitignore
  ensureGitignored(root);

  // 4. Configure git notes display
  await configSet("notes.displayRef", "refs/notes/ai-sessions");

  // 5. Merge hooks into .claude/settings.json
  const claudeDir = join(root, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, "settings.json");
  const settings = readSettings(settingsPath);
  mergeHooks(settings, GHOST_HOOKS.hooks);

  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

  // 6. Add QMD MCP server config to .mcp.json (only if qmd is available)
  const name = await collectionName(root);
  if (report.qmd.available) {
    const mcpPath = join(root, ".mcp.json");
    const mcpConfig = readSettings(mcpPath);
    if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
    mcpConfig.mcpServers["ghost-sessions"] = {
      type: "stdio",
      command: "qmd",
      args: ["-c", name, "mcp"],
    };
    writeFileSync(mcpPath, `${JSON.stringify(mcpConfig, null, 2)}\n`);
  }

  // 7. Inject Ghost header into CLAUDE.md
  injectClaudeHeader(root);

  // 8. Install git post-commit hook
  const hooksDir = join(root, ".git", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const postCommitPath = join(hooksDir, "post-commit");
  const hookContent = '#!/bin/sh\nexport PATH="$HOME/.bun/bin:$PATH"\nghost checkpoint &\n';
  if (existsSync(postCommitPath)) {
    const existing = readFileSync(postCommitPath, "utf8");
    if (!existing.includes("ghost checkpoint")) {
      writeFileSync(postCommitPath, `${existing.trimEnd()}\nexport PATH="$HOME/.bun/bin:$PATH"\nghost checkpoint &\n`);
    }
  } else {
    writeFileSync(postCommitPath, hookContent);
  }
  const { chmod } = await import("node:fs/promises");
  await chmod(postCommitPath, 0o755);

  // 9. Create initial QMD collection (if available)
  let qmdOk = false;
  if (report.qmd.available) {
    qmdOk = await createCollection(root);
  }

  // 10. Report results
  console.log(`\n${c.green}Ghost enabled.${c.reset}`);
  console.log(`  ${c.bold}Session dir:${c.reset}  ${SESSION_DIR}/`);
  console.log(`  ${c.bold}Hooks:${c.reset}        .claude/settings.json`);
  console.log(`  ${c.bold}Git notes:${c.reset}    refs/notes/ai-sessions`);
  if (report.qmd.available) {
    console.log(
      `  ${c.bold}QMD:${c.reset}          ${name}${qmdOk ? ` ${c.green}(created)${c.reset}` : ` ${c.red}(failed to create)${c.reset}`}`,
    );
    console.log(`  ${c.bold}MCP server:${c.reset}   ghost-sessions`);
  } else {
    console.log(`  ${c.bold}QMD:${c.reset}          ${c.yellow}not installed${c.reset} (search disabled)`);
  }
  if (report.claude.available) {
    console.log(`  ${c.bold}Summarize:${c.reset}    ${c.green}enabled${c.reset} (claude CLI found)`);
  } else {
    console.log(`  ${c.bold}Summarize:${c.reset}    ${c.yellow}disabled${c.reset} (claude CLI not found)`);
  }

  // 11. Initialize shared knowledge branch and pull team knowledge
  try {
    const { initSharedBranch, pullShared } = await import("./sync.js");
    const branchOk = await initSharedBranch(root);
    if (branchOk) {
      await pullShared(root);
      console.log(`  ${c.bold}Shared:${c.reset}       ghost/knowledge ${c.green}(synced)${c.reset}`);
    } else {
      console.log(`  ${c.bold}Shared:${c.reset}       ghost/knowledge ${c.yellow}(skipped)${c.reset}`);
    }
  } catch {
    console.log(`  ${c.bold}Shared:${c.reset}       ghost/knowledge ${c.yellow}(skipped)${c.reset}`);
  }

  // 12. Optional genesis — build initial knowledge base from codebase + absorb CLAUDE.md
  if (opts?.genesis && report.claude.available) {
    console.log("");
    const { absorb, genesis, injectKnowledge } = await import("./knowledge.js");
    // Absorb existing CLAUDE.md into knowledge files first
    try {
      const claudeMdPath = join(root, "CLAUDE.md");
      if (existsSync(claudeMdPath) && readFileSync(claudeMdPath, "utf8").trim()) {
        await absorb(root);
      }
    } catch {
      // absorb is best-effort during enable
    }
    // Then build knowledge from codebase
    const built = await genesis(root);
    if (built) {
      await injectKnowledge(root);
    }
  } else if (opts?.genesis && !report.claude.available) {
    console.log(`\n${c.yellow}Skipping genesis — claude CLI required.${c.reset}`);
  }

  // 13. Next-steps guidance
  console.log(`
${c.bold}Next steps:${c.reset}
  Start a Claude Code session — Ghost will capture it automatically.
  Then try:
    ${c.cyan}ghost status${c.reset}        Check capture status
    ${c.cyan}ghost log${c.reset}           View recent sessions
    ${c.cyan}ghost search <q>${c.reset}    Search past sessions`);
}

// =============================================================================
// Disable
// =============================================================================

/** Remove ghost hooks from Claude settings. Leaves session files intact. */
export async function disable(root: string): Promise<void> {
  const settingsPath = join(root, ".claude", "settings.json");
  if (!existsSync(settingsPath)) {
    console.log("Ghost is not enabled in this repo.");
    return;
  }

  const settings = readSettings(settingsPath);

  // Remove ghost hooks
  if (settings.hooks) {
    for (const [event, matchers] of Object.entries(settings.hooks)) {
      if (Array.isArray(matchers)) {
        settings.hooks[event] = matchers
          .map((m: any) => ({
            ...m,
            hooks: Array.isArray(m.hooks) ? m.hooks.filter((h: any) => !h.command?.startsWith("ghost ")) : m.hooks,
          }))
          .filter((m: any) => Array.isArray(m.hooks) && m.hooks.length > 0);
        if (settings.hooks[event].length === 0) {
          delete settings.hooks[event];
        }
      }
    }
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }
  }

  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

  // Remove ghost MCP server from .mcp.json
  const mcpPath = join(root, ".mcp.json");
  if (existsSync(mcpPath)) {
    const mcpConfig = readSettings(mcpPath);
    if (mcpConfig.mcpServers?.["ghost-sessions"]) {
      delete mcpConfig.mcpServers["ghost-sessions"];
      if (Object.keys(mcpConfig.mcpServers).length === 0) {
        delete mcpConfig.mcpServers;
      }
      writeFileSync(mcpPath, `${JSON.stringify(mcpConfig, null, 2)}\n`);
    }
  }

  // Remove Ghost header from CLAUDE.md
  removeClaudeHeader(root);

  console.log("Ghost disabled. Session files preserved in .ai-sessions/");
}

// =============================================================================
// Status
// =============================================================================

/** Show ghost status for the current repo */
export async function status(root: string): Promise<void> {
  const { getActiveSessionId, listCompletedSessions } = await import("./session.js");

  const activeId = getActiveSessionId(root);
  const completed = listCompletedSessions(root);
  const pidFile = join(root, SESSION_DIR, ".background.pid");
  const bgRunning = existsSync(pidFile);

  console.log(`${c.bold}Active session:${c.reset}    ${activeId || "none"}`);
  console.log(`${c.bold}Completed:${c.reset}         ${completed.length} sessions`);
  console.log(`${c.bold}Background:${c.reset}        ${bgRunning ? "running" : "idle"}`);

  // Check if hooks are configured
  const settingsPath = join(root, ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    const settings = readSettings(settingsPath);
    const hasHooks = settings.hooks?.SessionStart?.some((m: any) =>
      m.hooks?.some((h: any) => h.command?.startsWith("ghost ")),
    );
    console.log(
      `${c.bold}Hooks:${c.reset}             ${hasHooks ? `${c.green}configured${c.reset}` : `${c.yellow}not configured${c.reset}`}`,
    );
  } else {
    console.log(`${c.bold}Hooks:${c.reset}             ${c.yellow}not configured${c.reset}`);
  }

  // Check dependencies
  const report = await checkAllDeps();
  const name = await collectionName(root);

  if (report.qmd.available) {
    const hasCollection = await collectionExists(root);
    console.log(
      `${c.bold}QMD:${c.reset}               ${c.green}installed${c.reset}, collection ${name} ${hasCollection ? `${c.green}exists${c.reset}` : `${c.yellow}missing${c.reset}`}`,
    );
  } else {
    console.log(`${c.bold}QMD:${c.reset}               ${c.red}not installed${c.reset} (search disabled)`);
  }

  console.log(
    `${c.bold}Claude CLI:${c.reset}        ${report.claude.available ? `${c.green}available${c.reset}` : `${c.yellow}not found${c.reset} (summarization disabled)`}`,
  );

  // Check shared branch status
  try {
    const { branchExists } = await import("./git.js");
    const exists = await branchExists("ghost/knowledge", root);
    console.log(
      `${c.bold}Shared branch:${c.reset}     ${exists ? `${c.green}ghost/knowledge${c.reset}` : `${c.yellow}not initialized${c.reset}`}`,
    );
  } catch {
    // ignore
  }

  // Show last background log lines
  const bgLogFile = join(root, SESSION_DIR, ".background.log");
  if (existsSync(bgLogFile)) {
    try {
      const logContent = readFileSync(bgLogFile, "utf8").trim();
      if (logContent) {
        const lines = logContent.split("\n");
        const lastLines = lines.slice(-5);
        console.log(`\n${c.bold}Last background run:${c.reset}`);
        for (const line of lastLines) {
          console.log(`  ${c.dim}${line}${c.reset}`);
        }
      }
    } catch {
      // ignore
    }
  }
}

// =============================================================================
// Reset
// =============================================================================

/** Wipe all session data, git notes, and QMD collection. Keeps ghost enabled. */
export async function reset(root: string): Promise<void> {
  const dir = join(root, SESSION_DIR);
  if (!existsSync(dir)) {
    console.log("Nothing to reset — no .ai-sessions/ directory found.");
    return;
  }

  // 1. Remove everything inside .ai-sessions/
  for (const entry of readdirSync(dir)) {
    rmSync(join(dir, entry), { recursive: true, force: true });
  }

  // Re-create directory structure
  mkdirSync(activeDir(root), { recursive: true });
  mkdirSync(completedDir(root), { recursive: true });
  console.log(`  ${c.green}✓${c.reset} Session files cleared`);

  // 2. Remove git notes ref
  try {
    const { $ } = await import("bun");
    await $`git notes --ref=ai-sessions prune`.quiet();
    // Remove the entire notes ref
    await $`git update-ref -d refs/notes/ai-sessions`.quiet();
    console.log(`  ${c.green}✓${c.reset} Git notes removed`);
  } catch {
    // Notes ref may not exist
  }

  // 3. Delete QMD collection
  try {
    const { collectionName, isQmdAvailable, removeCollection } = await import("./qmd.js");
    if (await isQmdAvailable()) {
      const name = await collectionName(root);
      await removeCollection(name);
      console.log(`  ${c.green}✓${c.reset} QMD collection removed`);
    }
  } catch {
    // QMD may not be available
  }

  console.log(`\n${c.green}Ghost reset.${c.reset} All session data cleared. Hooks still active.`);
}

// =============================================================================
// Helpers
// =============================================================================

function readSettings(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/** Add .ai-sessions/ to the project's root .gitignore if not already present */
function ensureGitignored(root: string): void {
  const gitignorePath = join(root, ".gitignore");
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf8");
    if (content.includes(".ai-sessions")) return;
    appendFileSync(gitignorePath, "\n# Ghost session data (local only)\n.ai-sessions/\n");
  } else {
    writeFileSync(gitignorePath, "# Ghost session data (local only)\n.ai-sessions/\n");
  }
}

// =============================================================================
// CLAUDE.md Header
// =============================================================================

const GHOST_HEADER_SENTINEL = "<!-- ghost:header -->";

const GHOST_HEADER = `${GHOST_HEADER_SENTINEL}
## Ghost — AI Session Memory

**ALWAYS search Ghost before reading code or grepping.** When asked about a feature, bug, scenario,
or component — your FIRST action must be a Ghost search. Past sessions contain architecture decisions,
dead ends, failed approaches, and reasoning that code cannot reveal. Do not skip this step.

Use the \`ghost-sessions\` MCP tool with \`deep_search\` (not \`search\`). Fallback CLI commands:

| Command | Purpose |
|---------|---------|
| \`ghost search <query>\` | Semantic search across past sessions |
| \`ghost show <session-id>\` | Read a specific session |
| \`ghost log\` | Recent sessions with summaries |
| \`ghost decisions\` | Decision log |
| \`ghost decision "desc"\` | Log a technical decision mid-session |
| \`ghost mistake "desc"\` | Log a mistake or gotcha mid-session |
| \`ghost knowledge "desc"\` | Log an insight or pattern mid-session |
| \`ghost strategy "desc"\` | Log a trade-off explored mid-session |
${GHOST_HEADER_SENTINEL}`;

/** Inject or replace Ghost header at the top of CLAUDE.md */
function injectClaudeHeader(root: string): void {
  const claudeMdPath = join(root, "CLAUDE.md");
  if (existsSync(claudeMdPath)) {
    let content = readFileSync(claudeMdPath, "utf8");
    const headerRe = new RegExp(`${GHOST_HEADER_SENTINEL}[\\s\\S]*?${GHOST_HEADER_SENTINEL}\\n*`);
    if (headerRe.test(content)) {
      // Replace existing header
      content = content.replace(headerRe, `${GHOST_HEADER}\n\n`);
    } else {
      // Prepend header
      content = `${GHOST_HEADER}\n\n${content}`;
    }
    writeFileSync(claudeMdPath, content);
  } else {
    writeFileSync(claudeMdPath, `${GHOST_HEADER}\n`);
  }
}

/** Remove Ghost header from CLAUDE.md */
function removeClaudeHeader(root: string): void {
  const claudeMdPath = join(root, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) return;
  let content = readFileSync(claudeMdPath, "utf8");
  const headerRe = new RegExp(`${GHOST_HEADER_SENTINEL}[\\s\\S]*?${GHOST_HEADER_SENTINEL}\\n*`);
  if (headerRe.test(content)) {
    content = content.replace(headerRe, "");
    writeFileSync(claudeMdPath, content);
  }
}

/** Deep merge ghost hooks into existing settings, preserving non-ghost hooks */
function mergeHooks(settings: Record<string, any>, ghostHooks: Record<string, any>): void {
  if (!settings.hooks) settings.hooks = {};

  for (const [event, ghostMatchers] of Object.entries(ghostHooks)) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = ghostMatchers;
      continue;
    }

    // Remove existing ghost hooks for this event
    const existing = settings.hooks[event] as any[];
    const nonGhost = existing.filter((m: any) => !m.hooks?.some((h: any) => h.command?.startsWith("ghost ")));

    // Add ghost hooks
    settings.hooks[event] = [...nonGhost, ...(ghostMatchers as any[])];
  }
}

#!/usr/bin/env bun
import { parseArgs } from "node:util";
import {
  PostToolUseInput,
  readHookInput,
  SessionEndInput,
  SessionStartInput,
  StopInput,
  UserPromptInput,
} from "./env.js";
import { repoRoot } from "./git.js";

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
  magenta: useColor ? "\x1b[35m" : "",
  red: useColor ? "\x1b[31m" : "",
};

// =============================================================================
// CLI Parsing
// =============================================================================

function parseCLI() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      tag: { type: "string" },
      json: { type: "boolean" },
      since: { type: "string" },
      top: { type: "string" },
      force: { type: "boolean", short: "f" },
      genesis: { type: "boolean" },
      last: { type: "boolean" },
      decisions: { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
  });
  return {
    command: positionals[0] || "",
    args: positionals.slice(1),
    query: positionals.slice(1).join(" "),
    values,
  };
}

// =============================================================================
// Help
// =============================================================================

function showHelp(): void {
  console.log(`${c.bold}ghost${c.reset} — Local AI session capture & search for Claude Code

${c.bold}Usage:${c.reset} ghost <command> [options]

${c.bold}Setup:${c.reset}
  ${c.cyan}enable${c.reset}              Set up hooks, dirs, git notes, QMD collection
  ${c.cyan}enable -f${c.reset}           Auto-install missing dependencies
  ${c.cyan}enable --genesis${c.reset}    Also build initial knowledge base from codebase
  ${c.cyan}disable${c.reset}             Remove hooks (keeps session files)
  ${c.cyan}reset${c.reset}               Clear all session data (keeps hooks)
  ${c.cyan}status${c.reset}              Current session, counts, config status
  ${c.cyan}update${c.reset}              Update ghost to latest version

${c.bold}Session hooks${c.reset} ${c.dim}(called by Claude Code):${c.reset}
  session-start       Create new session file
  session-end         Finalize session, trigger background processing
  prompt              Record user prompt
  stop                Record turn completion
  post-write          Record file modification
  post-task           Record subtask completion
  checkpoint          Attach session as git note to HEAD

${c.bold}Search & Browse:${c.reset}
  ${c.cyan}search${c.reset} <query>       Search sessions via QMD
  ${c.cyan}log${c.reset}                  List recent sessions
  ${c.cyan}show${c.reset} <commit>        Show session note for a commit
  ${c.cyan}decisions${c.reset}            Show decision log

${c.bold}Knowledge:${c.reset}
  ${c.cyan}knowledge${c.reset} build      Rebuild knowledge base from sessions
  ${c.cyan}knowledge${c.reset} inject     Append knowledge to CLAUDE.md
  ${c.cyan}knowledge${c.reset} show       Print current knowledge base
  ${c.cyan}knowledge${c.reset} diff       Show changes since last build
  ${c.cyan}genesis${c.reset}              Build initial knowledge base from codebase
  ${c.cyan}edit${c.reset} <file>          Edit knowledge, mistakes, or decisions

${c.bold}Tagging:${c.reset}
  ${c.cyan}tag${c.reset} <id> <tags...>   Add tags to a session
  ${c.cyan}tag${c.reset} --last <tags...> Tag the most recent session

${c.bold}Context:${c.reset}
  ${c.cyan}resume${c.reset} [id]          Context handoff from previous session
  ${c.cyan}brief${c.reset} "<desc>"       Generate scoped context brief
  ${c.cyan}mistake${c.reset} "<desc>"     Add to mistake ledger

${c.bold}Analytics:${c.reset}
  ${c.cyan}heatmap${c.reset}              File modification frequency
  ${c.cyan}stats${c.reset}                Session metrics and trends
  ${c.cyan}validate${c.reset}             Check session files for formatting errors
  ${c.cyan}validate -f${c.reset}          Auto-fix fixable formatting issues
  ${c.cyan}reindex${c.reset}              Rebuild QMD collection

${c.bold}Options:${c.reset}
  -v, --version       Show version
  -h, --help          Show this help
  --tag <tag>         Filter by tag
  --json              JSON output
  --since <date>      Filter by date
  --last              Use most recent session
  --decisions         Scope to decision log
  --force, -f         Force operation (auto-install deps)
  --genesis           Build initial knowledge base on enable`);
}

// =============================================================================
// Main
// =============================================================================

if (import.meta.main) {
  // Prevent infinite loop: ghost spawns `claude -p` for summarization,
  // which triggers Claude Code hooks, which call ghost again.
  if (process.env.GHOST_INTERNAL) {
    process.exit(0);
  }

  const cli = parseCLI();

  if (cli.values.version || cli.command === "version") {
    const { version } = await import("../package.json");
    console.log(version);
    process.exit(0);
  }

  if (!cli.command || cli.values.help) {
    showHelp();
    process.exit(cli.values.help ? 0 : 1);
  }

  try {
    switch (cli.command) {
      // =====================================================================
      // Hook Commands (called by Claude Code)
      // =====================================================================

      case "session-start": {
        const raw = await readHookInput();
        const input = SessionStartInput.parse(raw);
        const { handleSessionStart } = await import("./hooks.js");
        const context = await handleSessionStart(input);
        if (context) process.stdout.write(context);
        break;
      }

      case "session-end": {
        const raw = await readHookInput();
        const input = SessionEndInput.parse(raw);
        const { handleSessionEnd } = await import("./hooks.js");
        await handleSessionEnd(input);
        break;
      }

      case "prompt": {
        const raw = await readHookInput();
        const input = UserPromptInput.parse(raw);
        const { handlePrompt } = await import("./hooks.js");
        await handlePrompt(input);
        break;
      }

      case "stop": {
        const raw = await readHookInput();
        const input = StopInput.parse(raw);
        const { handleStop } = await import("./hooks.js");
        await handleStop(input);
        break;
      }

      case "post-write": {
        const raw = await readHookInput();
        const input = PostToolUseInput.parse(raw);
        const { handlePostWrite } = await import("./hooks.js");
        await handlePostWrite(input);
        break;
      }

      case "post-task": {
        const raw = await readHookInput();
        const input = PostToolUseInput.parse(raw);
        const { handlePostTask } = await import("./hooks.js");
        await handlePostTask(input);
        break;
      }

      case "checkpoint": {
        const root = await repoRoot();
        const { checkpoint } = await import("./session.js");
        await checkpoint(root);
        break;
      }

      // =====================================================================
      // User Commands
      // =====================================================================

      case "enable": {
        const root = await repoRoot();
        const { enable } = await import("./setup.js");
        await enable(root, { install: !!cli.values.force, genesis: !!cli.values.genesis });
        break;
      }

      case "disable": {
        const root = await repoRoot();
        const { disable } = await import("./setup.js");
        await disable(root);
        break;
      }

      case "reset": {
        const root = await repoRoot();
        const { reset } = await import("./setup.js");
        await reset(root);
        break;
      }

      case "status": {
        const root = await repoRoot();
        const { status } = await import("./setup.js");
        await status(root);
        break;
      }

      case "update": {
        const { resolve } = await import("node:path");
        const { existsSync } = await import("node:fs");
        const { $ } = await import("bun");
        const { version: currentVersion } = await import("../package.json");
        const ghostRoot = resolve(import.meta.dir, "..");
        const isGitClone = existsSync(resolve(ghostRoot, ".git"));

        console.log(`Current version: ${c.dim}${currentVersion}${c.reset}`);

        if (isGitClone) {
          console.log("Updating via git pull...");
          const pull = await $`git -C ${ghostRoot} pull origin main`.nothrow().quiet();
          if (pull.exitCode !== 0) {
            console.error(`${c.red}git pull failed:${c.reset} ${pull.stderr.toString()}`);
            process.exit(1);
          }
          await $`bun install --cwd ${ghostRoot}`.nothrow().quiet();
        } else {
          console.log("Reinstalling from GitHub...");
          await $`bun remove -g ghost`.nothrow().quiet();
          const install = await $`bun install -g github:notkurt/ghost#main`.nothrow().quiet();
          if (install.exitCode !== 0) {
            // Retry with cache clear
            await $`bun pm cache rm`.nothrow().quiet();
            const retry = await $`bun install -g github:notkurt/ghost#main`.nothrow().quiet();
            if (retry.exitCode !== 0) {
              console.error(
                `${c.red}Update failed.${c.reset} Try manually: git clone https://github.com/notkurt/ghost.git && cd ghost && bun install && bun link`,
              );
              process.exit(1);
            }
          }
        }

        // Read new version from disk (can't re-import cached module)
        const newPkg = JSON.parse(await Bun.file(resolve(ghostRoot, "package.json")).text());
        if (newPkg.version !== currentVersion) {
          console.log(`Updated: ${c.green}${currentVersion}${c.reset} → ${c.green}${newPkg.version}${c.reset}`);
        } else {
          console.log(`Already up to date (${c.green}${currentVersion}${c.reset}).`);
        }
        break;
      }

      case "search": {
        const _root = await repoRoot();
        const { searchSessions } = await import("./qmd.js");
        const result = await searchSessions(cli.query, { tag: cli.values.tag as string | undefined });
        if (result) {
          console.log(result);
        } else {
          console.log("No results found.");
        }
        break;
      }

      case "log": {
        const root = await repoRoot();
        const { listCompletedSessions, parseFrontmatter } = await import("./session.js");
        const { readFileSync } = await import("node:fs");
        const { completedSessionPath } = await import("./paths.js");
        const sessions = listCompletedSessions(root);
        if (sessions.length === 0) {
          console.log("No completed sessions.");
          break;
        }
        const count = Math.min(sessions.length, 20);
        for (let i = 0; i < count; i++) {
          const id = sessions[i]!;
          const path = completedSessionPath(root, id);
          const content = readFileSync(path, "utf8");
          const { frontmatter } = parseFrontmatter(content);
          const tags = (frontmatter.tags as string[]) || [];
          const tagStr = tags.length > 0 ? ` ${c.dim}[${tags.join(", ")}]${c.reset}` : "";
          console.log(`${c.cyan}${id}${c.reset} ${c.dim}${frontmatter.branch || ""}${c.reset}${tagStr}`);
        }
        if (sessions.length > count) {
          console.log(`${c.dim}... and ${sessions.length - count} more${c.reset}`);
        }
        break;
      }

      case "show": {
        const sha = cli.args[0];
        if (!sha) {
          console.error("Usage: ghost show <commit-sha>");
          process.exit(1);
        }
        const { showNote } = await import("./git.js");
        const note = await showNote(sha);
        if (note) {
          console.log(note);
        } else {
          console.log("No session note found for this commit.");
        }
        break;
      }

      case "tag": {
        const root = await repoRoot();
        const { addTags, getMostRecentCompletedId } = await import("./session.js");
        let sessionId: string | undefined;
        let tags: string[];
        if (cli.values.last) {
          sessionId = getMostRecentCompletedId(root) || undefined;
          tags = cli.args;
        } else {
          sessionId = cli.args[0];
          tags = cli.args.slice(1);
        }
        if (!sessionId || tags.length === 0) {
          console.error("Usage: ghost tag <session-id> <tags...> or ghost tag --last <tags...>");
          process.exit(1);
        }
        addTags(root, sessionId, tags);
        console.log(`Tagged ${sessionId}: ${tags.join(", ")}`);
        break;
      }

      case "knowledge": {
        const root = await repoRoot();
        const subcommand = cli.args[0];
        const { buildKnowledge, injectKnowledge, showKnowledge, diffKnowledge } = await import("./knowledge.js");
        switch (subcommand) {
          case "build":
            await buildKnowledge(root);
            break;
          case "inject":
            await injectKnowledge(root);
            break;
          case "show":
            showKnowledge(root);
            break;
          case "diff":
            diffKnowledge(root);
            break;
          default:
            console.error("Usage: ghost knowledge <build|inject|show|diff>");
            process.exit(1);
        }
        break;
      }

      case "mistake": {
        const root = await repoRoot();
        const description = cli.args.join(" ");
        if (!description) {
          console.error('Usage: ghost mistake "<description>"');
          process.exit(1);
        }
        const { appendMistake } = await import("./session.js");
        appendMistake(root, description);
        console.log("Mistake logged.");
        break;
      }

      case "decisions": {
        const root = await repoRoot();
        const { listDecisions } = await import("./session.js");
        const content = listDecisions(root, cli.values.tag as string | undefined);
        if (content) {
          console.log(content);
        } else {
          console.log("No decisions recorded.");
        }
        break;
      }

      case "resume": {
        const root = await repoRoot();
        const { findRecentSession, generateContinuityBlock } = await import("./session.js");
        const sessionId = cli.args[0] || (await findRecentSession(root));
        if (!sessionId) {
          console.log("No recent session found on this branch.");
          break;
        }
        const block = generateContinuityBlock(root, sessionId);
        if (block) {
          console.log(block);
        } else {
          console.log(`No continuity context available for session ${sessionId}.`);
        }
        break;
      }

      case "brief": {
        const root = await repoRoot();
        const description = cli.args.join(" ");
        if (!description) {
          console.error('Usage: ghost brief "<description>"');
          process.exit(1);
        }
        const { generateBrief } = await import("./knowledge.js");
        await generateBrief(root, description);
        break;
      }

      case "heatmap": {
        const root = await repoRoot();
        const { showHeatmap } = await import("./search.js");
        await showHeatmap(root, {
          tag: cli.values.tag as string | undefined,
          json: cli.values.json as boolean | undefined,
          top: cli.values.top ? parseInt(cli.values.top as string, 10) : undefined,
        });
        break;
      }

      case "stats": {
        const root = await repoRoot();
        const { showStats } = await import("./search.js");
        await showStats(root, {
          json: cli.values.json as boolean | undefined,
          tag: cli.values.tag as string | undefined,
          since: cli.values.since as string | undefined,
        });
        break;
      }

      case "edit": {
        const root = await repoRoot();
        const { sessionDir, knowledgePath, mistakesPath, decisionsPath } = await import("./paths.js");
        const target = cli.args[0];
        const paths: Record<string, string> = {
          knowledge: knowledgePath(root),
          mistakes: mistakesPath(root),
          decisions: decisionsPath(root),
        };
        if (!target || !paths[target]) {
          console.error("Usage: ghost edit <knowledge|mistakes|decisions>");
          process.exit(1);
        }
        const filePath = paths[target]!;
        // Ensure the file exists (create empty if not)
        const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
        mkdirSync(sessionDir(root), { recursive: true });
        if (!existsSync(filePath)) {
          writeFileSync(filePath, "");
        }
        // Open in $EDITOR, fall back to showing the path
        const editor = process.env.EDITOR || process.env.VISUAL;
        if (editor) {
          const { $ } = await import("bun");
          await $`${editor} ${filePath}`.quiet().nothrow();
        } else {
          console.log(filePath);
        }
        break;
      }

      case "genesis": {
        const root = await repoRoot();
        const { genesis, injectKnowledge } = await import("./knowledge.js");
        const built = await genesis(root);
        if (built) {
          await injectKnowledge(root);
        }
        break;
      }

      case "validate": {
        const root = await repoRoot();
        const { validate: validateFiles } = await import("./validate.js");
        const issues = validateFiles(root, { fix: !!cli.values.force });
        if (issues.length === 0) {
          console.log("All files valid.");
        } else {
          for (const issue of issues) {
            const fixable = issue.fixable ? ` ${c.dim}(fixable)${c.reset}` : "";
            console.log(`${c.yellow}${issue.file}${c.reset}: ${issue.message}${fixable}`);
          }
          if (issues.some((i) => i.fixable) && !cli.values.force) {
            console.log(`\nRun ${c.bold}ghost validate -f${c.reset} to auto-fix fixable issues.`);
          } else if (cli.values.force) {
            console.log(`\nFixable issues have been repaired.`);
          }
        }
        break;
      }

      case "reindex": {
        const root = await repoRoot();
        const { indexSession } = await import("./qmd.js");
        await indexSession(root);
        console.log("Reindexed.");
        break;
      }

      default:
        console.error(`Unknown command: ${cli.command}`);
        showHelp();
        process.exit(1);
    }
  } catch (err) {
    // Hook commands should fail silently, user commands should show errors
    const hookCommands = ["session-start", "session-end", "prompt", "stop", "post-write", "post-task", "checkpoint"];
    if (!hookCommands.includes(cli.command)) {
      console.error(`${c.red}Error:${c.reset} ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }
}

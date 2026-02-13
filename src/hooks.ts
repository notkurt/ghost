import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { PostToolUseInput, SessionEndInput, SessionStartInput, StopInput, UserPromptInput } from "./env.js";
import { repoRoot } from "./git.js";
import { completedSessionPath } from "./paths.js";
import {
  appendFileModification,
  appendPrompt,
  appendTaskNote,
  appendTurnDelimiter,
  buildCoModGraph,
  createSession,
  extractModifiedFiles,
  finalizeSession,
  findRecentSession,
  generateContinuityBlock,
  getActiveSessionId,
  getCoModifiedFiles,
  getRelevantDecisions,
  getRelevantMistakes,
} from "./session.js";

// =============================================================================
// Hook Handlers
// =============================================================================

/**
 * SessionStart: Create session file, inject warm resume context + relevant knowledge.
 * Returns context string via stdout (Claude sees this).
 */
export async function handleSessionStart(input: SessionStartInput): Promise<string | undefined> {
  const root = input.cwd || (await repoRoot());
  const _id = await createSession(root);

  const parts: string[] = [];

  // 1. Check for recent session on same branch for warm resume
  try {
    const recentId = await findRecentSession(root);
    if (recentId) {
      const block = generateContinuityBlock(root, recentId);
      if (block) parts.push(block);
    }
  } catch {
    // Non-critical — skip silently
  }

  // 2. Gather relevant files from git state + previous session
  let relevantFiles: string[] = [];
  try {
    const unstaged = execSync("git diff --name-only HEAD", { cwd: root, encoding: "utf8", timeout: 3000 }).trim();
    const staged = execSync("git diff --name-only --cached", { cwd: root, encoding: "utf8", timeout: 3000 }).trim();
    relevantFiles = [...new Set([...unstaged.split("\n").filter(Boolean), ...staged.split("\n").filter(Boolean)])];
  } catch {
    // No git changes or not in a git repo
  }

  // Also include previous session's files for continuity
  try {
    const recentId = await findRecentSession(root);
    if (recentId) {
      const prevPath = completedSessionPath(root, recentId);
      if (existsSync(prevPath)) {
        const prevContent = readFileSync(prevPath, "utf8");
        const prevFiles = extractModifiedFiles(prevContent);
        relevantFiles = [...new Set([...relevantFiles, ...prevFiles])];
      }
    }
  } catch {
    // Non-critical
  }

  // 3. Inject relevant mistakes (scored by file overlap + co-modification)
  try {
    const mistakes = getRelevantMistakes(root, relevantFiles);
    if (mistakes) parts.push(mistakes);
  } catch {
    // Non-critical — skip silently
  }

  // 4. Inject relevant decisions
  try {
    const decisions = getRelevantDecisions(root, relevantFiles);
    if (decisions) parts.push(decisions);
  } catch {
    // Non-critical — skip silently
  }

  // 5. Inject co-modified file warnings
  try {
    const graph = buildCoModGraph(root);
    const coMod = getCoModifiedFiles(graph, relevantFiles, 10);
    if (coMod.length > 0) {
      parts.push(
        `> Files frequently modified together with your current changes:\n${coMod.map((f) => `> - ${f}`).join("\n")}\n> Consider reviewing these for side effects.`,
      );
    }
  } catch {
    // Non-critical — skip silently
  }

  if (parts.length > 0) {
    return parts.join("\n\n");
  }
  return undefined;
}

/**
 * UserPromptSubmit: Append user prompt to active session.
 */
export async function handlePrompt(input: UserPromptInput): Promise<void> {
  const root = input.cwd || (await repoRoot());
  const prompt = input.prompt || "";
  if (prompt) {
    appendPrompt(root, prompt);
  }
}

/**
 * PostToolUse(Write|Edit): Record file modification.
 */
export async function handlePostWrite(input: PostToolUseInput): Promise<void> {
  const root = input.cwd || (await repoRoot());
  const filePath = input.tool_input?.file_path as string | undefined;
  if (filePath) {
    appendFileModification(root, filePath);
  }
}

/**
 * PostToolUse(Task): Record task completion.
 */
export async function handlePostTask(input: PostToolUseInput): Promise<void> {
  const root = input.cwd || (await repoRoot());
  const description = (input.tool_input?.description as string) || "subtask completed";
  appendTaskNote(root, description);
}

/**
 * Stop: Append turn delimiter with timestamp and diff stat.
 */
export async function handleStop(input: StopInput): Promise<void> {
  const root = input.cwd || (await repoRoot());
  await appendTurnDelimiter(root);
}

/**
 * SessionEnd: Finalize session, fork background process for heavy work.
 * Exits immediately — background process handles summarization, git notes, QMD indexing.
 */
export async function handleSessionEnd(input: SessionEndInput): Promise<void> {
  const root = input.cwd || (await repoRoot());
  const sessionId = getActiveSessionId(root);
  if (!sessionId) return;

  const completedPath = finalizeSession(root);
  if (!completedPath) return;

  // Fork detached background process for heavy work
  try {
    const scriptPath = new URL("./background.ts", import.meta.url).pathname;
    if (existsSync(scriptPath)) {
      Bun.spawn(["bun", scriptPath, root, completedPath, sessionId], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    }
  } catch {
    // If background process fails to launch, session file is still safely in completed/
  }
}

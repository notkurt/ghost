import { existsSync } from "node:fs";
import type { PostToolUseInput, SessionEndInput, SessionStartInput, StopInput, UserPromptInput } from "./env.js";
import { repoRoot } from "./git.js";
import {
  appendFileModification,
  appendPrompt,
  appendTaskNote,
  appendTurnDelimiter,
  createSession,
  finalizeSession,
  findRecentSession,
  generateContinuityBlock,
  getActiveSessionId,
  getCondensedMistakes,
} from "./session.js";

// =============================================================================
// Hook Handlers
// =============================================================================

/**
 * SessionStart: Create session file, inject warm resume context + mistakes.
 * Returns context string via stdout (Claude sees this).
 */
export async function handleSessionStart(input: SessionStartInput): Promise<string | undefined> {
  const root = input.cwd || (await repoRoot());
  const _id = await createSession(root);

  // Pull shared knowledge (rate-limited internally)
  try {
    const { pullShared } = await import("./sync.js");
    await pullShared(root);
  } catch {
    // Non-critical
  }

  const parts: string[] = [];

  // Check for recent session on same branch for warm resume
  try {
    const recentId = await findRecentSession(root);
    if (recentId) {
      const block = generateContinuityBlock(root, recentId);
      if (block) parts.push(block);
    }
  } catch {
    // Non-critical — skip silently
  }

  // Inject condensed mistake ledger
  try {
    const mistakes = getCondensedMistakes(root);
    if (mistakes) parts.push(mistakes);
  } catch {
    // Non-critical — skip silently
  }

  if (parts.length > 0) {
    return parts.join("\n");
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

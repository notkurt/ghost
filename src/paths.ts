import { join } from "node:path";

// =============================================================================
// Constants
// =============================================================================

export const SESSION_DIR = ".ai-sessions";
export const ACTIVE_DIR = "active";
export const COMPLETED_DIR = "completed";
export const CURRENT_ID_FILE = "current-id";
export const TAGS_FILE = "tags.json";
export const KNOWLEDGE_FILE = "knowledge.md";
export const MISTAKES_FILE = "mistakes.md";
export const DECISIONS_FILE = "decisions.md";

// =============================================================================
// Path Helpers
// =============================================================================

/** Root .ai-sessions directory */
export function sessionDir(repoRoot: string): string {
  return join(repoRoot, SESSION_DIR);
}

/** Directory for in-progress session files */
export function activeDir(repoRoot: string): string {
  return join(repoRoot, SESSION_DIR, ACTIVE_DIR);
}

/** Directory for finalized session files */
export function completedDir(repoRoot: string): string {
  return join(repoRoot, SESSION_DIR, COMPLETED_DIR);
}

/** Path to the active session markdown file */
export function sessionFilePath(repoRoot: string, sessionId: string): string {
  return join(repoRoot, SESSION_DIR, ACTIVE_DIR, `${sessionId}.md`);
}

/** Path to the current-id file that tracks active session */
export function currentIdPath(repoRoot: string): string {
  return join(repoRoot, SESSION_DIR, ACTIVE_DIR, CURRENT_ID_FILE);
}

/** Path to a completed session file */
export function completedSessionPath(repoRoot: string, sessionId: string): string {
  return join(repoRoot, SESSION_DIR, COMPLETED_DIR, `${sessionId}.md`);
}

/** Path to the tags index */
export function tagsPath(repoRoot: string): string {
  return join(repoRoot, SESSION_DIR, TAGS_FILE);
}

/** Path to the knowledge base */
export function knowledgePath(repoRoot: string): string {
  return join(repoRoot, SESSION_DIR, KNOWLEDGE_FILE);
}

/** Path to the mistake ledger */
export function mistakesPath(repoRoot: string): string {
  return join(repoRoot, SESSION_DIR, MISTAKES_FILE);
}

/** Path to the decision log */
export function decisionsPath(repoRoot: string): string {
  return join(repoRoot, SESSION_DIR, DECISIONS_FILE);
}

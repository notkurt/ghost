import crypto from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { addNoteFromFile, currentBranch, diffStat, headSha } from "./git.js";
import {
  activeDir,
  completedDir,
  completedSessionPath,
  currentIdPath,
  decisionsPath,
  mistakesPath,
  SESSION_DIR,
  sessionFilePath,
  tagsPath,
} from "./paths.js";
import { redactWithBuiltinPatterns } from "./redact.js";

// =============================================================================
// Session ID Generation
// =============================================================================

/** Generate a unique session ID: YYYY-MM-DD-{8 hex chars} */
export function generateSessionId(): string {
  const date = new Date().toISOString().slice(0, 10);
  const rand = crypto.randomBytes(4).toString("hex");
  return `${date}-${rand}`;
}

// =============================================================================
// Session Lifecycle
// =============================================================================

/** Create a new session file with frontmatter, return session ID */
export async function createSession(repoRoot: string): Promise<string> {
  const id = generateSessionId();
  const dir = activeDir(repoRoot);
  mkdirSync(dir, { recursive: true });

  const branch = await currentBranch();
  let sha = "";
  try {
    sha = await headSha();
  } catch {
    sha = "none";
  }

  const frontmatter = {
    session: id,
    branch,
    base_commit: sha,
    started: new Date().toISOString(),
    tags: [] as string[],
  };

  const content = `---\n${YAML.stringify(frontmatter).trim()}\n---\n`;
  writeFileSync(sessionFilePath(repoRoot, id), content);
  writeFileSync(currentIdPath(repoRoot), id);

  return id;
}

/** Get the active session ID, or null if none */
export function getActiveSessionId(repoRoot: string): string | null {
  const idPath = currentIdPath(repoRoot);
  if (!existsSync(idPath)) return null;
  const id = readFileSync(idPath, "utf8").trim();
  if (!id) return null;
  // Verify the session file exists
  if (!existsSync(sessionFilePath(repoRoot, id))) return null;
  return id;
}

/** Get the path to the active session file */
export function getActiveSessionPath(repoRoot: string): string | null {
  const id = getActiveSessionId(repoRoot);
  if (!id) return null;
  return sessionFilePath(repoRoot, id);
}

/** Count ## Prompt headings in the active session */
export function getPromptCount(repoRoot: string): number {
  const path = getActiveSessionPath(repoRoot);
  if (!path || !existsSync(path)) return 0;
  const content = readFileSync(path, "utf8");
  const matches = content.match(/^## Prompt \d+/gm);
  return matches ? matches.length : 0;
}

// =============================================================================
// Session Appenders
// =============================================================================

/** Append a user prompt to the active session (deduplicates consecutive identical prompts) */
export function appendPrompt(repoRoot: string, promptText: string): void {
  const path = getActiveSessionPath(repoRoot);
  if (!path) return;

  // Dedup: skip if last recorded prompt is identical
  if (existsSync(path)) {
    const content = readFileSync(path, "utf8");
    const lastPrompt = content.match(/^> (.+)$/gm);
    if (lastPrompt && lastPrompt.length > 0) {
      const lastText = lastPrompt[lastPrompt.length - 1]!.slice(2); // strip "> "
      if (lastText === promptText) return;
    }
  }

  const n = getPromptCount(repoRoot) + 1;
  const block = `\n## Prompt ${n}\n> ${promptText}\n`;
  appendFileSync(path, block);
}

/** Append a file modification note */
export function appendFileModification(repoRoot: string, filePath: string): void {
  const path = getActiveSessionPath(repoRoot);
  if (!path) return;
  appendFileSync(path, `\n- Modified: ${filePath}\n`);
}

/** Append a task completion note */
export function appendTaskNote(repoRoot: string, note: string): void {
  const path = getActiveSessionPath(repoRoot);
  if (!path) return;
  appendFileSync(path, `\n- Task: ${note}\n`);
}

/** Append a turn delimiter with timestamp and optional diff stat */
export async function appendTurnDelimiter(repoRoot: string): Promise<void> {
  const path = getActiveSessionPath(repoRoot);
  if (!path) return;
  const timestamp = new Date().toISOString();
  let block = `\n---\n_turn completed: ${timestamp}_\n`;
  const stat = await diffStat();
  if (stat) {
    block += `\n\`\`\`\n${stat}\n\`\`\`\n`;
  }
  appendFileSync(path, block);
}

// =============================================================================
// Session Finalization
// =============================================================================

/** Finalize the active session — close sections, move to completed, return path */
export function finalizeSession(repoRoot: string): string | null {
  const id = getActiveSessionId(repoRoot);
  if (!id) return null;

  const activePath = sessionFilePath(repoRoot, id);
  if (!existsSync(activePath)) return null;

  // Update frontmatter with ended timestamp
  const content = readFileSync(activePath, "utf8");
  const redacted = redactWithBuiltinPatterns(content);
  const endedContent = addFrontmatterField(redacted, "ended", new Date().toISOString());
  writeFileSync(activePath, endedContent);

  // Ensure completed dir exists
  const compDir = completedDir(repoRoot);
  mkdirSync(compDir, { recursive: true });

  // Move active → completed
  const compPath = completedSessionPath(repoRoot, id);
  renameSync(activePath, compPath);

  // Clean up current-id
  const idPath = currentIdPath(repoRoot);
  if (existsSync(idPath)) {
    writeFileSync(idPath, "");
  }

  return compPath;
}

// =============================================================================
// Git Notes Checkpoint
// =============================================================================

/** Attach the most recent completed session as a git note to HEAD */
export async function checkpoint(repoRoot: string): Promise<void> {
  const idPath = currentIdPath(repoRoot);
  let sessionId: string | null = null;

  // Try current-id first (may have just been finalized)
  if (existsSync(idPath)) {
    const id = readFileSync(idPath, "utf8").trim();
    if (id) sessionId = id;
  }

  // If no current-id, find the most recent completed session
  if (!sessionId) {
    sessionId = getMostRecentCompletedId(repoRoot);
  }

  if (!sessionId) return;

  const compPath = completedSessionPath(repoRoot, sessionId);
  if (!existsSync(compPath)) return;

  try {
    const sha = await headSha();
    await addNoteFromFile(compPath, sha);
  } catch {
    // Silently fail — non-blocking
  }
}

// =============================================================================
// Tagging
// =============================================================================

/** Add tags to a session's frontmatter and update tags.json */
export function addTags(repoRoot: string, sessionId: string, tags: string[]): void {
  // Try completed path first, then active
  let filePath = completedSessionPath(repoRoot, sessionId);
  if (!existsSync(filePath)) {
    filePath = sessionFilePath(repoRoot, sessionId);
  }
  if (!existsSync(filePath)) return;

  // Update frontmatter
  const content = readFileSync(filePath, "utf8");
  const parsed = parseFrontmatter(content);
  const existingTags: string[] = (parsed.frontmatter.tags as string[] | undefined) || [];
  const merged = [...new Set([...existingTags, ...tags])];
  const updated = updateFrontmatterField(content, "tags", merged);
  writeFileSync(filePath, updated);

  // Update tags.json
  updateTagsIndex(repoRoot, sessionId, tags);
}

/** List all tags from tags.json */
export function listTags(repoRoot: string): Record<string, string[]> {
  const path = tagsPath(repoRoot);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/** Get session IDs for a given tag */
export function getSessionsByTag(repoRoot: string, tag: string): string[] {
  const tags = listTags(repoRoot);
  return tags[tag] || [];
}

/** Update the tags.json index */
function updateTagsIndex(repoRoot: string, sessionId: string, tags: string[]): void {
  const path = tagsPath(repoRoot);
  let index: Record<string, string[]> = {};
  if (existsSync(path)) {
    try {
      index = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      index = {};
    }
  }
  for (const tag of tags) {
    if (!index[tag]) index[tag] = [];
    if (!index[tag]!.includes(sessionId)) {
      index[tag]!.push(sessionId);
    }
  }
  mkdirSync(join(repoRoot, SESSION_DIR), { recursive: true });
  writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`);
}

// =============================================================================
// Warm Resume / Session Continuity
// =============================================================================

/** Find the most recent completed session on the current branch within 24h */
export async function findRecentSession(repoRoot: string): Promise<string | null> {
  const branch = await currentBranch();
  const compDir = completedDir(repoRoot);
  if (!existsSync(compDir)) return null;

  const files = readdirSync(compDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;

  for (const file of files) {
    const filePath = join(compDir, file);
    const content = readFileSync(filePath, "utf8");
    const parsed = parseFrontmatter(content);
    if (parsed.frontmatter.branch !== branch) continue;
    const started = new Date(parsed.frontmatter.started as string).getTime();
    if (started < cutoff) continue;
    // Check if it has open items
    if (content.includes("## Open Items") || content.includes("### Open Items")) {
      return file.replace(".md", "");
    }
  }
  return null;
}

/** Generate a continuity block from a previous session */
export function generateContinuityBlock(repoRoot: string, sessionId: string): string | null {
  const filePath = completedSessionPath(repoRoot, sessionId);
  if (!existsSync(filePath)) return null;

  const content = readFileSync(filePath, "utf8");
  const _parsed = parseFrontmatter(content);

  // Extract key sections from the summary
  const intent = extractSection(content, "Intent");
  const openItems = extractSection(content, "Open Items");
  const decisions = extractSection(content, "Decisions");
  const mistakes = extractSection(content, "Mistakes");
  const files = extractModifiedFiles(content);

  let block = `## Context from Previous Session (${sessionId})\n\n`;
  if (intent) block += `**What we were doing:** ${intent.trim()}\n\n`;
  if (openItems) block += `**Where we left off:**\n${openItems.trim()}\n\n`;
  if (files.length > 0) {
    block += `**Files we were working in:**\n`;
    for (const f of [...new Set(files)].slice(0, 10)) {
      block += `- ${f}\n`;
    }
    block += "\n";
  }
  if (decisions) block += `**Key decisions made:**\n${decisions.trim()}\n\n`;
  if (mistakes && !mistakes.includes("None this session")) {
    block += `**Watch out for:**\n${mistakes.trim()}\n\n`;
  }

  return block;
}

/** Get condensed mistakes for session injection */
export function getCondensedMistakes(repoRoot: string, maxEntries: number = 5): string | null {
  const path = mistakesPath(repoRoot);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8").trim();
  if (!content) return null;

  const lines = content.split("\n").filter((l) => l.startsWith("- "));
  if (lines.length === 0) return null;

  const entries = lines.slice(-maxEntries);
  const total = lines.length;
  let block = `> Known project pitfalls (${total} entries):\n`;
  for (const line of entries) {
    block += `> ${line}\n`;
  }
  return block;
}

// =============================================================================
// Decisions & Mistakes
// =============================================================================

/** Append a decision to the decision log */
export function appendDecision(repoRoot: string, decision: string): void {
  const path = decisionsPath(repoRoot);
  mkdirSync(join(repoRoot, SESSION_DIR), { recursive: true });
  appendFileSync(path, `\n${decision}\n`);
}

/** Append a mistake to the mistake ledger */
export function appendMistake(repoRoot: string, description: string): void {
  const path = mistakesPath(repoRoot);
  mkdirSync(join(repoRoot, SESSION_DIR), { recursive: true });
  appendFileSync(path, `- ${description}\n`);
}

/** List all decisions, optionally filtered by tag */
export function listDecisions(repoRoot: string, tagFilter?: string): string {
  const path = decisionsPath(repoRoot);
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf8");
  if (!tagFilter) return content;
  // Simple tag filter — return sections containing the tag
  const sections = content.split(/\n(?=## )/).filter((s) => s.toLowerCase().includes(tagFilter.toLowerCase()));
  return sections.join("\n");
}

// =============================================================================
// Helpers
// =============================================================================

/** Get the most recent completed session ID */
export function getMostRecentCompletedId(repoRoot: string): string | null {
  const compDir = completedDir(repoRoot);
  if (!existsSync(compDir)) return null;
  const files = readdirSync(compDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse();
  if (files.length === 0) return null;
  return files[0]!.replace(".md", "");
}

/** List all completed session IDs */
export function listCompletedSessions(repoRoot: string): string[] {
  const compDir = completedDir(repoRoot);
  if (!existsSync(compDir)) return [];
  return readdirSync(compDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(".md", ""))
    .sort()
    .reverse();
}

/** Parse YAML frontmatter from a markdown file */
export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  try {
    const frontmatter = YAML.parse(match[1]!) as Record<string, unknown>;
    return { frontmatter, body: match[2] || "" };
  } catch {
    return { frontmatter: {}, body: content };
  }
}

/** Add a field to existing frontmatter */
function addFrontmatterField(content: string, key: string, value: unknown): string {
  const parsed = parseFrontmatter(content);
  parsed.frontmatter[key] = value;
  return `---\n${YAML.stringify(parsed.frontmatter).trim()}\n---\n${parsed.body}`;
}

/** Update a field in existing frontmatter */
function updateFrontmatterField(content: string, key: string, value: unknown): string {
  return addFrontmatterField(content, key, value);
}

/** Extract a named section from markdown content */
function extractSection(content: string, sectionName: string): string | null {
  const regex = new RegExp(`###?\\s+${sectionName}\\n([\\s\\S]*?)(?=\\n###?\\s|$)`);
  const match = content.match(regex);
  return match ? match[1]!.trim() : null;
}

/** Extract all modified file paths from session content */
function extractModifiedFiles(content: string): string[] {
  const matches = content.matchAll(/^- Modified: (.+)$/gm);
  return [...matches].map((m) => m[1]!);
}

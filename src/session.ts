import { execSync } from "node:child_process";
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
  sessionMapPath,
  tagsPath,
} from "./paths.js";
import { redactWithBuiltinPatterns } from "./redact.js";

// =============================================================================
// Knowledge Entry Types
// =============================================================================

export interface KnowledgeEntry {
  title: string;
  description: string;
  sessionId: string;
  commitSha: string;
  files: string[];
  area: string;
  date: string;
  tried: string[];
  rule: string;
}

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
// Session Map (Claude session_id → Ghost session_id)
// =============================================================================

/** Read the session map from disk */
export function readSessionMap(repoRoot: string): Record<string, string> {
  const mapPath = sessionMapPath(repoRoot);
  if (!existsSync(mapPath)) return {};
  try {
    return JSON.parse(readFileSync(mapPath, "utf8"));
  } catch {
    return {};
  }
}

/** Write the session map to disk */
export function writeSessionMap(repoRoot: string, map: Record<string, string>): void {
  writeFileSync(sessionMapPath(repoRoot), `${JSON.stringify(map)}\n`);
}

/** Register a Claude session_id → Ghost session_id mapping */
export function registerSession(repoRoot: string, claudeSessionId: string, ghostSessionId: string): void {
  const map = readSessionMap(repoRoot);
  map[claudeSessionId] = ghostSessionId;
  writeSessionMap(repoRoot, map);
}

/** Look up the Ghost session_id for a Claude session_id */
export function resolveGhostId(repoRoot: string, claudeSessionId: string): string | null {
  const map = readSessionMap(repoRoot);
  return map[claudeSessionId] || null;
}

/** Get the session file path for a hook call, using Claude's session_id */
export function getSessionPathForHook(repoRoot: string, claudeSessionId: string): string | null {
  const ghostId = resolveGhostId(repoRoot, claudeSessionId);
  if (!ghostId) return null;
  const path = sessionFilePath(repoRoot, ghostId);
  if (!existsSync(path)) return null;
  return path;
}

/** Remove a Claude session_id from the session map */
export function unregisterSession(repoRoot: string, claudeSessionId: string): void {
  const map = readSessionMap(repoRoot);
  delete map[claudeSessionId];
  writeSessionMap(repoRoot, map);
}

// =============================================================================
// Session Lifecycle
// =============================================================================

/** Create a new session file with frontmatter, return session ID */
export async function createSession(repoRoot: string, claudeSessionId?: string): Promise<string> {
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

  // Register Claude session_id → Ghost session_id mapping
  if (claudeSessionId) {
    registerSession(repoRoot, claudeSessionId, id);
  }

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
export function getPromptCount(repoRoot: string, claudeSessionId?: string): number {
  const path = claudeSessionId ? getSessionPathForHook(repoRoot, claudeSessionId) : getActiveSessionPath(repoRoot);
  if (!path || !existsSync(path)) return 0;
  const content = readFileSync(path, "utf8");
  const matches = content.match(/^## Prompt \d+/gm);
  return matches ? matches.length : 0;
}

// =============================================================================
// Session Appenders
// =============================================================================

/** Compute a short hash for prompt dedup — first 8 hex chars of MD5 */
export function promptHash(text: string): string {
  return crypto.createHash("md5").update(text).digest("hex").slice(0, 8);
}

/** Append a user prompt to the active session (deduplicates consecutive identical prompts) */
export function appendPrompt(repoRoot: string, claudeSessionIdOrPrompt: string, promptText?: string): void {
  // Support both old (repoRoot, prompt) and new (repoRoot, claudeSessionId, prompt) signatures
  let claudeSessionId: string | undefined;
  let prompt: string;
  if (promptText !== undefined) {
    claudeSessionId = claudeSessionIdOrPrompt;
    prompt = promptText;
  } else {
    prompt = claudeSessionIdOrPrompt;
  }

  const path = claudeSessionId ? getSessionPathForHook(repoRoot, claudeSessionId) : getActiveSessionPath(repoRoot);
  if (!path) return;

  const hash = promptHash(prompt);

  // Dedup: compare hash of incoming prompt against last recorded prompt hash
  if (existsSync(path)) {
    const content = readFileSync(path, "utf8");
    const hashMatches = content.match(/<!-- ph:([0-9a-f]{8}) -->/g);
    if (hashMatches && hashMatches.length > 0) {
      // Extract the hash value from the last match
      const lastMatch = hashMatches[hashMatches.length - 1]!.match(/<!-- ph:([0-9a-f]{8}) -->/);
      if (lastMatch && lastMatch[1] === hash) return;
    } else {
      // Legacy fallback: no hash comments found, compare first line
      const lastPrompt = content.match(/^> (.+)$/gm);
      if (lastPrompt && lastPrompt.length > 0) {
        const lastText = lastPrompt[lastPrompt.length - 1]!.slice(2); // strip "> "
        const firstLine = prompt.split("\n")[0]!;
        if (lastText === firstLine || lastText === prompt) return;
      }
    }
  }

  const n = getPromptCount(repoRoot, claudeSessionId) + 1;
  const block = `\n## Prompt ${n} <!-- ph:${hash} -->\n> ${prompt}\n`;
  appendFileSync(path, block);
}

/** Append a file modification note */
export function appendFileModification(repoRoot: string, claudeSessionIdOrPath: string, filePath?: string): void {
  // Support both old (repoRoot, filePath) and new (repoRoot, claudeSessionId, filePath) signatures
  let claudeSessionId: string | undefined;
  let modifiedPath: string;
  if (filePath !== undefined) {
    claudeSessionId = claudeSessionIdOrPath;
    modifiedPath = filePath;
  } else {
    modifiedPath = claudeSessionIdOrPath;
  }

  const path = claudeSessionId ? getSessionPathForHook(repoRoot, claudeSessionId) : getActiveSessionPath(repoRoot);
  if (!path) return;
  // Normalize absolute paths to repo-relative
  let rel = modifiedPath;
  if (rel.startsWith(repoRoot)) {
    rel = rel.slice(repoRoot.length).replace(/^\//, "");
  }
  appendFileSync(path, `\n- Modified: ${rel}\n`);
}

/** Append a task completion note */
export function appendTaskNote(repoRoot: string, claudeSessionIdOrNote: string, note?: string): void {
  // Support both old (repoRoot, note) and new (repoRoot, claudeSessionId, note) signatures
  let claudeSessionId: string | undefined;
  let taskNote: string;
  if (note !== undefined) {
    claudeSessionId = claudeSessionIdOrNote;
    taskNote = note;
  } else {
    taskNote = claudeSessionIdOrNote;
  }

  const path = claudeSessionId ? getSessionPathForHook(repoRoot, claudeSessionId) : getActiveSessionPath(repoRoot);
  if (!path) return;
  appendFileSync(path, `\n- Task: ${taskNote}\n`);
}

/** Append a turn delimiter with timestamp and optional diff stat */
export async function appendTurnDelimiter(repoRoot: string, claudeSessionId?: string): Promise<void> {
  const path = claudeSessionId ? getSessionPathForHook(repoRoot, claudeSessionId) : getActiveSessionPath(repoRoot);
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

/** Finalize a session — close sections, move to completed, return path */
export function finalizeSession(repoRoot: string, claudeSessionId?: string): { path: string; ghostId: string } | null {
  // Resolve the ghost ID: use session map if claudeSessionId provided, else current-id
  let id: string | null;
  if (claudeSessionId) {
    id = resolveGhostId(repoRoot, claudeSessionId);
  } else {
    id = getActiveSessionId(repoRoot);
  }
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

  // Unregister from session map
  if (claudeSessionId) {
    unregisterSession(repoRoot, claudeSessionId);
  }

  // Update current-id: clear it if it pointed to this session
  const idPath = currentIdPath(repoRoot);
  if (existsSync(idPath)) {
    const currentId = readFileSync(idPath, "utf8").trim();
    if (currentId === id) {
      writeFileSync(idPath, "");
    }
  }

  return { path: compPath, ghostId: id };
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

/** Get condensed mistakes for session injection (legacy — kept for backward compat) */
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
// Relevance Scoring
// =============================================================================

/** Score and rank knowledge entries by relevance to current files */
export function getRelevantEntries(
  entries: KnowledgeEntry[],
  relevantFiles: string[],
  coModFiles: string[],
  max: number,
): KnowledgeEntry[] {
  if (entries.length === 0) return [];

  const relevantFileSet = new Set(relevantFiles);
  const coModFileSet = new Set(coModFiles);
  const relevantArea = deriveArea(relevantFiles);
  const now = Date.now();

  const scored = entries.map((entry) => {
    let score = 0;

    // +10 per exact file match
    for (const f of entry.files) {
      if (relevantFileSet.has(f)) score += 10;
    }

    // +5 per co-modification neighbor match
    for (const f of entry.files) {
      if (coModFileSet.has(f)) score += 5;
    }

    // +5 for same area match
    if (entry.area !== "general" && entry.area === relevantArea) score += 5;

    // +3 recency bonus (decays over 30 days)
    if (entry.date) {
      const entryTime = new Date(entry.date).getTime();
      if (!Number.isNaN(entryTime)) {
        const daysSince = (now - entryTime) / (1000 * 60 * 60 * 24);
        score += 3 * Math.max(0, 1 - daysSince / 30);
      }
    }

    // +1 baseline for legacy entries (no file info)
    if (entry.files.length === 0) score += 1;

    // +20 bonus for entries with rules
    if (entry.rule) score += 20;

    return { entry, score };
  });

  // Sort by score descending, then by date descending
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.entry.date.localeCompare(a.entry.date);
  });

  // Staleness check on top 2*max entries
  const checkCount = Math.min(scored.length, max * 2);
  for (let i = 0; i < checkCount; i++) {
    const entry = scored[i]!.entry;
    if (entry.files.length > 0 && entry.date) {
      for (const f of entry.files.slice(0, 3)) {
        try {
          const log = execSync(`git log --oneline --since="${entry.date}" -- "${f}"`, {
            encoding: "utf8",
            timeout: 2000,
          }).trim();
          const commitCount = log ? log.split("\n").length : 0;
          if (commitCount > 10) {
            scored[i]!.score -= 5;
            break;
          }
        } catch {
          // Silently skip — may not be in a git repo or file doesn't exist
        }
      }
    }
  }

  // Re-sort after staleness adjustment
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.entry.date.localeCompare(a.entry.date);
  });

  // If nothing scores above 0, fall back to most recent
  const aboveZero = scored.filter((s) => s.score > 0);
  if (aboveZero.length === 0) {
    return entries
      .filter((e) => e.date)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, max);
  }

  return aboveZero.slice(0, max).map((s) => s.entry);
}

/** Get relevant mistakes formatted for session injection */
export function getRelevantMistakes(root: string, relevantFiles: string[], max: number = 10): string | null {
  const path = mistakesPath(root);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8").trim();
  if (!content) return null;

  const entries = parseKnowledgeEntries(content);
  if (entries.length === 0) return null;

  const graph = buildCoModGraph(root);
  const coModFiles = getCoModifiedFiles(graph, relevantFiles);
  const relevant = getRelevantEntries(entries, relevantFiles, coModFiles, max);
  if (relevant.length === 0) return null;

  // Separate rules from regular entries
  const rules = relevant.filter((e) => e.rule);
  const regular = relevant.filter((e) => !e.rule);
  const parts: string[] = [];

  if (rules.length > 0) {
    parts.push("> \u26A0 RULES (must follow when modifying these files):");
    for (const r of rules) {
      parts.push(`> ${r.rule}`);
    }
  }

  if (regular.length > 0 || rules.length > 0) {
    parts.push(
      `> Known pitfalls relevant to your current files (${entries.length} total, showing top ${relevant.length}):`,
    );
    parts.push(">");
    for (const e of relevant) {
      const fileTag = e.files.length > 0 ? ` [${e.files.join(", ")}]` : "";
      parts.push(`> **${e.title}**${fileTag}`);
      if (e.description) parts.push(`> ${e.description}`);
      if (e.tried.length > 0) parts.push(`> Dead ends: ${e.tried.join(", ")}`);
      parts.push(">");
    }
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

/** Get relevant decisions formatted for session injection */
export function getRelevantDecisions(root: string, relevantFiles: string[], max: number = 5): string | null {
  const path = decisionsPath(root);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8").trim();
  if (!content) return null;

  const entries = parseKnowledgeEntries(content);
  if (entries.length === 0) return null;

  const graph = buildCoModGraph(root);
  const coModFiles = getCoModifiedFiles(graph, relevantFiles);
  const relevant = getRelevantEntries(entries, relevantFiles, coModFiles, max);
  if (relevant.length === 0) return null;

  const parts: string[] = ["> Relevant decisions:"];
  parts.push(">");
  for (const e of relevant) {
    const fileTag = e.files.length > 0 ? ` [${e.files.join(", ")}]` : "";
    parts.push(`> **${e.title}**${fileTag}`);
    if (e.description) parts.push(`> ${e.description}`);
    if (e.rule) parts.push(`> Rule: ${e.rule}`);
    parts.push(">");
  }

  return parts.join("\n");
}

// =============================================================================
// Decisions & Mistakes
// =============================================================================

/** Append a decision to the decision log */
export function appendDecision(repoRoot: string, decision: KnowledgeEntry | string): void {
  const path = decisionsPath(repoRoot);
  mkdirSync(join(repoRoot, SESSION_DIR), { recursive: true });
  if (typeof decision === "string") {
    appendFileSync(path, `\n${decision}\n`);
  } else {
    appendFileSync(path, `\n${formatKnowledgeEntry(decision)}\n`);
  }
}

/** Append a mistake to the mistake ledger */
export function appendMistake(repoRoot: string, entry: KnowledgeEntry | string): void {
  const path = mistakesPath(repoRoot);
  mkdirSync(join(repoRoot, SESSION_DIR), { recursive: true });
  if (typeof entry === "string") {
    appendFileSync(path, `- ${entry}\n`);
  } else {
    appendFileSync(path, `${formatKnowledgeEntry(entry)}\n`);
  }
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
// Knowledge Entry Parsing & Formatting
// =============================================================================

/** Derive area from file paths — strips src/app/lib prefixes, uses first path segment */
export function deriveArea(files: string[]): string {
  if (files.length === 0) return "general";
  const segments: string[] = [];
  const codeRoots = new Set(["src", "app", "lib"]);
  for (const f of files) {
    const parts = f.split("/").filter(Boolean);
    let i = 0;
    // For absolute paths, skip ahead to the first src/app/lib marker
    if (f.startsWith("/")) {
      const rootIdx = parts.findIndex((p) => codeRoots.has(p));
      if (rootIdx >= 0) {
        i = rootIdx;
      } else {
        // No code root found — use second-to-last segment if available
        if (parts.length >= 2) {
          segments.push(parts[parts.length - 2]!);
        }
        continue;
      }
    }
    // Strip common prefixes
    while (i < parts.length && codeRoots.has(parts[i]!)) i++;
    if (i < parts.length - 1) {
      segments.push(parts[i]!);
    }
  }
  if (segments.length === 0) return "general";
  // Return most common segment
  const counts: Record<string, number> = {};
  for (const s of segments) {
    counts[s] = (counts[s] || 0) + 1;
  }
  return Object.entries(counts).sort(([, a], [, b]) => b - a)[0]![0];
}

/** Parse knowledge entries from both old `- ` lines and new `### + <!-- -->` format */
export function parseKnowledgeEntries(content: string): KnowledgeEntry[] {
  if (!content.trim()) return [];
  const entries: KnowledgeEntry[] = [];

  // Split by ### headings to find structured entries
  const parts = content.split(/^(?=### )/m);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("### ")) {
      // Structured entry: ### title\ndescription\n<!-- metadata -->
      const lines = trimmed.split("\n");
      const title = lines[0]!.replace(/^### /, "").trim();
      const metaMatch = trimmed.match(/<!--\s*(.*?)\s*-->/s);
      let description = "";
      let sessionId = "unknown";
      let commitSha = "";
      let files: string[] = [];
      let area = "general";
      let date = "";
      let tried: string[] = [];
      let rule = "";

      if (metaMatch) {
        const meta = metaMatch[1]!;
        // Parse pipe-delimited metadata fields
        for (const field of meta.split("|").map((f) => f.trim())) {
          const [key, ...valParts] = field.split(":");
          const val = valParts.join(":").trim();
          switch (key?.trim()) {
            case "session":
              sessionId = val;
              break;
            case "commit":
              commitSha = val;
              break;
            case "files":
              files = val
                .split(",")
                .map((f) => f.trim())
                .filter(Boolean);
              break;
            case "area":
              area = val;
              break;
            case "tried":
              tried = val
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean);
              break;
            case "rule":
              rule = val;
              break;
            case "date":
              date = val;
              break;
          }
        }

        // Description is everything between title line and comment
        const commentIdx = trimmed.indexOf("<!--");
        const descLines = trimmed.slice(lines[0]!.length, commentIdx).trim();
        description = descLines;
      } else {
        // No metadata comment — just title + description
        description = lines.slice(1).join("\n").trim();
      }

      // Derive date from sessionId if not explicit
      if (!date && sessionId !== "unknown") {
        date = sessionId.slice(0, 10);
      }

      entries.push({ title, description, sessionId, commitSha, files, area, date, tried, rule });
    } else {
      // Legacy lines: parse `- ` prefixed lines
      const lines = trimmed.split("\n");
      for (const line of lines) {
        const stripped = line.trim();
        if (stripped.startsWith("- ")) {
          const text = stripped.slice(2).trim();
          if (text) {
            entries.push({
              title: text,
              description: "",
              sessionId: "unknown",
              commitSha: "",
              files: [],
              area: "general",
              date: "",
              tried: [],
              rule: "",
            });
          }
        }
      }
    }
  }
  return entries;
}

/** Serialize a KnowledgeEntry to structured markdown format */
export function formatKnowledgeEntry(entry: KnowledgeEntry): string {
  let result = `### ${entry.title}\n`;
  if (entry.description) {
    result += `${entry.description}\n`;
  }
  const metaParts: string[] = [];
  if (entry.sessionId) metaParts.push(`session:${entry.sessionId}`);
  if (entry.commitSha) metaParts.push(`commit:${entry.commitSha}`);
  if (entry.files.length > 0) metaParts.push(`files:${entry.files.join(",")}`);
  if (entry.area && entry.area !== "general") metaParts.push(`area:${entry.area}`);
  if (entry.date) metaParts.push(`date:${entry.date}`);
  if (entry.tried.length > 0) metaParts.push(`tried:${entry.tried.join(",")}`);
  if (entry.rule) metaParts.push(`rule:${entry.rule}`);
  result += `<!-- ${metaParts.join(" | ")} -->`;
  return result;
}

// =============================================================================
// Co-modification Graph
// =============================================================================

/** Build co-modification graph from completed sessions */
export function buildCoModGraph(root: string): Record<string, string[]> {
  const cachePath = join(root, SESSION_DIR, ".comod-cache.json");

  // Try loading from cache
  const compDir = completedDir(root);
  if (!existsSync(compDir)) return {};
  const sessionFiles = readdirSync(compDir).filter((f) => f.endsWith(".md"));

  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8"));
      if (cached.sessionCount === sessionFiles.length) {
        return cached.graph;
      }
    } catch {
      // Rebuild if cache is corrupt
    }
  }

  // Build graph: for each session, find files modified in the same turn
  const pairCounts: Record<string, Record<string, number>> = {};

  for (const file of sessionFiles) {
    const content = readFileSync(join(compDir, file), "utf8");
    // Split into turns by --- delimiter
    const turns = content.split(/^---$/m);
    for (const turn of turns) {
      const files = [...turn.matchAll(/^- Modified: (.+)$/gm)].map((m) => m[1]!);
      const unique = [...new Set(files)];
      // Record co-occurrences
      for (let i = 0; i < unique.length; i++) {
        for (let j = i + 1; j < unique.length; j++) {
          const a = unique[i]!;
          const b = unique[j]!;
          if (!pairCounts[a]) pairCounts[a] = {};
          if (!pairCounts[b]) pairCounts[b] = {};
          pairCounts[a][b] = (pairCounts[a][b] || 0) + 1;
          pairCounts[b][a] = (pairCounts[b][a] || 0) + 1;
        }
      }
    }
  }

  // Convert to adjacency list sorted by frequency
  const graph: Record<string, string[]> = {};
  for (const [file, neighbors] of Object.entries(pairCounts)) {
    graph[file] = Object.entries(neighbors)
      .sort(([, a], [, b]) => b - a)
      .map(([f]) => f);
  }

  // Cache the result
  try {
    mkdirSync(join(root, SESSION_DIR), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ sessionCount: sessionFiles.length, graph }));
  } catch {
    // Non-critical
  }

  return graph;
}

/** Get files frequently co-modified with the given files */
export function getCoModifiedFiles(graph: Record<string, string[]>, files: string[], limit: number = 20): string[] {
  const counts: Record<string, number> = {};
  const fileSet = new Set(files);
  for (const f of files) {
    const neighbors = graph[f];
    if (!neighbors) continue;
    for (const n of neighbors) {
      if (!fileSet.has(n)) {
        counts[n] = (counts[n] || 0) + 1;
      }
    }
  }
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([f]) => f);
}

// =============================================================================
// Correction Detection
// =============================================================================

/** Detect files modified in consecutive turns (potential struggle indicator) */
export function detectCorrections(sessionContent: string): Array<{ file: string; turnA: number; turnB: number }> {
  const turns = sessionContent.split(/^---$/m);
  const corrections: Array<{ file: string; turnA: number; turnB: number }> = [];

  for (let i = 0; i < turns.length - 1; i++) {
    const filesA = new Set([...turns[i]!.matchAll(/^- Modified: (.+)$/gm)].map((m) => m[1]!));
    const filesB = new Set([...turns[i + 1]!.matchAll(/^- Modified: (.+)$/gm)].map((m) => m[1]!));
    for (const f of filesA) {
      if (filesB.has(f)) {
        corrections.push({ file: f, turnA: i, turnB: i + 1 });
      }
    }
  }
  return corrections;
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
export function extractModifiedFiles(content: string): string[] {
  const matches = content.matchAll(/^- Modified: (.+)$/gm);
  return [...matches].map((m) => m[1]!);
}

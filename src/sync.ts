import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { branchExists, fetchBranch, hasRemote, pushBranch } from "./git.js";
import { decisionsPath, knowledgePath, lastSyncPath, mistakesPath, sessionDir, tagsPath } from "./paths.js";
import type { KnowledgeEntry } from "./session.js";
import { formatKnowledgeEntry, parseKnowledgeEntries } from "./session.js";

// =============================================================================
// Constants
// =============================================================================

const BRANCH = "ghost/knowledge";
const FETCH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// =============================================================================
// Branch Operations
// =============================================================================

/** Create the ghost/knowledge orphan branch if it doesn't exist. */
export async function initSharedBranch(root: string): Promise<boolean> {
  if (await branchExists(BRANCH, root)) return true;

  // Try fetching from remote first
  if (await hasRemote(root)) {
    const fetched = await fetchBranch(BRANCH, root);
    if (fetched && (await branchExists(BRANCH, root))) return true;
  }

  // Create orphan branch via plumbing (no worktree impact)
  try {
    const emptyTree = execSync("git hash-object -t tree /dev/null", { cwd: root, encoding: "utf8" }).trim();
    const commit = execSync(`git commit-tree ${emptyTree} -m "ghost: init shared knowledge branch"`, {
      cwd: root,
      encoding: "utf8",
    }).trim();
    execSync(`git update-ref refs/heads/${BRANCH} ${commit}`, { cwd: root });
    return true;
  } catch {
    return false;
  }
}

/** Read a file from the shared branch. Returns null if missing. */
export async function readSharedFile(root: string, filename: string): Promise<string | null> {
  try {
    const ref = `${BRANCH}:${filename}`;
    const result = await $`git -C ${root} show ${ref}`.quiet();
    return result.text();
  } catch {
    return null;
  }
}

/** Atomically write files to the shared branch without touching the worktree. */
export async function writeSharedFiles(root: string, files: Record<string, string>): Promise<boolean> {
  const tmpIndex = join(root, ".git", "ghost-tmp-index");
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  const opts = { cwd: root, encoding: "utf8" as const, env };

  try {
    // Read existing tree into temp index
    try {
      const treeish = execSync(`git rev-parse ${BRANCH}^{tree}`, { cwd: root, encoding: "utf8" }).trim();
      execSync(`git read-tree ${treeish}`, opts);
    } catch {
      // Branch may have no tree yet — start fresh
    }

    // Hash each file and update the temp index
    for (const [filename, content] of Object.entries(files)) {
      // Write content to a temp file, hash it, then remove
      const tmpFile = join(root, ".git", `ghost-tmp-${filename.replace(/[^a-z0-9.]/gi, "_")}`);
      writeFileSync(tmpFile, content);
      try {
        const blob = execSync(`git hash-object -w -- "${tmpFile}"`, { cwd: root, encoding: "utf8" }).trim();
        execSync(`git update-index --add --cacheinfo 100644,${blob},${filename}`, opts);
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {
          // ignore
        }
      }
    }

    // Write tree from temp index
    const tree = execSync("git write-tree", opts).trim();

    // Get current branch tip as parent
    const parent = execSync(`git rev-parse ${BRANCH}`, { cwd: root, encoding: "utf8" }).trim();

    // Create commit
    const commit = execSync(`git commit-tree ${tree} -p ${parent} -m "ghost: sync shared knowledge"`, {
      cwd: root,
      encoding: "utf8",
    }).trim();

    // Advance branch ref
    execSync(`git update-ref refs/heads/${BRANCH} ${commit} ${parent}`, { cwd: root });
    return true;
  } catch {
    return false;
  } finally {
    try {
      unlinkSync(tmpIndex);
    } catch {
      // ignore
    }
  }
}

// =============================================================================
// Merge Strategies (pure functions)
// =============================================================================

/** Mistakes: structured entry dedup by title+description, with legacy line support. */
export function mergeMistakes(remote: string, local: string): string {
  const remoteEntries = parseKnowledgeEntries(remote);
  const localEntries = parseKnowledgeEntries(local);

  const seen = new Set<string>();
  const merged: KnowledgeEntry[] = [];
  for (const entry of [...remoteEntries, ...localEntries]) {
    const key = `${entry.title.toLowerCase().trim()}|${entry.description.toLowerCase().trim()}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(entry);
    }
  }

  const structured = merged.filter((e) => e.sessionId !== "unknown" || e.files.length > 0);
  const legacy = merged.filter((e) => e.sessionId === "unknown" && e.files.length === 0);

  let result = "";
  for (const entry of structured) {
    result += `${formatKnowledgeEntry(entry)}\n`;
  }
  for (const entry of legacy) {
    result += `- ${entry.title}\n`;
  }
  return result || "";
}

/** Decisions: structured entry dedup by title+description, with legacy block support. */
export function mergeDecisions(remote: string, local: string): string {
  const remoteEntries = parseKnowledgeEntries(remote);
  const localEntries = parseKnowledgeEntries(local);

  // If both sides have no structured entries, fall back to block-based dedup
  const hasStructured = [...remoteEntries, ...localEntries].some(
    (e) => e.sessionId !== "unknown" || e.files.length > 0,
  );

  if (!hasStructured) {
    // Legacy fallback: block-based dedup
    const split = (text: string) =>
      text
        .split(/\n\n+/)
        .map((b) => b.trim())
        .filter(Boolean);

    const remoteBlocks = split(remote);
    const localBlocks = split(local);

    const seen = new Set<string>();
    const merged: string[] = [];
    for (const block of [...remoteBlocks, ...localBlocks]) {
      if (!seen.has(block)) {
        seen.add(block);
        merged.push(block);
      }
    }
    return merged.length > 0 ? `${merged.join("\n\n")}\n` : "";
  }

  const seen = new Set<string>();
  const merged: KnowledgeEntry[] = [];
  for (const entry of [...remoteEntries, ...localEntries]) {
    const key = `${entry.title.toLowerCase().trim()}|${entry.description.toLowerCase().trim()}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(entry);
    }
  }

  const structured = merged.filter((e) => e.sessionId !== "unknown" || e.files.length > 0);
  const legacy = merged.filter((e) => e.sessionId === "unknown" && e.files.length === 0);

  let result = "";
  for (const entry of structured) {
    result += `${formatKnowledgeEntry(entry)}\n`;
  }
  for (const entry of legacy) {
    // Legacy decisions are multi-line blocks, just write the title
    result += `${entry.title}\n\n`;
  }
  return result || "";
}

/** Knowledge: local wins. Fall back to remote if local is empty. */
export function mergeKnowledge(remote: string, local: string): string {
  return local.trim() ? local : remote;
}

/** Tags: deep merge — union of session ID arrays per tag key. */
export function mergeTags(remote: string, local: string): string {
  let remoteObj: Record<string, string[]>;
  let localObj: Record<string, string[]>;

  try {
    remoteObj = JSON.parse(remote);
  } catch {
    remoteObj = {};
  }
  try {
    localObj = JSON.parse(local);
  } catch {
    localObj = {};
  }

  const merged: Record<string, string[]> = {};
  const allKeys = new Set([...Object.keys(remoteObj), ...Object.keys(localObj)]);
  for (const key of allKeys) {
    const remoteIds = Array.isArray(remoteObj[key]) ? remoteObj[key] : [];
    const localIds = Array.isArray(localObj[key]) ? localObj[key] : [];
    merged[key] = [...new Set([...remoteIds, ...localIds])];
  }
  return JSON.stringify(merged, null, 2);
}

// =============================================================================
// Sync Operations
// =============================================================================

/** Check if enough time has passed since last remote fetch. */
function shouldFetchRemote(root: string): boolean {
  const syncFile = lastSyncPath(root);
  if (!existsSync(syncFile)) return true;
  try {
    const ts = parseInt(readFileSync(syncFile, "utf8").trim(), 10);
    return Date.now() - ts >= FETCH_INTERVAL_MS;
  } catch {
    return true;
  }
}

/** Record the current time as last sync. */
function touchLastSync(root: string): void {
  mkdirSync(sessionDir(root), { recursive: true });
  writeFileSync(lastSyncPath(root), String(Date.now()));
}

/** Mapping from shared filenames to local path helpers and merge functions. */
const FILE_CONFIG: Record<
  string,
  {
    localPath: (root: string) => string;
    merge: (remote: string, local: string) => string;
  }
> = {
  "knowledge.md": { localPath: knowledgePath, merge: mergeKnowledge },
  "mistakes.md": { localPath: mistakesPath, merge: mergeMistakes },
  "decisions.md": { localPath: decisionsPath, merge: mergeDecisions },
  "tags.json": { localPath: tagsPath, merge: mergeTags },
};

/** Pull shared knowledge: fetch from remote (rate-limited), merge into local files. */
export async function pullShared(root: string): Promise<void> {
  if (!(await branchExists(BRANCH, root))) return;

  // Fetch from remote if rate limit allows
  if (shouldFetchRemote(root) && (await hasRemote(root))) {
    await fetchBranch(BRANCH, root);
    touchLastSync(root);
  }

  // Merge each shared file into local
  for (const [filename, config] of Object.entries(FILE_CONFIG)) {
    const remote = await readSharedFile(root, filename);
    if (remote === null) continue;

    const localFile = config.localPath(root);
    const local = existsSync(localFile) ? readFileSync(localFile, "utf8") : "";
    const merged = config.merge(remote, local);

    if (merged && merged !== local) {
      mkdirSync(sessionDir(root), { recursive: true });
      writeFileSync(localFile, merged);
    }
  }
}

/** Push local knowledge to shared branch (and remote if available). */
export async function pushShared(root: string): Promise<void> {
  if (!(await branchExists(BRANCH, root))) {
    const created = await initSharedBranch(root);
    if (!created) return;
  }

  // Read local files, merge with branch versions, write to branch
  const filesToWrite: Record<string, string> = {};
  for (const [filename, config] of Object.entries(FILE_CONFIG)) {
    const localFile = config.localPath(root);
    const local = existsSync(localFile) ? readFileSync(localFile, "utf8") : "";
    if (!local.trim()) continue;

    const remote = (await readSharedFile(root, filename)) || "";
    filesToWrite[filename] = config.merge(remote, local);
  }

  if (Object.keys(filesToWrite).length > 0) {
    await writeSharedFiles(root, filesToWrite);
  }

  // Push to remote if available
  if (await hasRemote(root)) {
    await pushBranch(BRANCH, root);
  }
}

/** Full sync: pull then push. Used by `ghost sync` command. */
export async function syncKnowledge(root: string): Promise<void> {
  const created = await initSharedBranch(root);
  if (!created) {
    throw new Error("Failed to create shared knowledge branch");
  }
  await pullShared(root);
  await pushShared(root);
}

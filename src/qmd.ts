import { basename } from "node:path";
import { $ } from "bun";
import { checkQmd, resetDepCache } from "./deps.js";
import { repoRoot } from "./git.js";
import { completedDir } from "./paths.js";

// =============================================================================
// QMD Integration (Project-Scoped)
// =============================================================================

/** Check if the qmd binary is available on PATH */
export async function isQmdAvailable(): Promise<boolean> {
  const status = await checkQmd();
  return status.available;
}

/** Reset the cached QMD availability check (for testing) */
export function resetQmdCache(): void {
  resetDepCache();
}

/** Derive the QMD collection name from the git repo root */
export async function collectionName(root?: string): Promise<string> {
  const r = root || (await repoRoot());
  return `ghost-${basename(r)}`;
}

/** Check if the ghost QMD collection exists */
export async function collectionExists(root?: string): Promise<boolean> {
  if (!(await isQmdAvailable())) return false;
  try {
    const name = await collectionName(root);
    const result = await $`qmd collection list`.quiet();
    return result.text().includes(name);
  } catch {
    return false;
  }
}

/** Index sessions into the project's QMD collection. Creates collection if needed, updates if exists.
 *  Returns { ok, reason } for diagnostic logging. */
export async function indexSession(root: string): Promise<{ ok: boolean; reason?: string }> {
  if (!(await isQmdAvailable())) return { ok: false, reason: "qmd not found on PATH" };
  const name = await collectionName(root);
  const dir = completedDir(root);
  try {
    const exists = await collectionExists(root);
    if (exists) {
      // qmd update is global (all collections) — may fail due to unrelated
      // collections with missing source dirs. Non-fatal: our collection still updates.
      try {
        await $`qmd update`.quiet();
      } catch {
        // ignore global update failures
      }
    } else {
      await $`qmd collection add ${dir} --name ${name}`.quiet();
      await $`qmd context add ${dir} "AI coding session transcripts and reasoning"`.quiet();
    }
    await $`qmd embed`.quiet();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `command failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Search sessions via QMD */
export async function searchSessions(query: string, opts?: { tag?: string; collection?: string }): Promise<string> {
  if (!(await isQmdAvailable())) {
    return "QMD is not installed. Run `ghost enable` to install, or: bun install -g github:tobi/qmd";
  }
  const name = opts?.collection || (await collectionName());
  try {
    const result = await $`qmd query -c ${name} ${query}`.quiet();
    return result.text().trim();
  } catch {
    return "";
  }
}

/** Create initial QMD collection for the project. Returns true if successful. */
export async function createCollection(root: string): Promise<boolean> {
  if (!(await isQmdAvailable())) return false;
  const name = await collectionName(root);
  const dir = completedDir(root);
  try {
    if (await collectionExists(root)) return true;
    await $`qmd collection add ${dir} --name ${name}`.quiet();
    await $`qmd context add ${dir} "AI coding session transcripts and reasoning"`.quiet();
    return true;
  } catch {
    return false;
  }
}

/** Remove a QMD collection by name. Used by reset and test cleanup. */
export async function removeCollection(name: string): Promise<void> {
  if (!(await isQmdAvailable())) return;
  try {
    await $`qmd collection remove ${name}`.quiet();
  } catch {
    // Collection may not exist
  }
}

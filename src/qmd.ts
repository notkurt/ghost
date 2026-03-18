import { basename } from "node:path";
import { $ } from "bun";
import { checkQmd, resetDepCache } from "./deps.js";
import { mainRepoRoot } from "./git.js";
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

/** Derive the QMD collection name from the main repo root (stable across worktrees) */
export async function collectionName(root?: string): Promise<string> {
  const r = await mainRepoRoot(root);
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
      // collectionExists may return false even when the collection exists
      // (e.g. qmd list fails in background subprocess context). Handle gracefully.
      try {
        await $`qmd collection add ${dir} --name ${name}`.quiet();
        await $`qmd context add ${dir} "AI coding session transcripts and reasoning"`.quiet();
      } catch (addErr) {
        const stderr = (addErr as { stderr?: { toString(): string } })?.stderr?.toString() ?? "";
        if (!stderr.includes("already exists")) {
          return {
            ok: false,
            reason: `collection add failed: ${stderr.trim() || (addErr instanceof Error ? addErr.message : String(addErr))}`,
          };
        }
        // Collection already exists despite collectionExists returning false — continue to embed
      }
    }
    await $`qmd embed`.quiet();
    return { ok: true };
  } catch (err) {
    const stderr = (err as { stderr?: { toString(): string } })?.stderr?.toString() ?? "";
    return {
      ok: false,
      reason: `command failed: ${stderr.trim() || (err instanceof Error ? err.message : String(err))}`,
    };
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

/** Create initial QMD collection for the project. Returns { ok, reason } for diagnostic output. */
export async function createCollection(root: string): Promise<{ ok: boolean; reason?: string }> {
  if (!(await isQmdAvailable())) return { ok: false, reason: "qmd not available" };
  const name = await collectionName(root);
  const dir = completedDir(root);
  try {
    if (await collectionExists(root)) return { ok: true };
    await $`qmd collection add ${dir} --name ${name}`.quiet();
    await $`qmd context add ${dir} "AI coding session transcripts and reasoning"`.quiet();
    return { ok: true };
  } catch (err) {
    // If collection already exists (collectionExists may have failed to detect it),
    // treat as success. Bun ShellError puts the actual message in stderr.
    const stderr = (err as { stderr?: { toString(): string } })?.stderr?.toString() ?? "";
    const msg = `${err instanceof Error ? err.message : String(err)} ${stderr}`;
    if (msg.includes("already exists")) return { ok: true };
    return { ok: false, reason: stderr.trim() || (err instanceof Error ? err.message : String(msg)).trim() };
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

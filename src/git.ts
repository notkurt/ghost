import { $ } from "bun";

// =============================================================================
// Git Operations
// =============================================================================

const NOTES_REF = "ai-sessions";

/** Get the git repository root directory */
export async function repoRoot(): Promise<string> {
  const result = await $`git rev-parse --show-toplevel`.quiet();
  return result.text().trim();
}

/** Get the current branch name */
export async function currentBranch(): Promise<string> {
  const result = await $`git branch --show-current`.quiet();
  return result.text().trim();
}

/** Get the HEAD commit SHA */
export async function headSha(): Promise<string> {
  const result = await $`git rev-parse HEAD`.quiet();
  return result.text().trim();
}

/** Get abbreviated diff stat */
export async function diffStat(): Promise<string> {
  try {
    const result = await $`git diff --stat`.quiet();
    return result.text().trim();
  } catch {
    return "";
  }
}

/** Add a git note to a commit */
export async function addNote(content: string, sha: string): Promise<void> {
  await $`git notes --ref=${NOTES_REF} add -f -m ${content} ${sha}`.quiet();
}

/** Add a git note from a file */
export async function addNoteFromFile(filePath: string, sha: string): Promise<void> {
  await $`git notes --ref=${NOTES_REF} add -f -F ${filePath} ${sha}`.quiet();
}

/** Show the git note for a commit */
export async function showNote(sha: string): Promise<string | null> {
  try {
    const result = await $`git notes --ref=${NOTES_REF} show ${sha}`.quiet();
    return result.text().trim();
  } catch {
    return null;
  }
}

/** Set a git config value */
export async function configSet(key: string, value: string): Promise<void> {
  await $`git config ${key} ${value}`.quiet();
}

/** Get a git config value */
export async function configGet(key: string): Promise<string | null> {
  try {
    const result = await $`git config --get ${key}`.quiet();
    return result.text().trim();
  } catch {
    return null;
  }
}

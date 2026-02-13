import { homedir } from "node:os";
import { $ } from "bun";

// =============================================================================
// Dependency Detection & Installation
// =============================================================================

export interface DepStatus {
  available: boolean;
  version?: string;
  path?: string;
}

// Ensure common binary paths are on PATH — Claude Code hooks run in a
// restricted environment that often omits ~/.bun/bin, /opt/homebrew/bin, etc.
const home = homedir();
const extraPaths = [`${home}/.bun/bin`, "/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`];
const currentPath = process.env.PATH || "";
const missing = extraPaths.filter((p) => !currentPath.split(":").includes(p));
if (missing.length > 0) {
  process.env.PATH = [...missing, currentPath].join(":");
}

// Cache results per process
const _cache: Record<string, DepStatus> = {};

/** Check if a binary is available on PATH */
async function checkBinary(name: string): Promise<DepStatus> {
  if (_cache[name]) return _cache[name]!;
  try {
    // Use Bun.which() — more reliable than shell `command -v` in hook subprocesses
    const binPath = Bun.which(name);
    if (!binPath) throw new Error("not found");
    let version: string | undefined;
    try {
      const verResult = await $`${binPath} --version`.quiet();
      version = verResult.text().trim().split("\n")[0];
    } catch {
      // Some binaries don't have --version
    }
    _cache[name] = { available: true, version, path: binPath };
  } catch {
    _cache[name] = { available: false };
  }
  return _cache[name]!;
}

/** Reset the dependency cache (for testing) */
export function resetDepCache(): void {
  for (const key of Object.keys(_cache)) {
    delete _cache[key];
  }
}

// =============================================================================
// Individual Dependency Checks
// =============================================================================

/** Check if qmd is installed */
export async function checkQmd(): Promise<DepStatus> {
  return checkBinary("qmd");
}

/** Check if claude CLI is installed */
export async function checkClaude(): Promise<DepStatus> {
  return checkBinary("claude");
}

/** Check if brew sqlite is installed (required for sqlite-vec on macOS) */
export async function checkBrewSqlite(): Promise<DepStatus> {
  if (_cache["brew-sqlite"]) return _cache["brew-sqlite"]!;
  try {
    await $`brew list sqlite`.quiet();
    _cache["brew-sqlite"] = { available: true };
  } catch {
    _cache["brew-sqlite"] = { available: false };
  }
  return _cache["brew-sqlite"]!;
}

/** Check if bun is available (always true if we're running in bun) */
export async function checkBun(): Promise<DepStatus> {
  // If we're executing, bun is available
  const version = Bun.version;
  return { available: true, version, path: process.execPath };
}

// =============================================================================
// Installation
// =============================================================================

/** Install qmd globally via bun */
export async function installQmd(): Promise<boolean> {
  console.log("Installing qmd...");
  try {
    const _result = await $`bun install -g github:tobi/qmd`.quiet();
    resetDepCache();
    const check = await checkQmd();
    if (check.available) {
      console.log(`  qmd installed successfully.`);
      return true;
    }
    console.error("  qmd installation completed but binary not found on PATH.");
    console.error("  Ensure ~/.bun/bin is in your PATH.");
    return false;
  } catch (err) {
    console.error(`  qmd installation failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Install sqlite via Homebrew (macOS only) */
export async function installBrewSqlite(): Promise<boolean> {
  console.log("Installing sqlite via Homebrew...");
  try {
    await $`brew install sqlite`.quiet();
    resetDepCache();
    console.log("  sqlite installed successfully.");
    return true;
  } catch (err) {
    console.error(`  sqlite installation failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// =============================================================================
// Full Dependency Report
// =============================================================================

export interface DepsReport {
  qmd: DepStatus;
  claude: DepStatus;
  sqlite: DepStatus;
  bun: DepStatus;
}

/** Check all dependencies and return a report */
export async function checkAllDeps(): Promise<DepsReport> {
  const [qmd, claude, sqlite, bun] = await Promise.all([checkQmd(), checkClaude(), checkBrewSqlite(), checkBun()]);
  return { qmd, claude, sqlite, bun };
}

/** Print a dependency status report */
export function printDepsReport(report: DepsReport): void {
  const ok = (s: DepStatus) => (s.available ? "installed" : "missing");
  const ver = (s: DepStatus) => (s.version ? ` (${s.version})` : "");

  console.log(`  bun: ${ok(report.bun)}${ver(report.bun)}`);
  console.log(`  qmd: ${ok(report.qmd)}${ver(report.qmd)}`);
  console.log(`  claude: ${ok(report.claude)}${ver(report.claude)}`);
  console.log(`  sqlite (brew): ${ok(report.sqlite)}`);
}

/** Return list of missing dependencies needed for full functionality */
export function getMissingDeps(report: DepsReport): string[] {
  const missing: string[] = [];
  if (!report.sqlite.available) missing.push("sqlite");
  if (!report.qmd.available) missing.push("qmd");
  if (!report.claude.available) missing.push("claude");
  return missing;
}

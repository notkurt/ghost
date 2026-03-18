import { homedir } from "node:os";
import { join } from "node:path";
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
const currentEntries = currentPath.split(":").map((p) => p.replace(/\/+$/, ""));
const missing = extraPaths.filter((p) => !currentEntries.includes(p));
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

/** Check if qmd is installed and functional.
 *  The binary shim may exist on PATH but point to a missing dist/ directory
 *  (e.g. when `bun install -g` didn't run the build step). We verify by
 *  running `qmd collection list` which exercises the actual module. */
export async function checkQmd(): Promise<DepStatus> {
  const base = await checkBinary("qmd");
  if (!base.available) return base;
  // Verify qmd can actually execute — not just that the shim exists
  try {
    await $`qmd collection list`.quiet();
    return base;
  } catch (err) {
    const stderr = (err as { stderr?: { toString(): string } })?.stderr?.toString() ?? "";
    const msg = stderr || (err instanceof Error ? err.message : String(err));
    // Module not found = broken install (shim exists but dist/ missing)
    if (msg.includes("Module not found") || msg.includes("Cannot find module")) {
      _cache.qmd = { available: false, version: "broken install", path: base.path };
      return _cache.qmd!;
    }
    // Other errors (e.g. no collections yet) are fine — qmd itself works
    return base;
  }
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
    // Binary exists but module missing — try running the build step
    if (check.version === "broken install") {
      console.log("  qmd shim installed but build step did not run. Building...");
      const pkgDir = join(home, ".bun", "install", "global", "node_modules", "@tobilu", "qmd");
      try {
        await $`cd ${pkgDir} && bun run build`.quiet();
        resetDepCache();
        const recheck = await checkQmd();
        if (recheck.available) {
          console.log(`  qmd built and installed successfully.`);
          return true;
        }
      } catch (buildErr) {
        const stderr = (buildErr as { stderr?: { toString(): string } })?.stderr?.toString() ?? "";
        console.error(
          `  qmd build failed: ${stderr.trim() || (buildErr instanceof Error ? buildErr.message : String(buildErr))}`,
        );
      }
      console.error(`  qmd build did not produce a working install.`);
      console.error(`  Try manually: cd ${pkgDir} && bun run build`);
      return false;
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
  if (report.qmd.version === "broken install") {
    const qmdPkgDir = join(home, ".bun", "install", "global", "node_modules", "@tobilu", "qmd");
    console.log(`  qmd: broken install (shim exists but module missing)`);
    console.log(`        The qmd build step may not have run during installation.`);
    console.log(`        Fix: cd ${qmdPkgDir} && bun run build`);
    console.log(`        Or reinstall: bun install -g github:tobi/qmd --force`);
  } else {
    console.log(`  qmd: ${ok(report.qmd)}${ver(report.qmd)}`);
  }
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

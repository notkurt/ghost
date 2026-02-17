import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { completedDir, decisionsPath, knowledgePath, mistakesPath, strategiesPath, tagsPath } from "./paths.js";

// =============================================================================
// Validation Types
// =============================================================================

export interface ValidationIssue {
  file: string;
  line?: number;
  message: string;
  fixable: boolean;
}

// =============================================================================
// Session File Validation
// =============================================================================

/** Validate a session file's frontmatter and structure */
function validateSessionFile(filePath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const content = readFileSync(filePath, "utf8");
  const name = filePath.split("/").pop() || filePath;

  // Check frontmatter delimiters
  if (!content.startsWith("---\n")) {
    issues.push({ file: name, message: "Missing opening frontmatter delimiter (---)", fixable: false });
    return issues;
  }

  const closingIdx = content.indexOf("\n---\n", 4);
  if (closingIdx === -1) {
    // Check for closing delimiter without trailing newline
    const altIdx = content.indexOf("\n---", 4);
    if (altIdx === -1) {
      issues.push({ file: name, message: "Missing closing frontmatter delimiter (---)", fixable: false });
      return issues;
    }
  }

  // Try to parse YAML frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    try {
      const fm = YAML.parse(fmMatch[1]!) as Record<string, unknown>;

      // Check required fields
      if (!fm.session) {
        issues.push({ file: name, message: "Missing 'session' field in frontmatter", fixable: false });
      }
      if (!fm.started) {
        issues.push({ file: name, message: "Missing 'started' field in frontmatter", fixable: false });
      }

      // Check tags is an array
      if (fm.tags !== undefined && !Array.isArray(fm.tags)) {
        issues.push({ file: name, message: "'tags' field should be an array", fixable: true });
      }

      // Check dates are valid ISO strings
      if (fm.started && Number.isNaN(new Date(fm.started as string).getTime())) {
        issues.push({ file: name, message: `Invalid 'started' date: ${fm.started}`, fixable: false });
      }
      if (fm.ended && Number.isNaN(new Date(fm.ended as string).getTime())) {
        issues.push({ file: name, message: `Invalid 'ended' date: ${fm.ended}`, fixable: false });
      }
    } catch (err) {
      issues.push({
        file: name,
        message: `Invalid YAML in frontmatter: ${err instanceof Error ? err.message : String(err)}`,
        fixable: false,
      });
    }
  }

  return issues;
}

// =============================================================================
// Tags Index Validation
// =============================================================================

/** Validate tags.json structure */
function validateTagsFile(filePath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  try {
    const content = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content);

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      issues.push({
        file: "tags.json",
        message: "tags.json should be an object mapping tags to session ID arrays",
        fixable: false,
      });
      return issues;
    }

    for (const [tag, ids] of Object.entries(parsed)) {
      if (!Array.isArray(ids)) {
        issues.push({
          file: "tags.json",
          message: `Tag "${tag}" should map to an array of session IDs`,
          fixable: true,
        });
      } else {
        for (const id of ids) {
          if (typeof id !== "string") {
            issues.push({
              file: "tags.json",
              message: `Tag "${tag}" contains non-string session ID: ${JSON.stringify(id)}`,
              fixable: true,
            });
          }
        }
      }
    }
  } catch (err) {
    issues.push({
      file: "tags.json",
      message: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      fixable: false,
    });
  }

  return issues;
}

// =============================================================================
// Repair
// =============================================================================

/** Attempt to fix a session file's frontmatter */
function repairSessionFile(filePath: string): boolean {
  const content = readFileSync(filePath, "utf8");
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return false;

  try {
    const fm = YAML.parse(fmMatch[1]!) as Record<string, unknown>;
    let changed = false;

    // Fix tags being a non-array
    if (fm.tags !== undefined && !Array.isArray(fm.tags)) {
      if (typeof fm.tags === "string") {
        fm.tags = (fm.tags as string)
          .split(",")
          .map((t: string) => t.trim())
          .filter((t: string) => t);
      } else {
        fm.tags = [];
      }
      changed = true;
    }

    if (changed) {
      const body = content.slice(fmMatch[0].length);
      const newContent = `---\n${YAML.stringify(fm).trim()}\n---${body}`;
      writeFileSync(filePath, newContent);
      return true;
    }
  } catch {
    // Can't repair if YAML is unparseable
  }
  return false;
}

/** Attempt to fix tags.json */
function repairTagsFile(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;

    let changed = false;
    const fixed: Record<string, string[]> = {};

    for (const [tag, ids] of Object.entries(parsed)) {
      if (!Array.isArray(ids)) {
        fixed[tag] = typeof ids === "string" ? [ids] : [];
        changed = true;
      } else {
        fixed[tag] = ids.filter((id): id is string => typeof id === "string");
        if (fixed[tag]!.length !== (ids as unknown[]).length) changed = true;
      }
    }

    if (changed) {
      writeFileSync(filePath, `${JSON.stringify(fixed, null, 2)}\n`);
      return true;
    }
  } catch {
    // Can't repair if JSON is unparseable
  }
  return false;
}

// =============================================================================
// Full Validation
// =============================================================================

/** Validate all ghost files in the repo, optionally repair fixable issues */
export function validate(repoRoot: string, opts?: { fix?: boolean }): ValidationIssue[] {
  const allIssues: ValidationIssue[] = [];

  // Validate completed session files
  const compDir = completedDir(repoRoot);
  if (existsSync(compDir)) {
    const files = readdirSync(compDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const filePath = join(compDir, file);
      const issues = validateSessionFile(filePath);
      allIssues.push(...issues);
      if (opts?.fix && issues.some((i) => i.fixable)) {
        repairSessionFile(filePath);
      }
    }
  }

  // Validate tags.json
  const tPath = tagsPath(repoRoot);
  if (existsSync(tPath)) {
    const issues = validateTagsFile(tPath);
    allIssues.push(...issues);
    if (opts?.fix && issues.some((i) => i.fixable)) {
      repairTagsFile(tPath);
    }
  }

  // Check knowledge.md is readable markdown
  const kPath = knowledgePath(repoRoot);
  if (existsSync(kPath)) {
    const content = readFileSync(kPath, "utf8");
    if (!content.trim()) {
      allIssues.push({ file: "knowledge.md", message: "File is empty", fixable: false });
    }
  }

  // Check mistakes.md, decisions.md, and strategies.md aren't malformed
  for (const [name, path] of [
    ["mistakes.md", mistakesPath(repoRoot)],
    ["decisions.md", decisionsPath(repoRoot)],
    ["strategies.md", strategiesPath(repoRoot)],
  ] as const) {
    if (existsSync(path)) {
      try {
        readFileSync(path, "utf8");
      } catch {
        allIssues.push({ file: name, message: "File is not readable", fixable: false });
      }
    }
  }

  return allIssues;
}

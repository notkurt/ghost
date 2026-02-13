import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkClaude } from "./deps.js";
import { completedDir, decisionsPath, knowledgePath, mistakesPath, SESSION_DIR } from "./paths.js";
import { searchSessions } from "./qmd.js";
import type { KnowledgeEntry } from "./session.js";
import { appendDecision, appendMistake, deriveArea, listCompletedSessions, parseKnowledgeEntries } from "./session.js";

// =============================================================================
// Claude CLI Check
// =============================================================================

async function requireClaude(action: string): Promise<boolean> {
  const status = await checkClaude();
  if (!status.available) {
    console.error(`claude CLI not found — ${action} requires it.`);
    console.error("Install: https://claude.ai/download");
    return false;
  }
  return true;
}

// =============================================================================
// Knowledge Base
// =============================================================================

const KNOWLEDGE_PROMPT = `You are consolidating AI coding session summaries into a project knowledge base.
Read the existing knowledge base (if any) and the new session summaries.
Merge new information into the knowledge base, updating existing sections and adding new ones as needed.
Keep the following fixed sections:

# Project Knowledge Base

## Architecture
Key architectural patterns, file structure, tech stack.

## Conventions
Coding conventions, naming patterns, testing approaches.

## Key Decisions
Important technical decisions organized by component area.
Include file paths so the AI knows exactly where decisions apply.
If a decision includes an assertion rule, preserve it verbatim.

## Gotchas
Known issues organized by component area.
Include file paths and dead-end approaches (what was tried and failed).
If a gotcha includes an assertion rule, preserve it verbatim.
Deduplicate entries describing the same issue.

## Patterns That Work
Proven approaches for common tasks.

## Open Threads
Unresolved items, things still being explored.

Keep it concise. Remove outdated info. Add date references where helpful.`;

/** Rebuild the knowledge base from all completed sessions */
export async function buildKnowledge(repoRoot: string): Promise<void> {
  if (!(await requireClaude("knowledge build"))) return;

  const sessions = listCompletedSessions(repoRoot);
  if (sessions.length === 0) {
    console.log("No completed sessions to build knowledge from.");
    return;
  }

  // Gather all session summaries
  const summaries: string[] = [];
  for (const id of sessions) {
    const path = join(completedDir(repoRoot), `${id}.md`);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    const summaryMatch = content.match(/## Summary\n([\s\S]*?)$/);
    if (summaryMatch) {
      summaries.push(`### Session ${id}\n${summaryMatch[1]!.trim()}`);
    }
  }

  if (summaries.length === 0) {
    console.log("No session summaries found. Run sessions first or wait for AI summarization.");
    return;
  }

  const existing = existsSync(knowledgePath(repoRoot)) ? readFileSync(knowledgePath(repoRoot), "utf8") : "";

  // Build structured knowledge grouped by area
  const mistakeEntries = parseKnowledgeEntries(
    existsSync(mistakesPath(repoRoot)) ? readFileSync(mistakesPath(repoRoot), "utf8") : "",
  );
  const decisionEntries = parseKnowledgeEntries(
    existsSync(decisionsPath(repoRoot)) ? readFileSync(decisionsPath(repoRoot), "utf8") : "",
  );

  const byArea: Record<string, { mistakes: KnowledgeEntry[]; decisions: KnowledgeEntry[] }> = {};
  for (const e of mistakeEntries) {
    if (!byArea[e.area]) byArea[e.area] = { mistakes: [], decisions: [] };
    byArea[e.area]!.mistakes.push(e);
  }
  for (const e of decisionEntries) {
    if (!byArea[e.area]) byArea[e.area] = { mistakes: [], decisions: [] };
    byArea[e.area]!.decisions.push(e);
  }

  let structuredInput = "";
  if (Object.keys(byArea).length > 0) {
    structuredInput = "\nSTRUCTURED KNOWLEDGE BY AREA:\n";
    for (const [area, data] of Object.entries(byArea)) {
      structuredInput += `\n### Area: ${area}\n`;
      for (const m of data.mistakes) {
        structuredInput += `- MISTAKE: ${m.title} (files: ${m.files.join(", ")})`;
        if (m.tried.length) structuredInput += ` [tried: ${m.tried.join(", ")}]`;
        if (m.rule) structuredInput += ` [RULE: ${m.rule}]`;
        structuredInput += `\n  ${m.description}\n`;
      }
      for (const d of data.decisions) {
        structuredInput += `- DECISION: ${d.title} (files: ${d.files.join(", ")})`;
        if (d.rule) structuredInput += ` [RULE: ${d.rule}]`;
        structuredInput += `\n  ${d.description}\n`;
      }
    }
  }

  const input = `${existing ? `EXISTING KNOWLEDGE BASE:\n${existing}\n\n` : ""}NEW SESSION SUMMARIES:\n${summaries.join("\n\n")}${structuredInput}`;

  try {
    const proc = Bun.spawn(["claude", "-p", KNOWLEDGE_PROMPT], {
      stdin: new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GHOST_INTERNAL: "1" },
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.error("Knowledge build failed — claude CLI returned non-zero.");
      return;
    }
    mkdirSync(join(repoRoot, SESSION_DIR), { recursive: true });
    const header = `_Auto-generated by Ghost. Last updated: ${new Date().toISOString().slice(0, 10)}_\n\n`;
    writeFileSync(knowledgePath(repoRoot), `${header + stdout.trim()}\n`);
    console.log("Knowledge base rebuilt.");
  } catch (err) {
    console.error(`Knowledge build failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Append/symlink knowledge base to CLAUDE.md */
export async function injectKnowledge(repoRoot: string): Promise<void> {
  const kPath = knowledgePath(repoRoot);
  if (!existsSync(kPath)) {
    console.log("No knowledge base found. Run `ghost knowledge build` first.");
    return;
  }

  const claudeMdPath = join(repoRoot, "CLAUDE.md");
  const knowledge = readFileSync(kPath, "utf8");
  const marker = "<!-- ghost:knowledge -->";
  const block = `\n${marker}\n${knowledge}\n${marker}\n`;

  if (existsSync(claudeMdPath)) {
    const existing = readFileSync(claudeMdPath, "utf8");
    if (existing.includes(marker)) {
      const updated = existing.replace(new RegExp(`\\n?${marker}[\\s\\S]*?${marker}\\n?`), block);
      writeFileSync(claudeMdPath, updated);
    } else {
      writeFileSync(claudeMdPath, `${existing.trimEnd()}\n${block}`);
    }
  } else {
    writeFileSync(claudeMdPath, block);
  }
  console.log("Knowledge injected into CLAUDE.md.");
}

/** Print the current knowledge base */
export function showKnowledge(repoRoot: string): void {
  const kPath = knowledgePath(repoRoot);
  if (!existsSync(kPath)) {
    console.log("No knowledge base found. Run `ghost knowledge build` first.");
    return;
  }
  console.log(readFileSync(kPath, "utf8"));
}

/** Show what changed since last build (simplified diff) */
export function diffKnowledge(repoRoot: string): void {
  const kPath = knowledgePath(repoRoot);
  if (!existsSync(kPath)) {
    console.log("No knowledge base found.");
    return;
  }
  console.log("Current knowledge base (use `ghost knowledge build` to update):\n");
  console.log(readFileSync(kPath, "utf8"));
}

// =============================================================================
// Scope Briefing
// =============================================================================

const BRIEF_PROMPT = `Generate a scope briefing for the following work description, using the provided context from past sessions, decisions, known issues, and file modification frequency. Include:

## Brief: {title}

### Relevant Past Work
Sessions and what was done.

### Key Files
Files most likely to be involved, ranked by modification frequency.

### Relevant Decisions
Applicable past decisions.

### Watch Out For
Known gotchas and pitfalls from the mistake ledger.

### Suggested Starting Point
Where to begin.

Be concise and actionable.`;

/** Generate a scoped context brief */
export async function generateBrief(repoRoot: string, description: string): Promise<void> {
  if (!(await requireClaude("brief generation"))) return;

  const parts: string[] = [`WORK DESCRIPTION: ${description}\n`];

  // Search for relevant sessions via QMD
  const searchResults = await searchSessions(description);
  if (searchResults && !searchResults.startsWith("QMD is not installed")) {
    parts.push(`RELEVANT SESSIONS:\n${searchResults}\n`);
  }

  // Include decisions
  if (existsSync(decisionsPath(repoRoot))) {
    const decisions = readFileSync(decisionsPath(repoRoot), "utf8");
    if (decisions.trim()) {
      parts.push(`DECISION LOG:\n${decisions}\n`);
    }
  }

  // Include mistakes
  if (existsSync(mistakesPath(repoRoot))) {
    const mistakes = readFileSync(mistakesPath(repoRoot), "utf8");
    if (mistakes.trim()) {
      parts.push(`KNOWN ISSUES:\n${mistakes}\n`);
    }
  }

  // Include file heatmap data
  const heatmap = buildHeatmapData(repoRoot);
  if (heatmap.length > 0) {
    const top = heatmap.slice(0, 20);
    const heatmapStr = top.map(([file, count]) => `  ${count} changes | ${file}`).join("\n");
    parts.push(`FILE MODIFICATION FREQUENCY (top 20):\n${heatmapStr}\n`);
  }

  const input = parts.join("\n");

  try {
    const proc = Bun.spawn(["claude", "-p", BRIEF_PROMPT], {
      stdin: new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GHOST_INTERNAL: "1" },
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.error("Brief generation failed.");
      return;
    }
    console.log(stdout.trim());
  } catch (err) {
    console.error(`Brief generation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// =============================================================================
// Heatmap Data (shared with search.ts)
// =============================================================================

/** Build file modification frequency data from all completed sessions */
export function buildHeatmapData(repoRoot: string, sessionIds?: string[]): [string, number][] {
  const ids = sessionIds || listCompletedSessions(repoRoot);
  const counts: Record<string, number> = {};

  for (const id of ids) {
    const path = join(completedDir(repoRoot), `${id}.md`);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    const matches = content.matchAll(/^- Modified: (.+)$/gm);
    for (const match of matches) {
      const file = match[1]!;
      counts[file] = (counts[file] || 0) + 1;
    }
  }

  return Object.entries(counts).sort(([, a], [, b]) => b - a);
}

// =============================================================================
// Genesis — Initial Knowledge Base from Codebase
// =============================================================================

const GENESIS_PROMPT = `Analyze this codebase and generate an initial project knowledge base. This is the first time the project is being documented, so there are no prior sessions to draw from.

Return markdown with these sections:

# Project Knowledge Base

## Architecture
Key architectural patterns, file structure, tech stack. What frameworks, libraries, and languages are used? How is the code organized?

## Conventions
Coding conventions you observe: naming patterns, module structure, testing approaches, import style.

## Key Files
The most important files and what they do. Focus on entry points, config, and core business logic.

## Gotchas
Any potential issues you notice: missing error handling, hardcoded values, unusual patterns, things a developer should watch out for.

## Patterns That Work
Common patterns used throughout the codebase that should be followed for consistency.

## Open Threads
Areas that look incomplete, TODOs in the code, or things that might need attention.

Keep it concise and factual. Only document what you can observe in the code.`;

/** Build an initial knowledge base by analyzing the codebase (no sessions needed) */
export async function genesis(repoRoot: string): Promise<boolean> {
  if (!(await requireClaude("genesis"))) return false;

  console.log("Building initial knowledge base from codebase...");

  // Gather a snapshot of the project for analysis
  const parts: string[] = [];

  // List files in the project (respecting .gitignore via git ls-files)
  try {
    const { $ } = await import("bun");
    const result = await $`git -C ${repoRoot} ls-files`.quiet();
    const files = result.text().trim();
    if (files) {
      parts.push(`PROJECT FILES:\n${files}\n`);
    }
  } catch {
    // Fall back to nothing
  }

  // Read key files: package.json, README, config files, entry points
  const keyFiles = ["package.json", "Cargo.toml", "go.mod", "pyproject.toml", "Gemfile", "tsconfig.json", "CLAUDE.md"];
  for (const name of keyFiles) {
    const filePath = join(repoRoot, name);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf8");
      parts.push(`FILE: ${name}\n\`\`\`\n${content.slice(0, 3000)}\n\`\`\`\n`);
    }
  }

  // Read src/ directory structure if it exists
  try {
    const { $ } = await import("bun");
    const result = await $`git -C ${repoRoot} ls-files -- 'src/'`.quiet();
    const srcFiles = result.text().trim();
    if (srcFiles) {
      // Read first few source files to understand patterns
      const files = srcFiles.split("\n").slice(0, 10);
      for (const f of files) {
        const filePath = join(repoRoot, f);
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, "utf8");
          parts.push(`FILE: ${f}\n\`\`\`\n${content.slice(0, 2000)}\n\`\`\`\n`);
        }
      }
    }
  } catch {
    // Not every project has src/
  }

  if (parts.length === 0) {
    console.log("No files found to analyze.");
    return false;
  }

  const input = parts.join("\n");

  try {
    const proc = Bun.spawn(["claude", "-p", GENESIS_PROMPT], {
      stdin: new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GHOST_INTERNAL: "1" },
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.error("Genesis failed — claude CLI returned non-zero.");
      return false;
    }
    mkdirSync(join(repoRoot, SESSION_DIR), { recursive: true });
    const header = `_Auto-generated by Ghost (genesis). Last updated: ${new Date().toISOString().slice(0, 10)}_\n\n`;
    writeFileSync(knowledgePath(repoRoot), `${header + stdout.trim()}\n`);
    console.log("Initial knowledge base created.");
    return true;
  } catch (err) {
    console.error(`Genesis failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Check if knowledge base should be rebuilt (every N sessions) */
export function shouldRebuildKnowledge(repoRoot: string, threshold: number = 5): boolean {
  const sessions = listCompletedSessions(repoRoot);
  const kPath = knowledgePath(repoRoot);

  if (!existsSync(kPath)) return sessions.length >= threshold;

  // Check how many sessions since last build
  const knowledgeModified = Bun.file(kPath).lastModified;
  const newSessions = sessions.filter((id) => {
    const path = join(completedDir(repoRoot), `${id}.md`);
    if (!existsSync(path)) return false;
    return Bun.file(path).lastModified > knowledgeModified;
  });

  return newSessions.length >= threshold;
}

// =============================================================================
// Absorb — Distill CLAUDE.md into Ghost knowledge
// =============================================================================

const ABSORB_PROMPT = `You are distilling a CLAUDE.md file into Ghost's structured knowledge system.

Read the CLAUDE.md content provided. Categorize everything into four buckets:

1. **claudeMd** — The slimmed-down CLAUDE.md to write back. Keep ONLY:
   - Hard rules (NEVER/ALWAYS statements)
   - Project overview (1-2 paragraphs max)
   - Tech stack (one line)
   - Commands to run for checks/dev (keep command tables concise)
   - Essential workflow rules
   Condense verbose examples to single-line rules. Remove code blocks — just state the rule.
   Remove any <!-- ghost:knowledge --> blocks entirely (Ghost will re-inject if needed).
   The result should be a focused, compact project rules file — not documentation.

2. **knowledge** — Architecture descriptions, file structure docs, how systems work, patterns, conventions with context. This becomes the knowledge.md file content. Use markdown sections (## headings). Be thorough but concise.

3. **decisions** — Anything phrased as "we chose X because Y", technology choices, architectural decisions, design choices. Return as an array of objects with:
   - text: "**Title**: Description of the decision and rationale"
   - files: array of relevant file paths (can be empty)
   - rule: assertion rule if one exists (e.g., "ALWAYS use X for Y"), empty string otherwise

4. **mistakes** — Gotchas, pitfalls, "never do X because Y", things that went wrong, common errors. Return as an array of objects with:
   - text: "**Title**: Description of the mistake/gotcha"
   - files: array of relevant file paths (can be empty)
   - tried: array of approaches that failed (can be empty)
   - rule: assertion rule if one exists (e.g., "NEVER do X"), empty string otherwise

IMPORTANT:
- Do NOT fabricate content. Only extract what's actually in the CLAUDE.md.
- If existing Ghost knowledge files are provided, avoid duplicating entries that already exist.
- Decisions and mistakes should be specific and actionable, not vague.

Return ONLY valid JSON (no markdown fences, no explanation) with this exact shape:
{
  "claudeMd": "string with the slim CLAUDE.md content",
  "knowledge": "string with knowledge.md content",
  "decisions": [{"text": "...", "files": [...], "rule": "..."}],
  "mistakes": [{"text": "...", "files": [...], "tried": [...], "rule": "..."}]
}`;

interface AbsorbResult {
  claudeMd: string;
  knowledge: string;
  decisions: { text: string; files: string[]; rule: string }[];
  mistakes: { text: string; files: string[]; tried: string[]; rule: string }[];
}

/** Absorb CLAUDE.md content into Ghost's structured knowledge system */
export async function absorb(repoRoot: string, opts?: { dryRun?: boolean }): Promise<void> {
  if (!(await requireClaude("absorb"))) return;

  const claudeMdPath = join(repoRoot, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) {
    console.error("No CLAUDE.md found in repository root.");
    process.exit(1);
  }

  const claudeMd = readFileSync(claudeMdPath, "utf8");
  if (!claudeMd.trim()) {
    console.error("CLAUDE.md is empty.");
    process.exit(1);
  }

  // Read existing knowledge files to avoid duplicates
  const existingKnowledge = existsSync(knowledgePath(repoRoot)) ? readFileSync(knowledgePath(repoRoot), "utf8") : "";
  const existingDecisions = existsSync(decisionsPath(repoRoot)) ? readFileSync(decisionsPath(repoRoot), "utf8") : "";
  const existingMistakes = existsSync(mistakesPath(repoRoot)) ? readFileSync(mistakesPath(repoRoot), "utf8") : "";

  const parts: string[] = [`CLAUDE.md CONTENT:\n${claudeMd}`];
  if (existingKnowledge.trim()) parts.push(`\nEXISTING knowledge.md:\n${existingKnowledge}`);
  if (existingDecisions.trim()) parts.push(`\nEXISTING decisions.md:\n${existingDecisions}`);
  if (existingMistakes.trim()) parts.push(`\nEXISTING mistakes.md:\n${existingMistakes}`);

  const input = parts.join("\n");

  console.log("Analyzing CLAUDE.md...");

  let result: AbsorbResult;
  try {
    const proc = Bun.spawn(["claude", "-p", ABSORB_PROMPT], {
      stdin: new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GHOST_INTERNAL: "1" },
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.error("Absorb failed — claude CLI returned non-zero.");
      return;
    }

    // Parse JSON from response (strip markdown fences, preamble, etc.)
    const fenceMatch = stdout.match(/```json?\s*\n([\s\S]*?)\n\s*```/);
    const jsonStr = fenceMatch ? fenceMatch[1]!.trim() : stdout.trim();
    result = JSON.parse(jsonStr) as AbsorbResult;
  } catch (err) {
    console.error(`Absorb failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Print summary
  const decisionCount = result.decisions.length;
  const mistakeCount = result.mistakes.length;
  const hasKnowledge = result.knowledge.trim().length > 0;
  const originalLines = claudeMd.split("\n").length;
  const newLines = result.claudeMd.split("\n").length;

  console.log(`\nExtracted:`);
  console.log(`  ${decisionCount} decision(s)`);
  console.log(`  ${mistakeCount} mistake(s)`);
  console.log(`  ${hasKnowledge ? "Architecture/conventions content for knowledge.md" : "No knowledge content"}`);
  console.log(`  CLAUDE.md: ${originalLines} → ${newLines} lines`);

  if (opts?.dryRun) {
    console.log("\n--- Dry run: no files written ---");
    if (decisionCount > 0) {
      console.log("\nDecisions that would be added:");
      for (const d of result.decisions) {
        console.log(`  - ${d.text.slice(0, 100)}`);
      }
    }
    if (mistakeCount > 0) {
      console.log("\nMistakes that would be added:");
      for (const m of result.mistakes) {
        console.log(`  - ${m.text.slice(0, 100)}`);
      }
    }
    return;
  }

  // Ensure session dir exists
  mkdirSync(join(repoRoot, SESSION_DIR), { recursive: true });

  // Backup original CLAUDE.md
  const backupPath = `${claudeMdPath}.pre-absorb`;
  copyFileSync(claudeMdPath, backupPath);
  console.log(`\nBacked up CLAUDE.md → CLAUDE.md.pre-absorb`);

  // Write slim CLAUDE.md
  writeFileSync(claudeMdPath, `${result.claudeMd.trimEnd()}\n`);
  console.log("Wrote slim CLAUDE.md");

  // Write knowledge
  if (hasKnowledge) {
    const header = `_Auto-generated by Ghost (absorb). Last updated: ${new Date().toISOString().slice(0, 10)}_\n\n`;
    if (existingKnowledge.trim()) {
      // Append to existing knowledge
      writeFileSync(knowledgePath(repoRoot), `${existingKnowledge.trimEnd()}\n\n${result.knowledge.trim()}\n`);
    } else {
      writeFileSync(knowledgePath(repoRoot), `${header}${result.knowledge.trim()}\n`);
    }
    console.log("Updated knowledge.md");
  }

  // Append decisions
  const today = new Date().toISOString().slice(0, 10);
  for (const d of result.decisions) {
    const { title, description } = parseAbsorbText(d.text);
    appendDecision(repoRoot, {
      title,
      description,
      sessionId: "absorb",
      commitSha: "",
      files: d.files,
      area: d.files.length > 0 ? deriveArea(d.files) : "general",
      date: today,
      tried: [],
      rule: d.rule,
    });
  }
  if (decisionCount > 0) console.log(`Appended ${decisionCount} decision(s) to decisions.md`);

  // Append mistakes
  for (const m of result.mistakes) {
    const { title, description } = parseAbsorbText(m.text);
    appendMistake(repoRoot, {
      title,
      description,
      sessionId: "absorb",
      commitSha: "",
      files: m.files,
      area: m.files.length > 0 ? deriveArea(m.files) : "general",
      date: today,
      tried: m.tried || [],
      rule: m.rule,
    });
  }
  if (mistakeCount > 0) console.log(`Appended ${mistakeCount} mistake(s) to mistakes.md`);

  console.log("\nDone. Review the changes and commit when satisfied.");
}

/** Parse "**Title**: description" format from absorb results */
function parseAbsorbText(text: string): { title: string; description: string } {
  const boldMatch = text.match(/^\*\*(.+?)\*\*:\s*([\s\S]*)$/);
  if (boldMatch) {
    return { title: boldMatch[1]!.trim(), description: boldMatch[2]!.trim() };
  }
  const dotIdx = text.indexOf(". ");
  if (dotIdx > 0) {
    return { title: text.slice(0, dotIdx), description: text.slice(dotIdx + 2).trim() };
  }
  return { title: text, description: "" };
}

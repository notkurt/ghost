import { existsSync } from "node:fs";
import { checkClaude } from "./deps.js";

// =============================================================================
// AI Summarization
// =============================================================================

const SUMMARY_PROMPT = `Summarize this AI coding session. Return markdown with these sections:

## Intent
What was the developer trying to accomplish (1-2 sentences)

## Changes
Files modified and why (bullet list)

## Decisions
Key technical decisions made and reasoning. Only include significant decisions
involving architecture, technology choice, or approach selection.
Format each as:
**{short title}**: {context} → {decision} ({reasoning})
Files: {comma-separated file paths where this applies}
Rule: {if applicable, an assertion-style constraint: WHEN {context} NEVER/ALWAYS {action}}

The Files: and Rule: lines are optional — omit if not applicable.

## Mistakes
Anything that went wrong, was reverted, or required multiple attempts.
Format each as:
**{short description}**: What happened → Why it failed → Correct approach
Tried: {approaches that were attempted and failed, comma-separated}
Files: {comma-separated file paths where this applies}
Rule: {if applicable, an assertion-style constraint: WHEN {context} NEVER/ALWAYS {action}}

The Tried:, Files:, and Rule: lines are optional — omit if not applicable.

## Open Items
Anything left unfinished or flagged for follow-up

## Tags
Comma-separated topic tags inferred from the session content.
Use namespace:value format where appropriate (e.g. area:cart, type:bug-fix).`;

/** Run AI summarization on a session file via claude CLI */
export async function summarize(sessionPath: string): Promise<string | null> {
  if (!existsSync(sessionPath)) return null;

  // Check claude CLI availability before spawning
  const claude = await checkClaude();
  if (!claude.available) return null;

  try {
    const proc = Bun.spawn(["claude", "-p", SUMMARY_PROMPT], {
      stdin: Bun.file(sessionPath),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GHOST_INTERNAL: "1" },
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    return stdout.trim();
  } catch {
    return null;
  }
}

// =============================================================================
// Section Extraction
// =============================================================================

export interface ExtractedEntry {
  text: string;
  files: string[];
  tried: string[];
  rule: string;
}

export interface ExtractedSections {
  tags: string[];
  decisions: ExtractedEntry[];
  mistakes: ExtractedEntry[];
  intent: string;
  changes: string;
  openItems: string;
}

/** Extract structured sections from an AI summary */
export function extractSections(summary: string): ExtractedSections {
  return {
    tags: extractTags(summary),
    decisions: extractDecisionEntries(summary),
    mistakes: extractMistakeEntries(summary),
    intent: extractNamedSection(summary, "Intent"),
    changes: extractNamedSection(summary, "Changes"),
    openItems: extractNamedSection(summary, "Open Items"),
  };
}

/** Extract tags from the Tags section */
function extractTags(summary: string): string[] {
  const section = extractNamedSection(summary, "Tags");
  if (!section) return [];
  return section
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !t.startsWith("#"));
}

/** Parse a single entry block into ExtractedEntry with Files/Tried/Rule metadata */
function parseEntryBlock(block: string): ExtractedEntry {
  let text = block;
  let files: string[] = [];
  let tried: string[] = [];
  let rule = "";

  const filesMatch = text.match(/^Files:\s*(.+)$/m);
  if (filesMatch) {
    files = filesMatch[1]!
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
    text = text.replace(filesMatch[0], "");
  }

  const triedMatch = text.match(/^Tried:\s*(.+)$/m);
  if (triedMatch) {
    tried = triedMatch[1]!
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    text = text.replace(triedMatch[0], "");
  }

  const ruleMatch = text.match(/^Rule:\s*(.+)$/m);
  if (ruleMatch) {
    rule = ruleMatch[1]!.trim();
    text = text.replace(ruleMatch[0], "");
  }

  // Clean up extra blank lines from removed metadata lines
  text = text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .join("\n")
    .trim();

  return { text, files, tried, rule };
}

/** Extract individual decision entries */
export function extractDecisionEntries(summary: string): ExtractedEntry[] {
  const section = extractNamedSection(summary, "Decisions");
  if (!section || section.toLowerCase().includes("none")) return [];
  const blocks = section.split(/\n(?=\*\*)/).filter((e) => e.trim());
  return blocks.map((b) => parseEntryBlock(b.trim()));
}

/** Extract individual mistake entries */
export function extractMistakeEntries(summary: string): ExtractedEntry[] {
  const section = extractNamedSection(summary, "Mistakes");
  if (!section || section.toLowerCase().includes("none this session")) return [];
  const blocks = section.split(/\n(?=\*\*)/).filter((e) => e.trim());
  return blocks.map((b) => parseEntryBlock(b.trim()));
}

/** Extract a named section from markdown */
function extractNamedSection(content: string, sectionName: string): string {
  const regex = new RegExp(`##\\s+${sectionName}\\n([\\s\\S]*?)(?=\\n##\\s|$)`);
  const match = content.match(regex);
  return match ? match[1]!.trim() : "";
}

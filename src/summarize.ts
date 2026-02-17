import { existsSync } from "node:fs";
import { checkClaude } from "./deps.js";

// =============================================================================
// AI Summarization
// =============================================================================

const SUMMARY_PROMPT = `You MUST return ONLY the structured markdown sections below. Do NOT write conversational text. Every response must start with \`## Intent\`.

Summarize this AI coding session. Return markdown with these sections:

## Intent
What was the developer trying to accomplish (1-2 sentences)

## Changes
Files modified and why (bullet list). Use repo-relative paths (not absolute).

## Knowledge
Architectural insights, patterns, conventions, or system understanding gained in this session.
Only include knowledge that would help a future developer working in the same area.
If none, write "None" on its own line.
Format: **{topic}**: {what was learned or documented}
Files: {comma-separated repo-relative file paths}
The Files: line is optional.

## Decisions
Key technical decisions made and reasoning. Only include decisions where there was a
genuine choice between alternatives — architecture, algorithm, API design, data model,
update strategies, object lifecycle management, sync approaches.
Do NOT include: where documentation was placed, file naming, routine implementation choices,
or anything that followed an obvious existing pattern.
If no significant decisions were made, write "None" on its own line.
Format each as:
**{short title}**: {context} → {decision} ({reasoning})
Files: {comma-separated repo-relative file paths where this applies}
Rule: {if applicable, an assertion-style constraint: WHEN {context} NEVER/ALWAYS {action}}

The Files: and Rule: lines are optional — omit if not applicable.

Pay special attention to user questions phrased as "should we...", "what if we...", "would it be better to..." — these indicate important architectural thinking that MUST appear in either Decisions (if resolved) or Strategies (if open).

## Strategies
Trade-offs, approaches, and design alternatives explored or discussed in this session,
whether or not a final decision was reached. Include alternative approaches compared,
questions about how to approach a problem, and design trade-offs weighed.
If none, write "None" on its own line.
Format: **{problem/question}**: {approaches considered} → {outcome or "unresolved"}
Files: {comma-separated repo-relative file paths}
The Files: line is optional.

## Mistakes
Anything that went wrong, was reverted, or required multiple attempts.
Only include actual errors, bugs, or failed approaches — not the absence of mistakes.
If nothing went wrong, write "None" on its own line.
Format each as:
**{short description}**: What happened → Why it failed → Correct approach
Tried: {approaches that were attempted and failed, comma-separated}
Files: {comma-separated repo-relative file paths where this applies}
Rule: {if applicable, an assertion-style constraint: WHEN {context} NEVER/ALWAYS {action}}

The Tried:, Files:, and Rule: lines are optional — omit if not applicable.

## Open Items
Anything left unfinished or flagged for follow-up

## Relevance
Assess whether this session contains knowledge worth preserving for future project context.
Write "skip" on its own line if the session is NOT relevant — e.g. test/demo chats, conversations about
the AI itself, troubleshooting the tooling rather than the project, trivial or throwaway interactions,
or anything that would add noise rather than signal to the project knowledge base.
Write "keep" on its own line if the session contains useful project context (decisions, patterns, mistakes, etc.).
Default to "keep" if uncertain.

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
  strategies: ExtractedEntry[];
  knowledge: ExtractedEntry[];
  intent: string;
  changes: string;
  openItems: string;
  skipKnowledge: boolean;
}

/** Extract structured sections from an AI summary */
export function extractSections(summary: string): ExtractedSections {
  return {
    tags: extractTags(summary),
    decisions: extractDecisionEntries(summary),
    mistakes: extractMistakeEntries(summary),
    strategies: extractStrategyEntries(summary),
    knowledge: extractKnowledgeEntries(summary),
    intent: extractNamedSection(summary, "Intent"),
    changes: extractNamedSection(summary, "Changes"),
    openItems: extractNamedSection(summary, "Open Items"),
    skipKnowledge: extractSkipKnowledge(summary),
  };
}

/** Check if the AI flagged this session as not worth preserving */
function extractSkipKnowledge(summary: string): boolean {
  const section = extractNamedSection(summary, "Relevance");
  if (!section) return false;
  return /^\s*skip\s*$/im.test(section);
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

/** Strip markdown emphasis/bold markers for comparison */
function stripMarkdown(text: string): string {
  return text.replace(/^[_*]+|[_*]+$/g, "").trim();
}

/** Extract individual decision entries */
export function extractDecisionEntries(summary: string): ExtractedEntry[] {
  const section = extractNamedSection(summary, "Decisions");
  const nonePatterns = /^(none|n\/a|no significant|no decisions|no key|nothing|not applicable)/i;
  if (!section || nonePatterns.test(stripMarkdown(section.trim()))) return [];
  const blocks = section.split(/\n(?=\*\*)/).filter((e) => e.trim());
  return blocks.map((b) => parseEntryBlock(b.trim()));
}

/** Extract individual mistake entries */
export function extractMistakeEntries(summary: string): ExtractedEntry[] {
  const section = extractNamedSection(summary, "Mistakes");
  const nonePatterns = /^(none|n\/a|no mistakes|no errors|no issues|nothing|not applicable)/i;
  if (!section || nonePatterns.test(stripMarkdown(section.trim()))) return [];
  const blocks = section.split(/\n(?=\*\*)/).filter((e) => e.trim());
  return blocks.map((b) => parseEntryBlock(b.trim()));
}

/** Extract individual strategy entries */
export function extractStrategyEntries(summary: string): ExtractedEntry[] {
  const section = extractNamedSection(summary, "Strategies");
  const nonePatterns = /^(none|n\/a|no strategies|no trade-offs|nothing|not applicable)/i;
  if (!section || nonePatterns.test(stripMarkdown(section.trim()))) return [];
  const blocks = section.split(/\n(?=\*\*)/).filter((e) => e.trim());
  return blocks.map((b) => parseEntryBlock(b.trim()));
}

/** Extract individual knowledge entries */
export function extractKnowledgeEntries(summary: string): ExtractedEntry[] {
  const section = extractNamedSection(summary, "Knowledge");
  const nonePatterns = /^(none|n\/a|no knowledge|no insights|nothing|not applicable)/i;
  if (!section || nonePatterns.test(stripMarkdown(section.trim()))) return [];
  const blocks = section.split(/\n(?=\*\*)/).filter((e) => e.trim());
  return blocks.map((b) => parseEntryBlock(b.trim()));
}

/** Check if a summary has valid structured format (starts with ## Intent and has ## Tags) */
export function isValidSummary(summary: string): boolean {
  return /^##\s+Intent/m.test(summary) && /^##\s+Tags/m.test(summary);
}

/** Extract a named section from markdown */
function extractNamedSection(content: string, sectionName: string): string {
  const regex = new RegExp(`##\\s+${sectionName}\\n([\\s\\S]*?)(?=\\n##\\s|$)`);
  const match = content.match(regex);
  return match ? match[1]!.trim() : "";
}

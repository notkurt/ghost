#!/usr/bin/env bun
/**
 * Background finalization process — spawned by SessionEnd handler.
 * Runs detached: summarization, tag extraction, git notes, QMD indexing.
 *
 * Usage: bun background.ts <repoRoot> <sessionPath> <sessionId>
 */

import { appendFileSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SESSION_DIR } from "./paths.js";
import { indexSession } from "./qmd.js";
import { redactSecrets } from "./redact.js";
import {
  addFrontmatterField,
  addTags,
  appendDecision,
  appendMistake,
  checkpoint,
  deriveArea,
  detectCorrections,
  extractModifiedFiles,
  parseFrontmatter,
} from "./session.js";
import { extractSections, summarize } from "./summarize.js";

const [repoRoot, sessionPath, sessionId] = process.argv.slice(2) as [string, string, string];

if (!repoRoot || !sessionPath || !sessionId) {
  process.exit(1);
}

// Write PID file so `ghost status` can check if we're running
const pidFile = join(repoRoot, SESSION_DIR, ".background.pid");
const logFile = join(repoRoot, SESSION_DIR, ".background.log");
writeFileSync(pidFile, String(process.pid));

// Rotate log if it exceeds 50KB
try {
  if (existsSync(logFile) && statSync(logFile).size > 50 * 1024) {
    const lines = readFileSync(logFile, "utf8").split("\n");
    writeFileSync(logFile, lines.slice(-200).join("\n"));
  }
} catch {
  // Non-critical
}

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    appendFileSync(logFile, line);
  } catch {
    // Can't even log — truly give up
  }
}

/** Check if an entry title is junk (non-content like "None", "N/A", etc.) */
function isJunkEntry(title: string): boolean {
  const t = title.toLowerCase().trim();
  return (
    t === "none" ||
    t === "n/a" ||
    t.length < 3 ||
    t.startsWith("no mistake") ||
    t.startsWith("no error") ||
    t.startsWith("no issue") ||
    t.startsWith("successfully") ||
    t.startsWith("none ")
  );
}

/** Parse **Title**: description from bold-formatted text */
function parseTitleDescription(text: string): { title: string; description: string } {
  const boldMatch = text.match(/^\*\*(.+?)\*\*:\s*([\s\S]*)$/);
  if (boldMatch) {
    return { title: boldMatch[1]!.trim(), description: boldMatch[2]!.trim() };
  }
  // Fallback: first sentence as title, rest as description
  const dotIdx = text.indexOf(". ");
  if (dotIdx > 0) {
    return { title: text.slice(0, dotIdx), description: text.slice(dotIdx + 2).trim() };
  }
  return { title: text, description: "" };
}

try {
  log(`Starting background finalization for session ${sessionId}`);

  // 1. AI summarization
  const summary = await summarize(sessionPath);
  if (summary) {
    log("Summarization complete, appending to session file");
    appendFileSync(sessionPath, `\n## Summary\n\n${summary}\n`);

    // 2. Extract tags, decisions, mistakes
    const sections = extractSections(summary);

    // Check if AI flagged this session as not relevant for knowledge
    if (sections.skipKnowledge) {
      log("Session flagged as skip_knowledge by AI — skipping knowledge ingestion");
      // Mark in frontmatter so downstream consumers can filter
      const currentContent = readFileSync(sessionPath, "utf8");
      const updated = addFrontmatterField(currentContent, "skip_knowledge", true);
      writeFileSync(sessionPath, updated);
    }

    if (sections.tags.length > 0) {
      addTags(repoRoot, sessionId, sections.tags);
      log(`Tagged: ${sections.tags.join(", ")}`);
    }

    if (!sections.skipKnowledge) {
      // Read session data for context
      const sessionContent = readFileSync(sessionPath, "utf8");
      const { frontmatter } = parseFrontmatter(sessionContent);
      const modifiedFiles = extractModifiedFiles(sessionContent);
      const commitSha = (frontmatter.base_commit as string) || "unknown";
      const sessionDate = sessionId.slice(0, 10);

      for (const decision of sections.decisions) {
        const { title, description } = parseTitleDescription(decision.text);
        if (isJunkEntry(title)) continue;
        const files = decision.files.length > 0 ? decision.files : modifiedFiles.slice(0, 5);
        appendDecision(repoRoot, {
          title,
          description,
          sessionId,
          commitSha,
          files,
          area: deriveArea(files),
          date: sessionDate,
          tried: decision.tried,
          rule: decision.rule,
        });
      }
      if (sections.decisions.length > 0) {
        log(`Logged ${sections.decisions.length} decision(s)`);
      }

      for (const mistake of sections.mistakes) {
        const { title, description } = parseTitleDescription(mistake.text);
        if (isJunkEntry(title)) continue;
        const files = mistake.files.length > 0 ? mistake.files : modifiedFiles.slice(0, 5);
        appendMistake(repoRoot, {
          title,
          description,
          sessionId,
          commitSha,
          files,
          area: deriveArea(files),
          date: sessionDate,
          tried: mistake.tried,
          rule: mistake.rule,
        });
      }
      if (sections.mistakes.length > 0) {
        log(`Logged ${sections.mistakes.length} mistake(s)`);
      }

      // Auto-detect corrections: files modified in consecutive turns
      const corrections = detectCorrections(sessionContent);
      if (corrections.length > 0) {
        const fileCounts: Record<string, number> = {};
        for (const c of corrections) {
          fileCounts[c.file] = (fileCounts[c.file] || 0) + 1;
        }
        for (const [file, count] of Object.entries(fileCounts)) {
          if (count >= 2) {
            appendMistake(repoRoot, {
              title: `Repeated modifications to ${file}`,
              description: `File was modified across multiple consecutive turns — may indicate the AI struggled with this file. Review session ${sessionId} for the correct approach.`,
              sessionId,
              commitSha,
              files: [file],
              area: deriveArea([file]),
              date: sessionDate,
              tried: [],
              rule: "",
            });
            log(`Auto-detected correction pattern for ${file}`);
          }
        }
      }
    }
  } else {
    log("Summarization skipped (claude CLI not available or failed)");
  }

  // 3. Thorough secret redaction pass (secretlint + built-in fallback)
  try {
    const fileContent = readFileSync(sessionPath, "utf8");
    const redacted = await redactSecrets(fileContent);
    if (redacted !== fileContent) {
      writeFileSync(sessionPath, redacted);
      log("Secret redaction applied");
    }
  } catch (err) {
    log(`Secret redaction failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. Attach git note to HEAD
  try {
    await checkpoint(repoRoot);
    log("Git note attached to HEAD");
  } catch (err) {
    log(`Git note failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 5. Index into QMD
  try {
    const qmdResult = await indexSession(repoRoot);
    log(qmdResult.ok ? "QMD indexing complete" : `QMD indexing skipped (${qmdResult.reason})`);
  } catch (err) {
    log(`QMD indexing failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 6. Sync shared knowledge to orphan branch (and remote)
  try {
    const { pushShared } = await import("./sync.js");
    await pushShared(repoRoot);
    log("Shared knowledge synced");
  } catch (err) {
    log(`Shared knowledge sync failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  log("Background finalization complete");
} catch (err) {
  log(`Background finalization failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  // Clean up PID file
  try {
    if (existsSync(pidFile)) unlinkSync(pidFile);
  } catch {
    // ignore
  }
}

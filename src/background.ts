#!/usr/bin/env bun
/**
 * Background finalization process — spawned by SessionEnd handler.
 * Runs detached: summarization, tag extraction, git notes, QMD indexing.
 *
 * Usage: bun background.ts <repoRoot> <sessionPath> <sessionId>
 */

import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SESSION_DIR } from "./paths.js";
import { indexSession } from "./qmd.js";
import { redactSecrets } from "./redact.js";
import { addTags, appendDecision, appendMistake, checkpoint } from "./session.js";
import { extractSections, summarize } from "./summarize.js";

const [repoRoot, sessionPath, sessionId] = process.argv.slice(2) as [string, string, string];

if (!repoRoot || !sessionPath || !sessionId) {
  process.exit(1);
}

// Write PID file so `ghost status` can check if we're running
const pidFile = join(repoRoot, SESSION_DIR, ".background.pid");
const logFile = join(repoRoot, SESSION_DIR, ".background.log");
writeFileSync(pidFile, String(process.pid));

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    appendFileSync(logFile, line);
  } catch {
    // Can't even log — truly give up
  }
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

    if (sections.tags.length > 0) {
      addTags(repoRoot, sessionId, sections.tags);
      log(`Tagged: ${sections.tags.join(", ")}`);
    }
    for (const decision of sections.decisions) {
      appendDecision(repoRoot, decision);
    }
    if (sections.decisions.length > 0) {
      log(`Logged ${sections.decisions.length} decision(s)`);
    }
    for (const mistake of sections.mistakes) {
      appendMistake(repoRoot, mistake);
    }
    if (sections.mistakes.length > 0) {
      log(`Logged ${sections.mistakes.length} mistake(s)`);
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
    const indexed = await indexSession(repoRoot);
    log(indexed ? "QMD indexing complete" : "QMD indexing skipped (qmd not available)");
  } catch (err) {
    log(`QMD indexing failed: ${err instanceof Error ? err.message : String(err)}`);
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

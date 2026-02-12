import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildHeatmapData } from "./knowledge.js";
import { completedDir } from "./paths.js";
import { getSessionsByTag, listCompletedSessions, parseFrontmatter } from "./session.js";

// =============================================================================
// Terminal Colors
// =============================================================================

const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const c = {
  reset: useColor ? "\x1b[0m" : "",
  dim: useColor ? "\x1b[2m" : "",
  bold: useColor ? "\x1b[1m" : "",
  cyan: useColor ? "\x1b[36m" : "",
  yellow: useColor ? "\x1b[33m" : "",
};

// =============================================================================
// Heatmap
// =============================================================================

interface HeatmapOpts {
  tag?: string;
  json?: boolean;
  top?: number;
}

/** Show file modification frequency across sessions */
export async function showHeatmap(repoRoot: string, opts: HeatmapOpts): Promise<void> {
  const sessionIds = opts.tag ? getSessionsByTag(repoRoot, opts.tag) : undefined;
  const sorted = buildHeatmapData(repoRoot, sessionIds).slice(0, opts.top || 20);

  if (sorted.length === 0) {
    console.log("No file modifications recorded.");
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(Object.fromEntries(sorted), null, 2));
    return;
  }

  const maxWidth = String(sorted[0]![1]).length;

  for (const [file, count] of sorted) {
    const padded = String(count).padStart(maxWidth);
    console.log(`${c.yellow}${padded} changes${c.reset} | ${file}`);
  }
}

// =============================================================================
// Stats
// =============================================================================

interface StatsOpts {
  json?: boolean;
  tag?: string;
  since?: string;
}

/** Show session metrics and trends */
export async function showStats(repoRoot: string, opts: StatsOpts): Promise<void> {
  let sessionIds = opts.tag ? getSessionsByTag(repoRoot, opts.tag) : listCompletedSessions(repoRoot);

  // Filter by date if specified
  if (opts.since) {
    const sinceDate = new Date(opts.since).getTime();
    sessionIds = sessionIds.filter((id) => {
      const dateStr = id.slice(0, 10);
      return new Date(dateStr).getTime() >= sinceDate;
    });
  }

  if (sessionIds.length === 0) {
    console.log("No sessions found.");
    return;
  }

  let totalPrompts = 0;
  let totalFiles = 0;
  const fileCounts: Record<string, number> = {};
  const tagCounts: Record<string, number> = {};
  let totalDurationMs = 0;
  let sessionsWithDuration = 0;

  for (const id of sessionIds) {
    const path = join(completedDir(repoRoot), `${id}.md`);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    const { frontmatter } = parseFrontmatter(content);

    // Count prompts
    const prompts = (content.match(/^## Prompt \d+/gm) || []).length;
    totalPrompts += prompts;

    // Calculate duration
    if (frontmatter.started && frontmatter.ended) {
      const start = new Date(frontmatter.started as string).getTime();
      const end = new Date(frontmatter.ended as string).getTime();
      if (end > start) {
        totalDurationMs += end - start;
        sessionsWithDuration++;
      }
    }

    // Count file modifications
    const files = content.matchAll(/^- Modified: (.+)$/gm);
    for (const match of files) {
      const file = match[1]!;
      fileCounts[file] = (fileCounts[file] || 0) + 1;
      totalFiles++;
    }

    // Count tags
    const tags = (frontmatter.tags as string[]) || [];
    for (const tag of tags) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }

  const uniqueFiles = Object.keys(fileCounts).length;
  const avgPrompts = sessionIds.length > 0 ? (totalPrompts / sessionIds.length).toFixed(1) : "0";
  const avgDurationMin = sessionsWithDuration > 0 ? Math.round(totalDurationMs / sessionsWithDuration / 60000) : 0;

  // Top areas (by tag)
  const topTags = Object.entries(tagCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          sessions: sessionIds.length,
          totalPrompts,
          avgPromptsPerSession: parseFloat(avgPrompts),
          avgDurationMinutes: avgDurationMin,
          uniqueFilesModified: uniqueFiles,
          totalFileModifications: totalFiles,
          topTags: Object.fromEntries(topTags),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`${c.bold}Sessions:${c.reset}              ${sessionIds.length}`);
  if (avgDurationMin > 0) {
    console.log(`${c.bold}Avg duration:${c.reset}          ${avgDurationMin} min`);
  }
  console.log(`${c.bold}Total prompts:${c.reset}         ${totalPrompts}`);
  console.log(`${c.bold}Avg prompts/session:${c.reset}   ${avgPrompts}`);
  console.log(`${c.bold}Files modified:${c.reset}        ${uniqueFiles} unique (${totalFiles} total changes)`);
  if (topTags.length > 0) {
    const tagStr = topTags.map(([tag, count]) => `${tag} (${count})`).join(", ");
    console.log(`${c.bold}Top tags:${c.reset}              ${tagStr}`);
  }
}

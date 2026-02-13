import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { ACTIVE_DIR, COMPLETED_DIR, SESSION_DIR } from "./paths.js";
import type { KnowledgeEntry } from "./session.js";
import {
  addTags,
  appendDecision,
  appendFileModification,
  appendMistake,
  appendPrompt,
  appendTaskNote,
  buildCoModGraph,
  createSession,
  deriveArea,
  detectCorrections,
  extractModifiedFiles,
  finalizeSession,
  formatKnowledgeEntry,
  generateSessionId,
  getActiveSessionId,
  getActiveSessionPath,
  getCoModifiedFiles,
  getCondensedMistakes,
  getPromptCount,
  getRelevantEntries,
  listDecisions,
  listTags,
  parseFrontmatter,
  parseKnowledgeEntries,
} from "./session.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(import.meta.dir, `../.test-tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  // Init a git repo so git commands work
  await $`git init ${tmpDir}`.quiet();
  await $`git -C ${tmpDir} commit --allow-empty -m "init"`.quiet();
});

afterEach(() => {
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("generateSessionId", () => {
  test("returns YYYY-MM-DD-hex format", () => {
    const id = generateSessionId();
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
  });

  test("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateSessionId()));
    expect(ids.size).toBe(10);
  });
});

describe("createSession", () => {
  test("creates session file with frontmatter", async () => {
    const id = await createSession(tmpDir);
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);

    const filePath = join(tmpDir, SESSION_DIR, ACTIVE_DIR, `${id}.md`);
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf8");
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.session).toBe(id);
    expect(frontmatter.branch).toBeDefined();
    expect(frontmatter.base_commit).toBeDefined();
    expect(frontmatter.started).toBeDefined();
    expect(frontmatter.tags).toEqual([]);
  });

  test("writes current-id file", async () => {
    const id = await createSession(tmpDir);
    const currentId = readFileSync(join(tmpDir, SESSION_DIR, ACTIVE_DIR, "current-id"), "utf8").trim();
    expect(currentId).toBe(id);
  });
});

describe("getActiveSessionId", () => {
  test("returns null when no active session", () => {
    expect(getActiveSessionId(tmpDir)).toBeNull();
  });

  test("returns session ID when active", async () => {
    const id = await createSession(tmpDir);
    expect(getActiveSessionId(tmpDir)).toBe(id);
  });
});

describe("appendPrompt", () => {
  test("appends numbered prompt to session", async () => {
    await createSession(tmpDir);
    appendPrompt(tmpDir, "Fix the login bug");
    appendPrompt(tmpDir, "Add tests for it");

    const path = getActiveSessionPath(tmpDir)!;
    const content = readFileSync(path, "utf8");
    expect(content).toContain("## Prompt 1\n> Fix the login bug");
    expect(content).toContain("## Prompt 2\n> Add tests for it");
  });

  test("increments prompt count correctly", async () => {
    await createSession(tmpDir);
    expect(getPromptCount(tmpDir)).toBe(0);
    appendPrompt(tmpDir, "First");
    expect(getPromptCount(tmpDir)).toBe(1);
    appendPrompt(tmpDir, "Second");
    expect(getPromptCount(tmpDir)).toBe(2);
  });
});

describe("appendFileModification", () => {
  test("appends modification note", async () => {
    await createSession(tmpDir);
    appendFileModification(tmpDir, "src/cart/fees.ts");

    const path = getActiveSessionPath(tmpDir)!;
    const content = readFileSync(path, "utf8");
    expect(content).toContain("- Modified: src/cart/fees.ts");
  });
});

describe("appendTaskNote", () => {
  test("appends task note", async () => {
    await createSession(tmpDir);
    appendTaskNote(tmpDir, "Completed refactoring");

    const path = getActiveSessionPath(tmpDir)!;
    const content = readFileSync(path, "utf8");
    expect(content).toContain("- Task: Completed refactoring");
  });
});

describe("finalizeSession", () => {
  test("moves file from active to completed", async () => {
    const id = await createSession(tmpDir);
    const compPath = finalizeSession(tmpDir);
    expect(compPath).not.toBeNull();

    // Active file should be gone
    const activePath = join(tmpDir, SESSION_DIR, ACTIVE_DIR, `${id}.md`);
    expect(existsSync(activePath)).toBe(false);

    // Completed file should exist
    const completedPath = join(tmpDir, SESSION_DIR, COMPLETED_DIR, `${id}.md`);
    expect(existsSync(completedPath)).toBe(true);

    // Should have ended timestamp in frontmatter
    const content = readFileSync(completedPath, "utf8");
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.ended).toBeDefined();
  });

  test("clears current-id", async () => {
    await createSession(tmpDir);
    finalizeSession(tmpDir);
    expect(getActiveSessionId(tmpDir)).toBeNull();
  });

  test("returns null when no active session", () => {
    expect(finalizeSession(tmpDir)).toBeNull();
  });
});

describe("tagging", () => {
  test("adds tags to session frontmatter", async () => {
    const id = await createSession(tmpDir);
    finalizeSession(tmpDir);
    addTags(tmpDir, id, ["area:cart", "type:bug-fix"]);

    const completedPath = join(tmpDir, SESSION_DIR, COMPLETED_DIR, `${id}.md`);
    const content = readFileSync(completedPath, "utf8");
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.tags).toContain("area:cart");
    expect(frontmatter.tags).toContain("type:bug-fix");
  });

  test("updates tags.json index", async () => {
    const id = await createSession(tmpDir);
    finalizeSession(tmpDir);
    addTags(tmpDir, id, ["area:cart"]);

    const tags = listTags(tmpDir);
    expect(tags["area:cart"]).toContain(id);
  });

  test("deduplicates tags", async () => {
    const id = await createSession(tmpDir);
    finalizeSession(tmpDir);
    addTags(tmpDir, id, ["area:cart"]);
    addTags(tmpDir, id, ["area:cart", "new-tag"]);

    const completedPath = join(tmpDir, SESSION_DIR, COMPLETED_DIR, `${id}.md`);
    const content = readFileSync(completedPath, "utf8");
    const { frontmatter } = parseFrontmatter(content);
    const tags = frontmatter.tags as string[];
    expect(tags.filter((t) => t === "area:cart").length).toBe(1);
  });
});

describe("mistakes", () => {
  test("appends and reads mistakes (string format)", () => {
    mkdirSync(join(tmpDir, SESSION_DIR), { recursive: true });
    appendMistake(tmpDir, "Don't use cart.js API for bundles");
    appendMistake(tmpDir, "Fulfillment webhook fires twice");

    const condensed = getCondensedMistakes(tmpDir);
    expect(condensed).toContain("Don't use cart.js API for bundles");
    expect(condensed).toContain("Fulfillment webhook fires twice");
    expect(condensed).toContain("2 entries");
  });

  test("appends KnowledgeEntry in structured format", () => {
    mkdirSync(join(tmpDir, SESSION_DIR), { recursive: true });
    const entry: KnowledgeEntry = {
      title: "Don't batch > 50 mutations",
      description: "Causes timeout on Shopify's side. Split into chunks of 25.",
      sessionId: "2026-02-10-a1b2c3d4",
      commitSha: "abc1234",
      files: ["src/sync/deploy.ts", "src/sync/batch.ts"],
      area: "sync",
      date: "2026-02-10",
      tried: ["Batching 100 at once", "Single large GraphQL query"],
      rule: "WHEN modifying src/sync/deploy.ts NEVER batch more than 25 mutations",
    };
    appendMistake(tmpDir, entry);

    const content = readFileSync(join(tmpDir, SESSION_DIR, "mistakes.md"), "utf8");
    expect(content).toContain("### Don't batch > 50 mutations");
    expect(content).toContain("Causes timeout");
    expect(content).toContain("session:2026-02-10-a1b2c3d4");
    expect(content).toContain("files:src/sync/deploy.ts,src/sync/batch.ts");
    expect(content).toContain("tried:Batching 100 at once,Single large GraphQL query");
    expect(content).toContain("NEVER batch more than 25 mutations");
  });

  test("returns null when no mistakes file", () => {
    expect(getCondensedMistakes(tmpDir)).toBeNull();
  });
});

describe("decisions", () => {
  test("appends and reads decisions (string format)", () => {
    mkdirSync(join(tmpDir, SESSION_DIR), { recursive: true });
    appendDecision(tmpDir, "## 2026-02-13: Percentage fees\nDecided on percentage-based.");
    appendDecision(tmpDir, "## 2026-02-14: Keep Liquid\nStay on Liquid for PDP.");

    const all = listDecisions(tmpDir);
    expect(all).toContain("Percentage fees");
    expect(all).toContain("Keep Liquid");
  });

  test("appends KnowledgeEntry in structured format", () => {
    mkdirSync(join(tmpDir, SESSION_DIR), { recursive: true });
    const entry: KnowledgeEntry = {
      title: "Use percentage fees with cap",
      description: "Client wants flexible fees. Chose percentage with $50 cap.",
      sessionId: "2026-02-13-abcd1234",
      commitSha: "def5678",
      files: ["src/cart/fees.ts"],
      area: "cart",
      date: "2026-02-13",
      tried: [],
      rule: "",
    };
    appendDecision(tmpDir, entry);

    const content = readFileSync(join(tmpDir, SESSION_DIR, "decisions.md"), "utf8");
    expect(content).toContain("### Use percentage fees with cap");
    expect(content).toContain("session:2026-02-13-abcd1234");
    expect(content).toContain("files:src/cart/fees.ts");
  });
});

describe("multiple sessions", () => {
  test("sessions are isolated", async () => {
    const id1 = await createSession(tmpDir);
    appendPrompt(tmpDir, "First session prompt");
    finalizeSession(tmpDir);

    const id2 = await createSession(tmpDir);
    appendPrompt(tmpDir, "Second session prompt");

    expect(id1).not.toBe(id2);
    expect(getActiveSessionId(tmpDir)).toBe(id2);

    const path2 = getActiveSessionPath(tmpDir)!;
    const content2 = readFileSync(path2, "utf8");
    expect(content2).toContain("Second session prompt");
    expect(content2).not.toContain("First session prompt");
  });
});

// =============================================================================
// Knowledge Entry Parsing & Formatting
// =============================================================================

describe("deriveArea", () => {
  test("extracts area from src/ paths", () => {
    expect(deriveArea(["src/cart/fees.ts", "src/cart/types.ts"])).toBe("cart");
  });

  test("strips src/app/lib prefixes", () => {
    expect(deriveArea(["app/components/header.tsx"])).toBe("components");
    expect(deriveArea(["lib/utils/format.ts"])).toBe("utils");
  });

  test("uses most common segment", () => {
    expect(deriveArea(["src/cart/fees.ts", "src/cart/types.ts", "src/sync/deploy.ts"])).toBe("cart");
  });

  test("returns general for empty files", () => {
    expect(deriveArea([])).toBe("general");
  });

  test("returns general for root-level files", () => {
    expect(deriveArea(["package.json"])).toBe("general");
  });

  test("handles deeply nested paths", () => {
    expect(deriveArea(["src/app/lib/features/auth/login.ts"])).toBe("features");
  });
});

describe("parseKnowledgeEntries", () => {
  test("parses ### + <!-- --> format with all fields", () => {
    const content = `### Don't batch > 50 mutations
Causes timeout. Split into chunks.
<!-- session:2026-02-10-a1b2c3d4 | commit:abc1234 | files:src/sync/deploy.ts,src/sync/batch.ts | area:sync | tried:Batching 100,Single query | rule:WHEN modifying deploy.ts NEVER batch > 25 -->`;

    const entries = parseKnowledgeEntries(content);
    expect(entries.length).toBe(1);
    expect(entries[0]!.title).toBe("Don't batch > 50 mutations");
    expect(entries[0]!.description).toBe("Causes timeout. Split into chunks.");
    expect(entries[0]!.sessionId).toBe("2026-02-10-a1b2c3d4");
    expect(entries[0]!.commitSha).toBe("abc1234");
    expect(entries[0]!.files).toEqual(["src/sync/deploy.ts", "src/sync/batch.ts"]);
    expect(entries[0]!.area).toBe("sync");
    expect(entries[0]!.tried).toEqual(["Batching 100", "Single query"]);
    expect(entries[0]!.rule).toBe("WHEN modifying deploy.ts NEVER batch > 25");
  });

  test("parses old - lines with default metadata", () => {
    const content = `- Don't use cart.js for bundles\n- Webhooks fire twice`;

    const entries = parseKnowledgeEntries(content);
    expect(entries.length).toBe(2);
    expect(entries[0]!.title).toBe("Don't use cart.js for bundles");
    expect(entries[0]!.sessionId).toBe("unknown");
    expect(entries[0]!.files).toEqual([]);
    expect(entries[0]!.area).toBe("general");
    expect(entries[0]!.tried).toEqual([]);
    expect(entries[0]!.rule).toBe("");
  });

  test("handles mixed format (old + new entries)", () => {
    const content = `- Old legacy mistake
### New structured mistake
Description here.
<!-- session:2026-02-10-abcd1234 | files:src/foo.ts | area:foo -->`;

    const entries = parseKnowledgeEntries(content);
    expect(entries.length).toBe(2);
    expect(entries[0]!.title).toBe("Old legacy mistake");
    expect(entries[0]!.sessionId).toBe("unknown");
    expect(entries[1]!.title).toBe("New structured mistake");
    expect(entries[1]!.sessionId).toBe("2026-02-10-abcd1234");
    expect(entries[1]!.files).toEqual(["src/foo.ts"]);
  });

  test("handles empty content", () => {
    expect(parseKnowledgeEntries("")).toEqual([]);
    expect(parseKnowledgeEntries("  \n  ")).toEqual([]);
  });

  test("derives date from sessionId when not explicit", () => {
    const content = `### Some entry\n<!-- session:2026-02-10-abcd1234 -->`;
    const entries = parseKnowledgeEntries(content);
    expect(entries[0]!.date).toBe("2026-02-10");
  });
});

describe("formatKnowledgeEntry", () => {
  test("round-trips correctly", () => {
    const entry: KnowledgeEntry = {
      title: "Don't batch > 50 mutations",
      description: "Causes timeout.",
      sessionId: "2026-02-10-a1b2c3d4",
      commitSha: "abc1234",
      files: ["src/sync/deploy.ts"],
      area: "sync",
      date: "2026-02-10",
      tried: ["Batching 100"],
      rule: "WHEN deploying NEVER batch > 25",
    };

    const formatted = formatKnowledgeEntry(entry);
    const parsed = parseKnowledgeEntries(formatted);
    expect(parsed.length).toBe(1);
    expect(parsed[0]!.title).toBe(entry.title);
    expect(parsed[0]!.description).toBe(entry.description);
    expect(parsed[0]!.sessionId).toBe(entry.sessionId);
    expect(parsed[0]!.files).toEqual(entry.files);
    expect(parsed[0]!.tried).toEqual(entry.tried);
    expect(parsed[0]!.rule).toBe(entry.rule);
  });

  test("omits empty tried and rule fields", () => {
    const entry: KnowledgeEntry = {
      title: "Simple entry",
      description: "Description.",
      sessionId: "2026-02-10-abcd1234",
      commitSha: "abc123",
      files: ["src/foo.ts"],
      area: "foo",
      date: "2026-02-10",
      tried: [],
      rule: "",
    };

    const formatted = formatKnowledgeEntry(entry);
    expect(formatted).not.toContain("tried:");
    expect(formatted).not.toContain("rule:");
    expect(formatted).toContain("session:");
    expect(formatted).toContain("files:");
  });

  test("omits general area", () => {
    const entry: KnowledgeEntry = {
      title: "Root level entry",
      description: "",
      sessionId: "2026-02-10-abcd1234",
      commitSha: "",
      files: [],
      area: "general",
      date: "2026-02-10",
      tried: [],
      rule: "",
    };

    const formatted = formatKnowledgeEntry(entry);
    expect(formatted).not.toContain("area:");
  });
});

describe("getRelevantEntries", () => {
  const makeEntry = (overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry => ({
    title: "Test entry",
    description: "Test description",
    sessionId: "2026-02-10-abcd1234",
    commitSha: "abc123",
    files: [],
    area: "general",
    date: "2026-02-10",
    tried: [],
    rule: "",
    ...overrides,
  });

  test("scores file overlap highest", () => {
    const entries = [
      makeEntry({ title: "Unrelated", files: ["src/unrelated.ts"] }),
      makeEntry({ title: "Relevant", files: ["src/cart/fees.ts"] }),
    ];
    const result = getRelevantEntries(entries, ["src/cart/fees.ts"], [], 5);
    expect(result[0]!.title).toBe("Relevant");
  });

  test("boosts entries with rule field", () => {
    const entries = [
      makeEntry({ title: "No rule", files: ["src/cart/fees.ts"] }),
      makeEntry({ title: "Has rule", files: [], rule: "WHEN modifying cart NEVER do X" }),
    ];
    const result = getRelevantEntries(entries, ["src/cart/fees.ts"], [], 5);
    expect(result[0]!.title).toBe("Has rule");
  });

  test("falls back to recent entries when no file overlap", () => {
    const entries = [
      makeEntry({ title: "Old entry", date: "2025-01-01" }),
      makeEntry({ title: "Recent entry", date: "2026-02-09" }),
    ];
    const result = getRelevantEntries(entries, ["src/something-else.ts"], [], 5);
    expect(result.length).toBe(2);
    expect(result[0]!.title).toBe("Recent entry");
  });

  test("includes co-modification neighbors in scoring", () => {
    const entries = [
      makeEntry({ title: "CoMod match", files: ["src/bar.ts"] }),
      makeEntry({ title: "No match", files: ["src/unrelated.ts"] }),
    ];
    const result = getRelevantEntries(entries, ["src/foo.ts"], ["src/bar.ts"], 5);
    expect(result[0]!.title).toBe("CoMod match");
  });

  test("respects max limit", () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      makeEntry({ title: `Entry ${i}`, files: ["src/cart/fees.ts"] }),
    );
    const result = getRelevantEntries(entries, ["src/cart/fees.ts"], [], 3);
    expect(result.length).toBe(3);
  });
});

describe("detectCorrections", () => {
  test("finds files modified in consecutive turns", () => {
    const content = `## Prompt 1
> Fix foo
- Modified: src/foo.ts
---
## Prompt 2
> Fix foo again
- Modified: src/foo.ts
---
## Prompt 3
> Fix bar
- Modified: src/bar.ts`;

    const corrections = detectCorrections(content);
    expect(corrections.length).toBe(1);
    expect(corrections[0]!.file).toBe("src/foo.ts");
    expect(corrections[0]!.turnA).toBe(0);
    expect(corrections[0]!.turnB).toBe(1);
  });

  test("returns empty for single-modification files", () => {
    const content = `## Prompt 1
> Fix foo
- Modified: src/foo.ts
---
## Prompt 2
> Fix bar
- Modified: src/bar.ts`;

    const corrections = detectCorrections(content);
    expect(corrections.length).toBe(0);
  });

  test("detects multiple consecutive modifications", () => {
    const content = `- Modified: src/foo.ts
---
- Modified: src/foo.ts
---
- Modified: src/foo.ts`;

    const corrections = detectCorrections(content);
    expect(corrections.length).toBe(2);
    expect(corrections[0]!.file).toBe("src/foo.ts");
    expect(corrections[1]!.file).toBe("src/foo.ts");
  });
});

describe("buildCoModGraph", () => {
  test("builds correct adjacency from session files", () => {
    // Create completed session with co-modified files
    const compDir = join(tmpDir, SESSION_DIR, "completed");
    mkdirSync(compDir, { recursive: true });
    writeFileSync(
      join(compDir, "2026-02-10-abcd1234.md"),
      `---
session: 2026-02-10-abcd1234
---
- Modified: src/foo.ts
- Modified: src/bar.ts
---
- Modified: src/foo.ts
- Modified: src/baz.ts`,
    );

    const graph = buildCoModGraph(tmpDir);
    expect(graph["src/foo.ts"]).toContain("src/bar.ts");
    expect(graph["src/foo.ts"]).toContain("src/baz.ts");
    expect(graph["src/bar.ts"]).toContain("src/foo.ts");
  });

  test("returns empty for no sessions", () => {
    const graph = buildCoModGraph(tmpDir);
    expect(Object.keys(graph).length).toBe(0);
  });
});

describe("getCoModifiedFiles", () => {
  test("returns neighbors sorted by frequency", () => {
    const graph: Record<string, string[]> = {
      "src/foo.ts": ["src/bar.ts", "src/baz.ts"],
      "src/bar.ts": ["src/foo.ts"],
    };
    const result = getCoModifiedFiles(graph, ["src/foo.ts"]);
    expect(result).toContain("src/bar.ts");
    expect(result).toContain("src/baz.ts");
  });

  test("excludes files already in the input set", () => {
    const graph: Record<string, string[]> = {
      "src/foo.ts": ["src/bar.ts", "src/baz.ts"],
    };
    const result = getCoModifiedFiles(graph, ["src/foo.ts", "src/bar.ts"]);
    expect(result).not.toContain("src/foo.ts");
    expect(result).not.toContain("src/bar.ts");
    expect(result).toContain("src/baz.ts");
  });

  test("respects limit", () => {
    const graph: Record<string, string[]> = {
      "src/foo.ts": ["a.ts", "b.ts", "c.ts", "d.ts"],
    };
    const result = getCoModifiedFiles(graph, ["src/foo.ts"], 2);
    expect(result.length).toBe(2);
  });
});

describe("extractModifiedFiles", () => {
  test("extracts file paths from session content", () => {
    const content = `## Prompt 1
> Do something
- Modified: src/foo.ts
- Modified: src/bar.ts
- Task: Something`;

    const files = extractModifiedFiles(content);
    expect(files).toEqual(["src/foo.ts", "src/bar.ts"]);
  });
});

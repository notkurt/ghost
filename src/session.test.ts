import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { ACTIVE_DIR, COMPLETED_DIR, SESSION_DIR } from "./paths.js";
import {
  addTags,
  appendDecision,
  appendFileModification,
  appendMistake,
  appendPrompt,
  appendTaskNote,
  createSession,
  finalizeSession,
  generateSessionId,
  getActiveSessionId,
  getActiveSessionPath,
  getCondensedMistakes,
  getPromptCount,
  listDecisions,
  listTags,
  parseFrontmatter,
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
  test("appends and reads mistakes", () => {
    mkdirSync(join(tmpDir, SESSION_DIR), { recursive: true });
    appendMistake(tmpDir, "Don't use cart.js API for bundles");
    appendMistake(tmpDir, "Fulfillment webhook fires twice");

    const condensed = getCondensedMistakes(tmpDir);
    expect(condensed).toContain("Don't use cart.js API for bundles");
    expect(condensed).toContain("Fulfillment webhook fires twice");
    expect(condensed).toContain("2 entries");
  });

  test("returns null when no mistakes file", () => {
    expect(getCondensedMistakes(tmpDir)).toBeNull();
  });
});

describe("decisions", () => {
  test("appends and reads decisions", () => {
    mkdirSync(join(tmpDir, SESSION_DIR), { recursive: true });
    appendDecision(tmpDir, "## 2026-02-13: Percentage fees\nDecided on percentage-based.");
    appendDecision(tmpDir, "## 2026-02-14: Keep Liquid\nStay on Liquid for PDP.");

    const all = listDecisions(tmpDir);
    expect(all).toContain("Percentage fees");
    expect(all).toContain("Keep Liquid");
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

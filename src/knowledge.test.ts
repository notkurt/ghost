import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { shouldRebuildKnowledge } from "./knowledge.js";
import { COMPLETED_DIR, knowledgePath, SESSION_DIR } from "./paths.js";
import { appendDecision, appendMistake, getCondensedMistakes, listDecisions } from "./session.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(import.meta.dir, `../.test-tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  await $`git init ${tmpDir}`.quiet();
  await $`git -C ${tmpDir} commit --allow-empty -m "init"`.quiet();
});

afterEach(() => {
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("mistake ledger", () => {
  test("appends and reads mistakes", () => {
    mkdirSync(join(tmpDir, SESSION_DIR), { recursive: true });
    appendMistake(tmpDir, "Don't use cart.js for bundles");
    appendMistake(tmpDir, "Webhook fires twice on partial");

    const condensed = getCondensedMistakes(tmpDir);
    expect(condensed).not.toBeNull();
    expect(condensed).toContain("Don't use cart.js for bundles");
    expect(condensed).toContain("Webhook fires twice on partial");
    expect(condensed).toContain("2 entries");
  });

  test("limits to maxEntries", () => {
    mkdirSync(join(tmpDir, SESSION_DIR), { recursive: true });
    for (let i = 0; i < 10; i++) {
      appendMistake(tmpDir, `Mistake ${i}`);
    }
    const condensed = getCondensedMistakes(tmpDir, 3)!;
    expect(condensed).toContain("10 entries");
    // Should only show last 3
    expect(condensed).toContain("Mistake 7");
    expect(condensed).toContain("Mistake 8");
    expect(condensed).toContain("Mistake 9");
    expect(condensed).not.toContain("Mistake 0");
  });
});

describe("decision log", () => {
  test("appends and lists decisions", () => {
    mkdirSync(join(tmpDir, SESSION_DIR), { recursive: true });
    appendDecision(tmpDir, "## 2026-02-13: Use percentage fees\nChose percentage over tiered.");
    appendDecision(tmpDir, "## 2026-02-14: Keep Liquid\nStay on Liquid for PDP.");

    const all = listDecisions(tmpDir);
    expect(all).toContain("percentage fees");
    expect(all).toContain("Keep Liquid");
  });

  test("filters by tag keyword", () => {
    mkdirSync(join(tmpDir, SESSION_DIR), { recursive: true });
    appendDecision(tmpDir, "## 2026-02-13: Cart fees\narea:cart decision about fees.");
    appendDecision(tmpDir, "## 2026-02-14: Checkout flow\narea:checkout decision.");

    const filtered = listDecisions(tmpDir, "cart");
    expect(filtered).toContain("Cart fees");
    expect(filtered).not.toContain("Checkout flow");
  });
});

describe("shouldRebuildKnowledge", () => {
  test("returns false with no sessions", () => {
    expect(shouldRebuildKnowledge(tmpDir)).toBe(false);
  });

  test("returns true when threshold reached", () => {
    const compDir = join(tmpDir, SESSION_DIR, COMPLETED_DIR);
    mkdirSync(compDir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(compDir, `2026-02-${10 + i}-abc${i}def0.md`), `---\nsession: test-${i}\n---\nContent`);
    }
    expect(shouldRebuildKnowledge(tmpDir, 5)).toBe(true);
  });
});

describe("mock session summaries", () => {
  test("knowledge file is writable", () => {
    mkdirSync(join(tmpDir, SESSION_DIR), { recursive: true });
    const kPath = knowledgePath(tmpDir);
    writeFileSync(kPath, "# Project Knowledge Base\n\nTest content.\n");
    expect(existsSync(kPath)).toBe(true);
    expect(readFileSync(kPath, "utf8")).toContain("Test content");
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import {
  initSharedBranch,
  mergeDecisions,
  mergeKnowledge,
  mergeMistakes,
  mergeTags,
  pullShared,
  pushShared,
  readSharedFile,
  syncKnowledge,
  writeSharedFiles,
} from "./sync.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(import.meta.dir, `../.test-tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  await $`git init ${tmpDir}`.quiet();
  await $`git -C ${tmpDir} commit --allow-empty -m "init"`.quiet();
});

afterEach(async () => {
  // Clean up shared branch if it exists
  try {
    await $`git -C ${tmpDir} branch -D ghost/knowledge`.quiet().nothrow();
  } catch {
    // ignore
  }
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// =============================================================================
// initSharedBranch
// =============================================================================

describe("initSharedBranch", () => {
  test("creates orphan branch", async () => {
    const result = await initSharedBranch(tmpDir);
    expect(result).toBe(true);

    const branches = (await $`git -C ${tmpDir} branch`.quiet()).text();
    expect(branches).toContain("ghost/knowledge");
  });

  test("is idempotent", async () => {
    await initSharedBranch(tmpDir);
    const result = await initSharedBranch(tmpDir);
    expect(result).toBe(true);
  });

  test("does not affect working tree", async () => {
    // Create a file in working tree
    writeFileSync(join(tmpDir, "test.txt"), "hello");
    await $`git -C ${tmpDir} add test.txt`.quiet();
    await $`git -C ${tmpDir} commit -m "add test"`.quiet();

    await initSharedBranch(tmpDir);

    // Working tree should be unchanged
    expect(readFileSync(join(tmpDir, "test.txt"), "utf8")).toBe("hello");
    // Should still be on original branch
    const branch = (await $`git -C ${tmpDir} branch --show-current`.quiet()).text().trim();
    expect(["main", "master"]).toContain(branch);
  });
});

// =============================================================================
// readSharedFile / writeSharedFiles
// =============================================================================

describe("readSharedFile / writeSharedFiles", () => {
  test("round-trip write and read", async () => {
    await initSharedBranch(tmpDir);

    const written = await writeSharedFiles(tmpDir, {
      "knowledge.md": "# Knowledge\n\nSome facts.\n",
      "mistakes.md": "- Don't do X\n",
    });
    expect(written).toBe(true);

    const knowledge = await readSharedFile(tmpDir, "knowledge.md");
    expect(knowledge).toBe("# Knowledge\n\nSome facts.\n");

    const mistakes = await readSharedFile(tmpDir, "mistakes.md");
    expect(mistakes).toBe("- Don't do X\n");
  });

  test("returns null for missing file", async () => {
    await initSharedBranch(tmpDir);
    const result = await readSharedFile(tmpDir, "nonexistent.md");
    expect(result).toBeNull();
  });

  test("does not affect working tree", async () => {
    writeFileSync(join(tmpDir, "existing.txt"), "untouched");
    await initSharedBranch(tmpDir);

    await writeSharedFiles(tmpDir, { "knowledge.md": "data" });

    // Working tree should not have knowledge.md
    expect(existsSync(join(tmpDir, "knowledge.md"))).toBe(false);
    expect(readFileSync(join(tmpDir, "existing.txt"), "utf8")).toBe("untouched");
  });

  test("overwrites existing files on branch", async () => {
    await initSharedBranch(tmpDir);

    await writeSharedFiles(tmpDir, { "test.md": "v1" });
    await writeSharedFiles(tmpDir, { "test.md": "v2" });

    const content = await readSharedFile(tmpDir, "test.md");
    expect(content).toBe("v2");
  });

  test("preserves other files when writing", async () => {
    await initSharedBranch(tmpDir);

    await writeSharedFiles(tmpDir, { "a.md": "aaa", "b.md": "bbb" });
    await writeSharedFiles(tmpDir, { "a.md": "updated" });

    expect(await readSharedFile(tmpDir, "a.md")).toBe("updated");
    expect(await readSharedFile(tmpDir, "b.md")).toBe("bbb");
  });
});

// =============================================================================
// Merge Strategies
// =============================================================================

describe("mergeMistakes", () => {
  test("deduplicates legacy lines", () => {
    const remote = "- Don't use X\n- Avoid Y\n";
    const local = "- Avoid Y\n- New mistake\n";
    const result = mergeMistakes(remote, local);
    expect(result).toContain("- Don't use X");
    expect(result).toContain("- Avoid Y");
    expect(result).toContain("- New mistake");
    // Only one "Avoid Y"
    expect(result.match(/Avoid Y/g)?.length).toBe(1);
  });

  test("handles empty inputs", () => {
    expect(mergeMistakes("", "")).toBe("");
    expect(mergeMistakes("", "- a\n")).toContain("- a");
    expect(mergeMistakes("- b\n", "")).toContain("- b");
  });

  test("deduplicates structured entries by title+description", () => {
    const remote = `### Batch timeout
Causes timeout.
<!-- session:2026-02-10-aaaa1111 | files:src/a.ts | area:sync -->
`;
    const local = `### Batch timeout
Causes timeout.
<!-- session:2026-02-10-bbbb2222 | files:src/a.ts | area:sync -->
`;
    const result = mergeMistakes(remote, local);
    // Should only appear once
    expect(result.match(/### Batch timeout/g)?.length).toBe(1);
  });

  test("preserves legacy lines alongside structured entries", () => {
    const remote = "- Old legacy mistake\n";
    const local = `### New structured mistake
Description here.
<!-- session:2026-02-10-abcd1234 | files:src/foo.ts | area:foo -->
`;
    const result = mergeMistakes(remote, local);
    expect(result).toContain("- Old legacy mistake");
    expect(result).toContain("### New structured mistake");
  });

  test("merges entries from different sessions about different mistakes", () => {
    const remote = `### Timeout on deploy
Too many mutations.
<!-- session:2026-02-10-aaaa1111 | files:src/deploy.ts | area:sync -->
`;
    const local = `### Missing idempotency keys
Retries create duplicates.
<!-- session:2026-02-11-bbbb2222 | files:src/client.ts | area:client -->
`;
    const result = mergeMistakes(remote, local);
    expect(result).toContain("### Timeout on deploy");
    expect(result).toContain("### Missing idempotency keys");
  });
});

describe("mergeDecisions", () => {
  test("deduplicates legacy blocks", () => {
    const remote = "Decision A\nDetails here\n\nDecision B\nMore details";
    const local = "Decision B\nMore details\n\nDecision C\nNew stuff";
    const result = mergeDecisions(remote, local);
    expect(result).toContain("Decision A");
    expect(result).toContain("Decision B");
    expect(result).toContain("Decision C");
    // Count occurrences of "Decision B"
    expect(result.match(/Decision B/g)?.length).toBe(1);
  });

  test("handles empty inputs", () => {
    expect(mergeDecisions("", "")).toBe("");
    expect(mergeDecisions("", "block")).toContain("block");
    expect(mergeDecisions("block", "")).toContain("block");
  });

  test("deduplicates structured decision entries", () => {
    const remote = `### Use Redis
Better performance.
<!-- session:2026-02-10-aaaa1111 | files:src/cache.ts | area:cache -->
`;
    const local = `### Use Redis
Better performance.
<!-- session:2026-02-10-bbbb2222 | files:src/cache.ts | area:cache -->
`;
    const result = mergeDecisions(remote, local);
    expect(result.match(/### Use Redis/g)?.length).toBe(1);
  });
});

describe("mergeKnowledge", () => {
  test("local wins when present", () => {
    expect(mergeKnowledge("remote content", "local content")).toBe("local content");
  });

  test("falls back to remote when local is empty", () => {
    expect(mergeKnowledge("remote content", "")).toBe("remote content");
    expect(mergeKnowledge("remote content", "  \n  ")).toBe("remote content");
  });
});

describe("mergeTags", () => {
  test("unions session arrays per tag", () => {
    const remote = JSON.stringify({ bug: ["s1", "s2"], feature: ["s3"] });
    const local = JSON.stringify({ bug: ["s2", "s4"], perf: ["s5"] });
    const result = JSON.parse(mergeTags(remote, local));
    expect(result.bug).toEqual(expect.arrayContaining(["s1", "s2", "s4"]));
    expect(result.bug.length).toBe(3);
    expect(result.feature).toEqual(["s3"]);
    expect(result.perf).toEqual(["s5"]);
  });

  test("handles invalid JSON gracefully", () => {
    const result = JSON.parse(mergeTags("not json", '{"a": ["1"]}'));
    expect(result.a).toEqual(["1"]);
  });

  test("handles both invalid", () => {
    const result = JSON.parse(mergeTags("bad", "worse"));
    expect(result).toEqual({});
  });

  test("handles empty inputs", () => {
    const result = JSON.parse(mergeTags("{}", "{}"));
    expect(result).toEqual({});
  });
});

// =============================================================================
// pullShared / pushShared
// =============================================================================

describe("pullShared", () => {
  test("populates local files from branch", async () => {
    await initSharedBranch(tmpDir);
    await writeSharedFiles(tmpDir, {
      "mistakes.md": "- Don't do X\n",
      "decisions.md": "Use Y for Z\n",
    });

    // Create .ai-sessions dir
    mkdirSync(join(tmpDir, ".ai-sessions"), { recursive: true });

    await pullShared(tmpDir);

    const mistakes = readFileSync(join(tmpDir, ".ai-sessions", "mistakes.md"), "utf8");
    expect(mistakes).toContain("Don't do X");
  });

  test("merges with existing local files", async () => {
    await initSharedBranch(tmpDir);
    await writeSharedFiles(tmpDir, {
      "mistakes.md": "- Remote mistake\n",
    });

    mkdirSync(join(tmpDir, ".ai-sessions"), { recursive: true });
    writeFileSync(join(tmpDir, ".ai-sessions", "mistakes.md"), "- Local mistake\n");

    await pullShared(tmpDir);

    const mistakes = readFileSync(join(tmpDir, ".ai-sessions", "mistakes.md"), "utf8");
    expect(mistakes).toContain("Remote mistake");
    expect(mistakes).toContain("Local mistake");
  });

  test("no-op if branch does not exist", async () => {
    // Should not throw
    await pullShared(tmpDir);
  });
});

describe("pushShared", () => {
  test("writes local files to branch", async () => {
    await initSharedBranch(tmpDir);

    mkdirSync(join(tmpDir, ".ai-sessions"), { recursive: true });
    writeFileSync(join(tmpDir, ".ai-sessions", "mistakes.md"), "- Push this\n");

    await pushShared(tmpDir);

    const onBranch = await readSharedFile(tmpDir, "mistakes.md");
    expect(onBranch).toContain("- Push this");
  });

  test("creates branch if missing", async () => {
    mkdirSync(join(tmpDir, ".ai-sessions"), { recursive: true });
    writeFileSync(join(tmpDir, ".ai-sessions", "mistakes.md"), "- Push this\n");

    await pushShared(tmpDir);

    const branches = (await $`git -C ${tmpDir} branch`.quiet()).text();
    expect(branches).toContain("ghost/knowledge");
  });

  test("skips empty local files", async () => {
    await initSharedBranch(tmpDir);
    mkdirSync(join(tmpDir, ".ai-sessions"), { recursive: true });
    writeFileSync(join(tmpDir, ".ai-sessions", "mistakes.md"), "");

    await pushShared(tmpDir);

    const onBranch = await readSharedFile(tmpDir, "mistakes.md");
    expect(onBranch).toBeNull();
  });
});

// =============================================================================
// syncKnowledge (end-to-end)
// =============================================================================

describe("syncKnowledge", () => {
  test("round-trip sync", async () => {
    mkdirSync(join(tmpDir, ".ai-sessions"), { recursive: true });
    writeFileSync(join(tmpDir, ".ai-sessions", "mistakes.md"), "- E2E mistake\n");
    writeFileSync(join(tmpDir, ".ai-sessions", "tags.json"), '{"test": ["s1"]}');

    await syncKnowledge(tmpDir);

    // Verify data is on branch
    const mistakes = await readSharedFile(tmpDir, "mistakes.md");
    expect(mistakes).toContain("E2E mistake");

    const tags = await readSharedFile(tmpDir, "tags.json");
    expect(tags).not.toBeNull();
    expect(JSON.parse(tags!).test).toEqual(["s1"]);
  });
});

// =============================================================================
// Two-repo sync via bare remote
// =============================================================================

describe("two-repo sync via bare remote", () => {
  let bareDir: string;
  let repo1: string;
  let repo2: string;

  beforeEach(async () => {
    bareDir = join(tmpDir, "bare.git");
    await $`git init --bare ${bareDir}`.quiet();

    // Repo 1: push initial commit so remote has a default branch
    repo1 = join(tmpDir, "repo1");
    await $`git clone ${bareDir} ${repo1}`.quiet();
    await $`git -C ${repo1} commit --allow-empty -m "init"`.quiet();
    await $`git -C ${repo1} push origin HEAD`.quiet();

    // Repo 2: clone from bare
    repo2 = join(tmpDir, "repo2");
    await $`git clone ${bareDir} ${repo2}`.quiet();
  });

  test("Dev A pushes, Dev B pulls", async () => {
    // Dev A writes a mistake and pushes
    mkdirSync(join(repo1, ".ai-sessions"), { recursive: true });
    writeFileSync(join(repo1, ".ai-sessions", "mistakes.md"), "- Shared team mistake\n");
    await syncKnowledge(repo1);

    // Dev B syncs and gets the mistake
    mkdirSync(join(repo2, ".ai-sessions"), { recursive: true });
    await syncKnowledge(repo2);

    const mistakes = readFileSync(join(repo2, ".ai-sessions", "mistakes.md"), "utf8");
    expect(mistakes).toContain("Shared team mistake");
  });

  test("both devs merge without conflict", async () => {
    // Dev A
    mkdirSync(join(repo1, ".ai-sessions"), { recursive: true });
    writeFileSync(join(repo1, ".ai-sessions", "mistakes.md"), "- Mistake from A\n");
    await syncKnowledge(repo1);

    // Dev B has a different mistake, syncs
    mkdirSync(join(repo2, ".ai-sessions"), { recursive: true });
    writeFileSync(join(repo2, ".ai-sessions", "mistakes.md"), "- Mistake from B\n");
    await syncKnowledge(repo2);

    const mistakesB = readFileSync(join(repo2, ".ai-sessions", "mistakes.md"), "utf8");
    expect(mistakesB).toContain("Mistake from A");
    expect(mistakesB).toContain("Mistake from B");

    // Dev A syncs again and gets B's mistake (clear rate-limit so fetch happens)
    try {
      unlinkSync(join(repo1, ".ai-sessions", ".last-sync"));
    } catch {
      // ignore
    }
    await syncKnowledge(repo1);
    const mistakesA = readFileSync(join(repo1, ".ai-sessions", "mistakes.md"), "utf8");
    expect(mistakesA).toContain("Mistake from A");
    expect(mistakesA).toContain("Mistake from B");
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { mainRepoRoot, repoRoot } from "./git.js";

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

describe("repoRoot", () => {
  test("returns repo root with cwd parameter", async () => {
    const root = await repoRoot(tmpDir);
    expect(root).toBe(tmpDir);
  });
});

describe("mainRepoRoot", () => {
  test("returns same path as repoRoot in a normal repo", async () => {
    const main = await mainRepoRoot(tmpDir);
    const top = await repoRoot(tmpDir);
    expect(main).toBe(top);
  });

  test("returns main repo root when called from a worktree", async () => {
    const wtDir = `${tmpDir}-worktree`;
    try {
      await $`git -C ${tmpDir} worktree add ${wtDir} -b test-wt`.quiet();

      // repoRoot from worktree should return the worktree dir
      const top = await repoRoot(wtDir);
      expect(top).toBe(wtDir);

      // mainRepoRoot from worktree should return the main repo dir
      const main = await mainRepoRoot(wtDir);
      expect(main).toBe(tmpDir);
    } finally {
      await $`git -C ${tmpDir} worktree remove ${wtDir} --force`.quiet().nothrow();
      if (existsSync(wtDir)) rmSync(wtDir, { recursive: true, force: true });
    }
  });
});

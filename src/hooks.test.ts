import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import {
  handlePostTask,
  handlePostWrite,
  handlePrompt,
  handleSessionEnd,
  handleSessionStart,
  handleStop,
} from "./hooks.js";
import { ACTIVE_DIR, COMPLETED_DIR, SESSION_DIR } from "./paths.js";
import { getActiveSessionId, getSessionPathForHook, parseFrontmatter, readSessionMap } from "./session.js";

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

describe("handleSessionStart", () => {
  test("creates session file", async () => {
    await handleSessionStart({ session_id: "test-123", cwd: tmpDir });
    const id = getActiveSessionId(tmpDir);
    expect(id).not.toBeNull();

    const filePath = join(tmpDir, SESSION_DIR, ACTIVE_DIR, `${id}.md`);
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf8");
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.session).toBe(id);
  });

  test("injects Ghost briefing with CLAUDE.md guidance", async () => {
    const context = await handleSessionStart({ session_id: "test-123", cwd: tmpDir });
    expect(context).toBeDefined();
    expect(context).toContain("Ghost is recording this session");
    expect(context).toContain("Do NOT write project knowledge or documentation into CLAUDE.md");
    expect(context).toContain("ghost-sessions");
  });
});

describe("handlePrompt", () => {
  test("appends prompt to active session", async () => {
    await handleSessionStart({ session_id: "test-123", cwd: tmpDir });
    await handlePrompt({ session_id: "test-123", cwd: tmpDir, prompt: "Fix the login bug" });

    const id = getActiveSessionId(tmpDir)!;
    const content = readFileSync(join(tmpDir, SESSION_DIR, ACTIVE_DIR, `${id}.md`), "utf8");
    expect(content).toMatch(/## Prompt 1 <!-- ph:[0-9a-f]{8} -->\n> Fix the login bug/);
  });

  test("skips empty prompts", async () => {
    await handleSessionStart({ session_id: "test-123", cwd: tmpDir });
    await handlePrompt({ session_id: "test-123", cwd: tmpDir, prompt: "" });

    const id = getActiveSessionId(tmpDir)!;
    const content = readFileSync(join(tmpDir, SESSION_DIR, ACTIVE_DIR, `${id}.md`), "utf8");
    expect(content).not.toContain("## Prompt");
  });
});

describe("handlePostWrite", () => {
  test("records file modification", async () => {
    await handleSessionStart({ session_id: "test-123", cwd: tmpDir });
    await handlePostWrite({
      session_id: "test-123",
      cwd: tmpDir,
      tool_name: "Write",
      tool_input: { file_path: "src/cart/fees.ts" },
    });

    const id = getActiveSessionId(tmpDir)!;
    const content = readFileSync(join(tmpDir, SESSION_DIR, ACTIVE_DIR, `${id}.md`), "utf8");
    expect(content).toContain("- Modified: src/cart/fees.ts");
  });

  test("normalizes absolute paths to repo-relative", async () => {
    await handleSessionStart({ session_id: "test-123", cwd: tmpDir });
    await handlePostWrite({
      session_id: "test-123",
      cwd: tmpDir,
      tool_name: "Write",
      tool_input: { file_path: `${tmpDir}/src/cart/fees.ts` },
    });

    const id = getActiveSessionId(tmpDir)!;
    const content = readFileSync(join(tmpDir, SESSION_DIR, ACTIVE_DIR, `${id}.md`), "utf8");
    expect(content).toContain("- Modified: src/cart/fees.ts");
    expect(content).not.toContain(tmpDir);
  });
});

describe("handlePostTask", () => {
  test("records task completion", async () => {
    await handleSessionStart({ session_id: "test-123", cwd: tmpDir });
    await handlePostTask({
      session_id: "test-123",
      cwd: tmpDir,
      tool_name: "Task",
      tool_input: { description: "Explore codebase" },
    });

    const id = getActiveSessionId(tmpDir)!;
    const content = readFileSync(join(tmpDir, SESSION_DIR, ACTIVE_DIR, `${id}.md`), "utf8");
    expect(content).toContain("- Task: Explore codebase");
  });
});

describe("handleStop", () => {
  test("appends turn delimiter", async () => {
    await handleSessionStart({ session_id: "test-123", cwd: tmpDir });
    await handleStop({ session_id: "test-123", cwd: tmpDir });

    const id = getActiveSessionId(tmpDir)!;
    const content = readFileSync(join(tmpDir, SESSION_DIR, ACTIVE_DIR, `${id}.md`), "utf8");
    expect(content).toContain("---\n_turn completed:");
  });
});

describe("handleSessionEnd", () => {
  test("moves session file to completed", async () => {
    await handleSessionStart({ session_id: "test-123", cwd: tmpDir });
    const id = getActiveSessionId(tmpDir)!;

    await handleSessionEnd({ session_id: "test-123", cwd: tmpDir });

    // Active file should be gone
    expect(existsSync(join(tmpDir, SESSION_DIR, ACTIVE_DIR, `${id}.md`))).toBe(false);

    // Completed file should exist
    expect(existsSync(join(tmpDir, SESSION_DIR, COMPLETED_DIR, `${id}.md`))).toBe(true);

    // Should have ended timestamp
    const content = readFileSync(join(tmpDir, SESSION_DIR, COMPLETED_DIR, `${id}.md`), "utf8");
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.ended).toBeDefined();
  });
});

describe("full session lifecycle", () => {
  test("start → prompt → write → stop → prompt → end", async () => {
    // Start
    await handleSessionStart({ session_id: "test-123", cwd: tmpDir });
    const id = getActiveSessionId(tmpDir)!;

    // First prompt
    await handlePrompt({ session_id: "test-123", cwd: tmpDir, prompt: "Refactor fees" });

    // File writes
    await handlePostWrite({
      session_id: "test-123",
      cwd: tmpDir,
      tool_name: "Edit",
      tool_input: { file_path: "src/fees.ts" },
    });
    await handlePostWrite({
      session_id: "test-123",
      cwd: tmpDir,
      tool_name: "Write",
      tool_input: { file_path: "src/types.ts" },
    });

    // Turn ends
    await handleStop({ session_id: "test-123", cwd: tmpDir });

    // Second prompt
    await handlePrompt({ session_id: "test-123", cwd: tmpDir, prompt: "Add tests" });

    // End session
    await handleSessionEnd({ session_id: "test-123", cwd: tmpDir });

    // Verify completed file structure
    const content = readFileSync(join(tmpDir, SESSION_DIR, COMPLETED_DIR, `${id}.md`), "utf8");
    expect(content).toMatch(/## Prompt 1 <!-- ph:[0-9a-f]{8} -->\n> Refactor fees/);
    expect(content).toContain("- Modified: src/fees.ts");
    expect(content).toContain("- Modified: src/types.ts");
    expect(content).toContain("_turn completed:");
    expect(content).toMatch(/## Prompt 2 <!-- ph:[0-9a-f]{8} -->\n> Add tests/);

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.ended).toBeDefined();
  });
});

describe("concurrent sessions via hooks", () => {
  test("two sessions write to separate files and finalize independently", async () => {
    // Start Session A
    await handleSessionStart({ session_id: "session-A", cwd: tmpDir });
    const mapAfterA = readSessionMap(tmpDir);
    const ghostIdA = mapAfterA["session-A"]!;
    expect(ghostIdA).toBeDefined();

    // Start Session B
    await handleSessionStart({ session_id: "session-B", cwd: tmpDir });
    const mapAfterB = readSessionMap(tmpDir);
    const ghostIdB = mapAfterB["session-B"]!;
    expect(ghostIdB).toBeDefined();
    expect(ghostIdA).not.toBe(ghostIdB);

    // Prompt from A
    await handlePrompt({ session_id: "session-A", cwd: tmpDir, prompt: "Fix auth" });
    await handlePostWrite({
      session_id: "session-A",
      cwd: tmpDir,
      tool_name: "Edit",
      tool_input: { file_path: "src/auth.ts" },
    });

    // Prompt from B
    await handlePrompt({ session_id: "session-B", cwd: tmpDir, prompt: "Fix cart" });
    await handlePostWrite({
      session_id: "session-B",
      cwd: tmpDir,
      tool_name: "Edit",
      tool_input: { file_path: "src/cart.ts" },
    });

    // Verify isolation: A's file has only A's content
    const pathA = getSessionPathForHook(tmpDir, "session-A")!;
    const contentA = readFileSync(pathA, "utf8");
    expect(contentA).toContain("Fix auth");
    expect(contentA).toContain("src/auth.ts");
    expect(contentA).not.toContain("Fix cart");
    expect(contentA).not.toContain("src/cart.ts");

    // Verify isolation: B's file has only B's content
    const pathB = getSessionPathForHook(tmpDir, "session-B")!;
    const contentB = readFileSync(pathB, "utf8");
    expect(contentB).toContain("Fix cart");
    expect(contentB).toContain("src/cart.ts");
    expect(contentB).not.toContain("Fix auth");
    expect(contentB).not.toContain("src/auth.ts");

    // End session A — B should continue working
    await handleSessionEnd({ session_id: "session-A", cwd: tmpDir });
    expect(existsSync(join(tmpDir, SESSION_DIR, COMPLETED_DIR, `${ghostIdA}.md`))).toBe(true);

    // B is still active
    await handlePrompt({ session_id: "session-B", cwd: tmpDir, prompt: "More cart work" });
    const contentB2 = readFileSync(pathB, "utf8");
    expect(contentB2).toContain("More cart work");

    // End session B
    await handleSessionEnd({ session_id: "session-B", cwd: tmpDir });
    expect(existsSync(join(tmpDir, SESSION_DIR, COMPLETED_DIR, `${ghostIdB}.md`))).toBe(true);

    // Session map should be empty
    const finalMap = readSessionMap(tmpDir);
    expect(Object.keys(finalMap).length).toBe(0);
  });
});

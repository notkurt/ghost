import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { resetDepCache } from "./deps.js";
import { ACTIVE_DIR, COMPLETED_DIR, SESSION_DIR } from "./paths.js";
import { collectionName, isQmdAvailable, removeCollection, resetQmdCache } from "./qmd.js";
import { disable, enable } from "./setup.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(import.meta.dir, `../.test-tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  await $`git init ${tmpDir}`.quiet();
  await $`git -C ${tmpDir} commit --allow-empty -m "init"`.quiet();
  resetQmdCache();
  resetDepCache();
});

afterEach(async () => {
  // Clean up QMD collection created by enable()
  try {
    const name = await collectionName(tmpDir);
    await removeCollection(name);
  } catch {
    // ignore
  }
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("enable", () => {
  test("creates directory structure", async () => {
    await enable(tmpDir);
    expect(existsSync(join(tmpDir, SESSION_DIR, ACTIVE_DIR))).toBe(true);
    expect(existsSync(join(tmpDir, SESSION_DIR, COMPLETED_DIR))).toBe(true);
  });

  test("adds .ai-sessions/ to project .gitignore", async () => {
    await enable(tmpDir);
    const gitignore = readFileSync(join(tmpDir, ".gitignore"), "utf8");
    expect(gitignore).toContain(".ai-sessions/");
  });

  test("writes correct hooks config", async () => {
    await enable(tmpDir);
    const settings = JSON.parse(readFileSync(join(tmpDir, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.SessionEnd).toBeDefined();
    expect(settings.hooks.UserPromptSubmit).toBeDefined();
    expect(settings.hooks.Stop).toBeDefined();
    expect(settings.hooks.PostToolUse).toBeDefined();

    const startHook = settings.hooks.SessionStart[0].hooks[0];
    expect(startHook.command).toBe("ghost session-start");
  });

  test("adds MCP server config to .mcp.json only when QMD is available", async () => {
    await enable(tmpDir);
    const qmdInstalled = await isQmdAvailable();
    if (qmdInstalled) {
      const mcpConfig = JSON.parse(readFileSync(join(tmpDir, ".mcp.json"), "utf8"));
      expect(mcpConfig.mcpServers).toBeDefined();
      expect(mcpConfig.mcpServers["ghost-sessions"]).toBeDefined();
      expect(mcpConfig.mcpServers["ghost-sessions"].command).toBe("qmd");
      expect(mcpConfig.mcpServers["ghost-sessions"].type).toBe("stdio");
    } else {
      expect(existsSync(join(tmpDir, ".mcp.json"))).toBe(false);
    }
    // settings.json should NOT have mcpServers
    const settings = JSON.parse(readFileSync(join(tmpDir, ".claude", "settings.json"), "utf8"));
    expect(settings.mcpServers).toBeUndefined();
  });

  test("installs post-commit hook", async () => {
    await enable(tmpDir);
    const hookPath = join(tmpDir, ".git", "hooks", "post-commit");
    expect(existsSync(hookPath)).toBe(true);
    const hookContent = readFileSync(hookPath, "utf8");
    expect(hookContent).toContain("ghost checkpoint &");
  });

  test("is idempotent", async () => {
    await enable(tmpDir);
    await enable(tmpDir);

    const settings = JSON.parse(readFileSync(join(tmpDir, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.SessionStart.length).toBe(1);
  });

  test("preserves existing settings", async () => {
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    const existing = { customSetting: true, hooks: {} };
    const settingsPath = join(tmpDir, ".claude", "settings.json");
    writeFileSync(settingsPath, JSON.stringify(existing));

    await enable(tmpDir);

    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.customSetting).toBe(true);
    expect(settings.hooks.SessionStart).toBeDefined();
  });

  test("injects Ghost header into CLAUDE.md", async () => {
    await enable(tmpDir);
    const content = readFileSync(join(tmpDir, "CLAUDE.md"), "utf8");
    expect(content).toContain("<!-- ghost:header -->");
    expect(content).toContain("Ghost — AI Session Memory");
    expect(content).toContain("ghost search <query>");
  });

  test("prepends header to existing CLAUDE.md", async () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), "# My Project\n\nExisting content.\n");
    await enable(tmpDir);
    const content = readFileSync(join(tmpDir, "CLAUDE.md"), "utf8");
    expect(content).toMatch(/^<!-- ghost:header -->/);
    expect(content).toContain("# My Project");
    expect(content).toContain("Existing content.");
  });

  test("replaces existing header on re-enable without duplicating", async () => {
    await enable(tmpDir);
    await enable(tmpDir);
    const content = readFileSync(join(tmpDir, "CLAUDE.md"), "utf8");
    const matches = content.match(/<!-- ghost:header -->/g) || [];
    expect(matches.length).toBe(2); // opening + closing sentinel
  });

  test("appends to existing post-commit hook without duplicating", async () => {
    const hooksDir = join(tmpDir, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, "post-commit"), "#!/bin/sh\necho 'existing hook'\n");

    await enable(tmpDir);
    await enable(tmpDir);

    const hookContent = readFileSync(join(hooksDir, "post-commit"), "utf8");
    expect(hookContent).toContain("existing hook");
    const matches = hookContent.match(/ghost checkpoint/g) || [];
    expect(matches.length).toBe(1);
  });
});

describe("disable", () => {
  test("removes hooks but keeps session files", async () => {
    await enable(tmpDir);
    await disable(tmpDir);

    expect(existsSync(join(tmpDir, SESSION_DIR, ACTIVE_DIR))).toBe(true);
    expect(existsSync(join(tmpDir, SESSION_DIR, COMPLETED_DIR))).toBe(true);

    const settings = JSON.parse(readFileSync(join(tmpDir, ".claude", "settings.json"), "utf8"));
    const hasGhostHooks =
      settings.hooks?.SessionStart?.some((m: any) => m.hooks?.some((h: any) => h.command?.startsWith("ghost "))) ??
      false;
    expect(hasGhostHooks).toBe(false);
  });

  test("removes MCP server from .mcp.json", async () => {
    await enable(tmpDir);
    await disable(tmpDir);

    const qmdInstalled = await isQmdAvailable();
    if (qmdInstalled) {
      const mcpConfig = JSON.parse(readFileSync(join(tmpDir, ".mcp.json"), "utf8"));
      expect(mcpConfig.mcpServers?.["ghost-sessions"]).toBeUndefined();
    }
    // settings.json should never have mcpServers
    const settings = JSON.parse(readFileSync(join(tmpDir, ".claude", "settings.json"), "utf8"));
    expect(settings.mcpServers?.["ghost-sessions"]).toBeUndefined();
  });

  test("removes Ghost header from CLAUDE.md", async () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), "# My Project\n\nExisting content.\n");
    await enable(tmpDir);
    await disable(tmpDir);
    const content = readFileSync(join(tmpDir, "CLAUDE.md"), "utf8");
    expect(content).not.toContain("<!-- ghost:header -->");
    expect(content).toContain("# My Project");
    expect(content).toContain("Existing content.");
  });

  test("reports not enabled when no settings", async () => {
    await disable(tmpDir);
  });
});

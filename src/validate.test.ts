import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { COMPLETED_DIR, SESSION_DIR } from "./paths.js";
import { validate } from "./validate.js";

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

describe("validate", () => {
  test("returns no issues for valid session files", () => {
    const compDir = join(tmpDir, SESSION_DIR, COMPLETED_DIR);
    mkdirSync(compDir, { recursive: true });
    writeFileSync(
      join(compDir, "2026-02-13-abcd1234.md"),
      `---\nsession: 2026-02-13-abcd1234\nbranch: main\nstarted: 2026-02-13T09:00:00Z\ntags: []\n---\n\n## Prompt 1\n> hello\n`,
    );
    const issues = validate(tmpDir);
    expect(issues.length).toBe(0);
  });

  test("detects missing frontmatter delimiter", () => {
    const compDir = join(tmpDir, SESSION_DIR, COMPLETED_DIR);
    mkdirSync(compDir, { recursive: true });
    writeFileSync(join(compDir, "2026-02-13-broken.md"), "no frontmatter here\n");
    const issues = validate(tmpDir);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.message).toContain("frontmatter delimiter");
  });

  test("detects invalid YAML in frontmatter", () => {
    const compDir = join(tmpDir, SESSION_DIR, COMPLETED_DIR);
    mkdirSync(compDir, { recursive: true });
    writeFileSync(
      join(compDir, "2026-02-13-badyaml.md"),
      `---\nsession: 2026-02-13-badyaml\ntags: [unclosed\n---\n\nbody\n`,
    );
    const issues = validate(tmpDir);
    expect(issues.some((i) => i.message.includes("Invalid YAML"))).toBe(true);
  });

  test("detects tags as non-array", () => {
    const compDir = join(tmpDir, SESSION_DIR, COMPLETED_DIR);
    mkdirSync(compDir, { recursive: true });
    writeFileSync(
      join(compDir, "2026-02-13-badtags.md"),
      `---\nsession: 2026-02-13-badtags\nstarted: 2026-02-13T09:00:00Z\ntags: "not-an-array"\n---\n\nbody\n`,
    );
    const issues = validate(tmpDir);
    expect(issues.some((i) => i.message.includes("tags") && i.fixable)).toBe(true);
  });

  test("fixes tags as string with --fix", () => {
    const compDir = join(tmpDir, SESSION_DIR, COMPLETED_DIR);
    mkdirSync(compDir, { recursive: true });
    const filePath = join(compDir, "2026-02-13-fixtags.md");
    writeFileSync(
      filePath,
      `---\nsession: 2026-02-13-fixtags\nstarted: 2026-02-13T09:00:00Z\ntags: "area:cart, bugs"\n---\n\nbody\n`,
    );
    validate(tmpDir, { fix: true });

    const content = readFileSync(filePath, "utf8");
    expect(content).toContain("- area:cart");
    expect(content).toContain("- bugs");
  });

  test("detects invalid tags.json", () => {
    const sessDir = join(tmpDir, SESSION_DIR);
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(join(sessDir, "tags.json"), "not json");
    const issues = validate(tmpDir);
    expect(issues.some((i) => i.file === "tags.json")).toBe(true);
  });

  test("detects tags.json with non-array values", () => {
    const sessDir = join(tmpDir, SESSION_DIR);
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(join(sessDir, "tags.json"), JSON.stringify({ "area:cart": "not-an-array" }));
    const issues = validate(tmpDir);
    expect(issues.some((i) => i.file === "tags.json" && i.fixable)).toBe(true);
  });

  test("fixes tags.json with non-array values", () => {
    const sessDir = join(tmpDir, SESSION_DIR);
    mkdirSync(sessDir, { recursive: true });
    const tagsFile = join(sessDir, "tags.json");
    writeFileSync(tagsFile, JSON.stringify({ "area:cart": "session-1", bugs: ["session-2"] }));
    validate(tmpDir, { fix: true });

    const fixed = JSON.parse(readFileSync(tagsFile, "utf8"));
    expect(Array.isArray(fixed["area:cart"])).toBe(true);
    expect(fixed["area:cart"]).toEqual(["session-1"]);
    expect(fixed.bugs).toEqual(["session-2"]);
  });

  test("detects missing session field", () => {
    const compDir = join(tmpDir, SESSION_DIR, COMPLETED_DIR);
    mkdirSync(compDir, { recursive: true });
    writeFileSync(
      join(compDir, "2026-02-13-nosession.md"),
      `---\nbranch: main\nstarted: 2026-02-13T09:00:00Z\n---\n\nbody\n`,
    );
    const issues = validate(tmpDir);
    expect(issues.some((i) => i.message.includes("session"))).toBe(true);
  });

  test("returns no issues when no session dir exists", () => {
    const issues = validate(tmpDir);
    expect(issues.length).toBe(0);
  });
});

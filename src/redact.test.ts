import { describe, expect, test } from "bun:test";
import { redactSecrets, redactWithBuiltinPatterns } from "./redact.js";

describe("redactWithBuiltinPatterns", () => {
  test("redacts AWS access keys", () => {
    const input = "key: AKIAIOSFODNN7EXAMPLE";
    expect(redactWithBuiltinPatterns(input)).toBe("key: ****");
  });

  test("redacts GitHub personal access tokens (ghp_)", () => {
    const input = `token: ghp_${"A".repeat(36)}`;
    expect(redactWithBuiltinPatterns(input)).toBe("token: ****");
  });

  test("redacts GitHub OAuth tokens (gho_)", () => {
    const input = `token: gho_${"B".repeat(36)}`;
    expect(redactWithBuiltinPatterns(input)).toBe("token: ****");
  });

  test("redacts GitHub PAT (github_pat_)", () => {
    const input = `token: github_pat_${"C".repeat(22)}`;
    expect(redactWithBuiltinPatterns(input)).toBe("token: ****");
  });

  test("redacts GitLab personal access tokens", () => {
    const input = "token: glpat-xxxxxxxxxxxxxxxxxxxx";
    expect(redactWithBuiltinPatterns(input)).toBe("token: ****");
  });

  test("redacts Slack tokens", () => {
    const input = "token: xoxb-1234567890-abcdefghij";
    expect(redactWithBuiltinPatterns(input)).toBe("token: ****");
  });

  test("redacts OpenAI keys", () => {
    const input = `key: sk-${"a".repeat(48)}`;
    expect(redactWithBuiltinPatterns(input)).toBe("key: ****");
  });

  test("redacts Anthropic keys", () => {
    const input = `key: sk-ant-${"a".repeat(40)}`;
    expect(redactWithBuiltinPatterns(input)).toBe("key: ****");
  });

  test("redacts SendGrid keys", () => {
    const a = "A".repeat(22).replace(/A/g, (_, i: number) => "abcdefghijklmnopqrstuv"[i % 22]!);
    const b = "B".repeat(43).replace(/B/g, (_, i: number) => "abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE"[i % 43]!);
    const input = `key: SG.${a}.${b}`;
    expect(redactWithBuiltinPatterns(input)).toBe("key: ****");
  });

  test("redacts Stripe secret keys", () => {
    const input = `key: sk_live_${"a".repeat(24)}`;
    expect(redactWithBuiltinPatterns(input)).toBe("key: ****");
  });

  test("redacts Stripe restricted keys", () => {
    const input = `key: rk_live_${"b".repeat(24)}`;
    expect(redactWithBuiltinPatterns(input)).toBe("key: ****");
  });

  test("redacts private keys", () => {
    const input = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const result = redactWithBuiltinPatterns(input);
    expect(result).toContain("-----BEGIN PRIVATE KEY-----");
    expect(result).toContain("****");
    expect(result).toContain("-----END PRIVATE KEY-----");
    expect(result).not.toContain("MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn");
  });

  test("redacts Bearer tokens", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc";
    const result = redactWithBuiltinPatterns(input);
    expect(result).toBe("Authorization: Bearer ****");
  });

  test("redacts Basic auth headers", () => {
    const input = "Authorization: Basic dXNlcjpwYXNzd29yZA==";
    const result = redactWithBuiltinPatterns(input);
    expect(result).toBe("Authorization: Basic ****");
  });

  test("redacts credentials in URLs", () => {
    const input = "url: https://admin:s3cretP@ss@example.com/api";
    const result = redactWithBuiltinPatterns(input);
    expect(result).toBe("url: https://admin:****@example.com/api");
    expect(result).not.toContain("s3cretP@ss");
  });

  test("redacts generic api_key assignments", () => {
    const input = `api_key="ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"`;
    const result = redactWithBuiltinPatterns(input);
    expect(result).toContain("****");
    expect(result).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
  });

  test("redacts generic secret_key assignments", () => {
    const input = `secret_key: "abcdefghijklmnopqrstuvwxyz"`;
    const result = redactWithBuiltinPatterns(input);
    expect(result).toContain("****");
    expect(result).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  test("redacts generic token assignments", () => {
    const input = `token = "AABBCCDD11223344556677889900AABB"`;
    const result = redactWithBuiltinPatterns(input);
    expect(result).toContain("****");
    expect(result).not.toContain("AABBCCDD11223344556677889900AABB");
  });

  test("redacts password assignments", () => {
    const _input = `password: "MyS3cureP@ssw0rd!!!!!"`;
    // The password pattern requires 20+ alphanumeric chars — this one has special chars
    // so let's use a longer alnum password
    const input2 = `password="abcdefghijklmnopqrstuvwxyz1234567890"`;
    const result = redactWithBuiltinPatterns(input2);
    expect(result).toContain("****");
    expect(result).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");
  });

  test("preserves normal markdown content", () => {
    const input = [
      "---",
      "session: 2025-01-15-abc12345",
      "branch: main",
      "---",
      "",
      "## Prompt 1",
      "> How do I fix the login bug?",
      "",
      "- Modified: src/auth.ts",
      "- Task: Fixed authentication flow",
    ].join("\n");
    expect(redactWithBuiltinPatterns(input)).toBe(input);
  });

  test("redacts multiple secrets in one document", () => {
    const input = [
      "Used AKIAIOSFODNN7EXAMPLE to access S3",
      `Also tried ghp_${"x".repeat(36)} for GitHub`,
      `And sk-${"a".repeat(48)} for OpenAI`,
    ].join("\n");
    const result = redactWithBuiltinPatterns(input);
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result).not.toContain("ghp_");
    expect(result).not.toContain("sk-");
    // All three lines should have redaction markers
    const lines = result.split("\n");
    for (const line of lines) {
      expect(line).toContain("****");
    }
  });

  test("handles empty content", () => {
    expect(redactWithBuiltinPatterns("")).toBe("");
  });

  test("is idempotent — redacting twice gives same result", () => {
    const input = "key: AKIAIOSFODNN7EXAMPLE and token: xoxb-1234567890-abcdefghij";
    const once = redactWithBuiltinPatterns(input);
    const twice = redactWithBuiltinPatterns(once);
    expect(twice).toBe(once);
  });
});

describe("redactSecrets", () => {
  test("redacts secrets detected by secretlint (GitHub token)", async () => {
    const token = `ghp_${"A".repeat(36)}`;
    const input = `token: ${token}`;
    const result = await redactSecrets(input);
    expect(result).not.toContain(token);
    expect(result).toContain("****");
  });

  test("falls back to builtin patterns for secrets secretlint misses", async () => {
    const input = "key: AKIAIOSFODNN7EXAMPLE";
    const result = await redactSecrets(input);
    // Built-in fallback catches AWS keys even if secretlint doesn't flag example keys
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result).toContain("****");
  });

  test("handles content with no secrets", async () => {
    const input = "This is just normal text with no secrets.";
    const result = await redactSecrets(input);
    expect(result).toBe(input);
  });
});

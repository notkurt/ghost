/**
 * Secret redaction for session content.
 *
 * Two layers:
 * 1. Built-in regex patterns (sync, fast) — used in finalizeSession()
 * 2. secretlint engine (async, thorough) — used in background.ts
 */

const REDACTED = "****";

// =============================================================================
// Built-in Regex Patterns
// =============================================================================

interface PatternDef {
  name: string;
  pattern: RegExp;
  replacement?: string;
}

const BUILTIN_PATTERNS: PatternDef[] = [
  // AWS access keys
  { name: "aws-access-key", pattern: /AKIA[0-9A-Z]{16}/g },

  // GitHub tokens
  { name: "github-token", pattern: /gh[psorau]_[A-Za-z0-9_]{36,255}/g },
  { name: "github-pat", pattern: /github_pat_[A-Za-z0-9_]{22,255}/g },

  // GitLab personal access tokens
  { name: "gitlab-token", pattern: /glpat-[A-Za-z0-9\-_]{20,}/g },

  // Slack tokens
  { name: "slack-token", pattern: /xox[bpas]-[A-Za-z0-9-]{10,}/g },

  // OpenAI keys
  { name: "openai-key", pattern: /sk-[A-Za-z0-9]{20,}/g },

  // Anthropic keys
  { name: "anthropic-key", pattern: /sk-ant-[A-Za-z0-9\-_]{20,}/g },

  // SendGrid keys
  { name: "sendgrid-key", pattern: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/g },

  // Stripe keys
  { name: "stripe-secret", pattern: /sk_live_[A-Za-z0-9]{24,}/g },
  { name: "stripe-restricted", pattern: /rk_live_[A-Za-z0-9]{24,}/g },

  // Private keys (multiline)
  {
    name: "private-key",
    pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
    replacement: `-----BEGIN PRIVATE KEY-----\n${REDACTED}\n-----END PRIVATE KEY-----`,
  },

  // Bearer / Basic auth headers
  { name: "bearer-token", pattern: /(Bearer\s+)[A-Za-z0-9\-_.~+/]+=*/g, replacement: `$1${REDACTED}` },
  { name: "basic-auth-header", pattern: /(Basic\s+)[A-Za-z0-9+/]+=*/g, replacement: `$1${REDACTED}` },

  // Basic auth in URLs: ://user:password@ (password may contain @)
  { name: "url-credentials", pattern: /(:\/\/[^:/\s]+:)([^\s]+)(@[A-Za-z0-9.-]+)/g, replacement: `$1${REDACTED}$3` },

  // Generic key/secret/token/password assignments
  {
    name: "generic-secret",
    pattern:
      /((?:api[_-]?key|secret[_-]?key|token|password|passwd|auth[_-]?token|access[_-]?token|client[_-]?secret)\s*[=:]\s*["']?)[A-Za-z0-9/+=\-_.]{20,}/gi,
    replacement: `$1${REDACTED}`,
  },
];

/** Synchronous regex-based redaction. Fast path for finalizeSession(). */
export function redactWithBuiltinPatterns(content: string): string {
  let result = content;
  for (const { pattern, replacement } of BUILTIN_PATTERNS) {
    // Reset lastIndex for global regexes (they're reused across calls)
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement ?? REDACTED);
  }
  return result;
}

// =============================================================================
// Secretlint Engine (async, thorough)
// =============================================================================

/** Async redaction: secretlint pass then built-in patterns for full coverage. */
export async function redactSecrets(content: string): Promise<string> {
  let result = content;
  try {
    result = await redactWithSecretlint(result);
  } catch {
    // Secretlint failed — built-in patterns below will still run
  }
  return redactWithBuiltinPatterns(result);
}

interface SecretlintMessage {
  range: [number, number];
}

interface SecretlintFileResult {
  messages: SecretlintMessage[];
}

async function redactWithSecretlint(content: string): Promise<string> {
  const { createEngine } = await import("@secretlint/node");
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  // secretlint requires a config file on disk for rule resolution
  const configPath = join(tmpdir(), `.secretlintrc-ghost-${process.pid}.json`);
  writeFileSync(
    configPath,
    JSON.stringify({
      rules: [{ id: "@secretlint/secretlint-rule-preset-recommend" }],
    }),
  );

  try {
    const engine = await createEngine({
      formatter: "json",
      color: false,
      configFilePath: configPath,
    });

    const result = await engine.executeOnContent({
      content,
      filePath: "session.md",
    });

    // No issues found
    if (result.ok) {
      return content;
    }

    // Output is an array of file results: [{ messages: [...] }]
    const report = JSON.parse(result.output) as SecretlintFileResult[];
    const messages = report[0]?.messages ?? [];
    if (messages.length === 0) {
      return content;
    }

    // Sort by position descending so replacements don't shift offsets
    const sorted = [...messages].sort((a, b) => b.range[0] - a.range[0]);
    let redacted = content;
    for (const msg of sorted) {
      if (msg.range) {
        const [start, end] = msg.range;
        redacted = redacted.slice(0, start) + REDACTED + redacted.slice(end);
      }
    }
    return redacted;
  } finally {
    try {
      unlinkSync(configPath);
    } catch {
      /* ignore */
    }
  }
}

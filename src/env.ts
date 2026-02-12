import { z } from "zod/v4";

// =============================================================================
// Hook Input Schemas
// =============================================================================

/** Base fields present in all hook inputs */
const BaseInput = z.object({
  session_id: z.string(),
  cwd: z.string(),
});

/** SessionStart hook input */
export const SessionStartInput = BaseInput.extend({
  source: z.string().optional(),
});
export type SessionStartInput = z.infer<typeof SessionStartInput>;

/** UserPromptSubmit hook input */
export const UserPromptInput = BaseInput.extend({
  prompt: z.string().optional(),
});
export type UserPromptInput = z.infer<typeof UserPromptInput>;

/** PostToolUse hook input */
export const PostToolUseInput = BaseInput.extend({
  tool_name: z.string().optional(),
  tool_input: z.record(z.string(), z.unknown()).optional(),
});
export type PostToolUseInput = z.infer<typeof PostToolUseInput>;

/** Stop hook input */
export const StopInput = BaseInput.extend({
  stop_hook_active: z.boolean().optional(),
});
export type StopInput = z.infer<typeof StopInput>;

/** SessionEnd hook input */
export const SessionEndInput = BaseInput.extend({
  reason: z.string().optional(),
});
export type SessionEndInput = z.infer<typeof SessionEndInput>;

// =============================================================================
// Stdin Reading
// =============================================================================

/** Read and parse JSON from stdin (Claude Code hooks pass data via stdin) */
export async function readHookInput(): Promise<unknown> {
  try {
    const text = await Bun.stdin.text();
    if (!text.trim()) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** Read stdin and validate against a zod schema */
export async function readTypedInput<T>(schema: z.ZodType<T>): Promise<T> {
  const raw = await readHookInput();
  return schema.parse(raw);
}

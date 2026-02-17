import { describe, expect, test } from "bun:test";
import {
  extractDecisionEntries,
  extractKnowledgeEntries,
  extractMistakeEntries,
  extractSections,
  extractStrategyEntries,
  isValidSummary,
} from "./summarize.js";

describe("extractSections", () => {
  const fullSummary = `## Intent
Migrate cart fee system from fixed dollar amounts to percentage-based with a cap.

## Changes
- \`src/cart/fees.ts\` — Replaced fixed fee lookup with percentage calc
- \`src/cart/types.ts\` — Added FeeStrategy type union
- \`src/cart/__tests__/fees.test.ts\` — Added edge case tests

## Decisions
**Percentage with hard cap over tiered:** Client wanted flexible fees. Chose percentage with $50 cap — simpler.
Files: src/cart/fees.ts, src/cart/types.ts
**Keep backward compat:** Default strategy to 'percentage' if unset in existing data.
Files: src/cart/fees.ts

## Mistakes
**Wrong boundary condition:** Used >= instead of > for $500 threshold → caused double-cap. Fixed to strict >.
Tried: Using >= comparison, Rounding before comparison
Files: src/cart/fees.ts
Rule: WHEN modifying src/cart/fees.ts ALWAYS use strict > for threshold comparisons

## Open Items
- Need to update metafield sync to include fee strategy
- Tax interaction with percentage fees untested

## Tags
area:cart, fees, type:refactor, percentage-fees`;

  test("extracts tags correctly", () => {
    const sections = extractSections(fullSummary);
    expect(sections.tags).toContain("area:cart");
    expect(sections.tags).toContain("fees");
    expect(sections.tags).toContain("type:refactor");
    expect(sections.tags).toContain("percentage-fees");
    expect(sections.tags.length).toBe(4);
  });

  test("extracts decisions as ExtractedEntry objects", () => {
    const sections = extractSections(fullSummary);
    expect(sections.decisions.length).toBe(2);
    expect(sections.decisions[0]!.text).toContain("Percentage with hard cap");
    expect(sections.decisions[0]!.files).toEqual(["src/cart/fees.ts", "src/cart/types.ts"]);
    expect(sections.decisions[1]!.text).toContain("Keep backward compat");
    expect(sections.decisions[1]!.files).toEqual(["src/cart/fees.ts"]);
  });

  test("extracts mistakes as ExtractedEntry objects", () => {
    const sections = extractSections(fullSummary);
    expect(sections.mistakes.length).toBe(1);
    expect(sections.mistakes[0]!.text).toContain("Wrong boundary condition");
    expect(sections.mistakes[0]!.files).toEqual(["src/cart/fees.ts"]);
    expect(sections.mistakes[0]!.tried).toEqual(["Using >= comparison", "Rounding before comparison"]);
    expect(sections.mistakes[0]!.rule).toBe(
      "WHEN modifying src/cart/fees.ts ALWAYS use strict > for threshold comparisons",
    );
  });

  test("extracts intent", () => {
    const sections = extractSections(fullSummary);
    expect(sections.intent).toContain("Migrate cart fee system");
  });

  test("extracts open items", () => {
    const sections = extractSections(fullSummary);
    expect(sections.openItems).toContain("metafield sync");
    expect(sections.openItems).toContain("Tax interaction");
  });

  test("handles no mistakes gracefully", () => {
    const summary = `## Intent
Quick fix.

## Changes
- One file changed.

## Decisions
None significant.

## Mistakes
_None this session._

## Open Items
Nothing.

## Tags
quick-fix`;

    const sections = extractSections(summary);
    expect(sections.mistakes.length).toBe(0);
  });

  test("extracts empty strategies from summary without Strategies section", () => {
    const sections = extractSections(fullSummary);
    expect(sections.strategies).toEqual([]);
  });

  test("extracts empty knowledge from summary without Knowledge section", () => {
    const sections = extractSections(fullSummary);
    expect(sections.knowledge).toEqual([]);
  });

  test("handles empty summary", () => {
    const sections = extractSections("");
    expect(sections.tags).toEqual([]);
    expect(sections.decisions).toEqual([]);
    expect(sections.mistakes).toEqual([]);
    expect(sections.strategies).toEqual([]);
    expect(sections.knowledge).toEqual([]);
    expect(sections.intent).toBe("");
    expect(sections.openItems).toBe("");
  });

  test("handles partial summary (missing sections)", () => {
    const partial = `## Intent
Just testing.

## Tags
test, debug`;

    const sections = extractSections(partial);
    expect(sections.intent).toContain("Just testing");
    expect(sections.tags).toContain("test");
    expect(sections.tags).toContain("debug");
    expect(sections.decisions).toEqual([]);
    expect(sections.changes).toBe("");
  });
});

describe("extractMistakeEntries", () => {
  test("returns objects with text, files, tried, rule", () => {
    const summary = `## Mistakes
**Timeout on batch:** Batched 100 mutations → timeout.
Tried: Batching 100, Single large query
Files: src/sync/deploy.ts, src/sync/batch.ts
Rule: WHEN modifying src/sync/deploy.ts NEVER batch more than 25 mutations`;

    const entries = extractMistakeEntries(summary);
    expect(entries.length).toBe(1);
    expect(entries[0]!.text).toContain("Timeout on batch");
    expect(entries[0]!.files).toEqual(["src/sync/deploy.ts", "src/sync/batch.ts"]);
    expect(entries[0]!.tried).toEqual(["Batching 100", "Single large query"]);
    expect(entries[0]!.rule).toBe("WHEN modifying src/sync/deploy.ts NEVER batch more than 25 mutations");
  });

  test("handles missing Files/Tried/Rule lines gracefully", () => {
    const summary = `## Mistakes
**Simple mistake:** Something went wrong.`;

    const entries = extractMistakeEntries(summary);
    expect(entries.length).toBe(1);
    expect(entries[0]!.text).toContain("Simple mistake");
    expect(entries[0]!.files).toEqual([]);
    expect(entries[0]!.tried).toEqual([]);
    expect(entries[0]!.rule).toBe("");
  });

  test("handles multiple entries in same section", () => {
    const summary = `## Mistakes
**First mistake:** Description A.
Files: src/a.ts
**Second mistake:** Description B.
Tried: Approach X, Approach Y`;

    const entries = extractMistakeEntries(summary);
    expect(entries.length).toBe(2);
    expect(entries[0]!.files).toEqual(["src/a.ts"]);
    expect(entries[1]!.tried).toEqual(["Approach X", "Approach Y"]);
  });
});

describe("extractDecisionEntries", () => {
  test("returns objects with text, files, tried, rule", () => {
    const summary = `## Decisions
**Use Redis for caching:** Needed fast reads → chose Redis over Memcached.
Files: src/cache/redis.ts, src/cache/index.ts
Rule: WHEN adding cache layers ALWAYS use Redis`;

    const entries = extractDecisionEntries(summary);
    expect(entries.length).toBe(1);
    expect(entries[0]!.text).toContain("Use Redis for caching");
    expect(entries[0]!.files).toEqual(["src/cache/redis.ts", "src/cache/index.ts"]);
    expect(entries[0]!.rule).toBe("WHEN adding cache layers ALWAYS use Redis");
  });

  test("handles entries without metadata lines", () => {
    const summary = `## Decisions
**Simple decision:** Just decided something.`;

    const entries = extractDecisionEntries(summary);
    expect(entries.length).toBe(1);
    expect(entries[0]!.files).toEqual([]);
    expect(entries[0]!.rule).toBe("");
  });

  test("filters 'None' variations", () => {
    expect(extractDecisionEntries("## Decisions\nNone")).toEqual([]);
    expect(extractDecisionEntries("## Decisions\nN/A")).toEqual([]);
    expect(extractDecisionEntries("## Decisions\nNo significant decisions this session.")).toEqual([]);
    expect(extractDecisionEntries("## Decisions\nNo key decisions made.")).toEqual([]);
    expect(extractDecisionEntries("## Decisions\nNot applicable")).toEqual([]);
    expect(extractDecisionEntries("## Decisions\nNothing")).toEqual([]);
  });
});

describe("extractSections — skipKnowledge", () => {
  test("returns skipKnowledge=true when Relevance is 'skip'", () => {
    const summary = `## Intent
Testing the AI tool.

## Changes
- No real changes.

## Decisions
None

## Mistakes
None

## Open Items
None

## Relevance
skip

## Tags
test`;

    const sections = extractSections(summary);
    expect(sections.skipKnowledge).toBe(true);
  });

  test("returns skipKnowledge=false when Relevance is 'keep'", () => {
    const summary = `## Intent
Migrate cart system.

## Changes
- Updated fees.

## Decisions
None

## Mistakes
None

## Open Items
None

## Relevance
keep

## Tags
area:cart`;

    const sections = extractSections(summary);
    expect(sections.skipKnowledge).toBe(false);
  });

  test("returns skipKnowledge=false when Relevance section is missing", () => {
    const summary = `## Intent
Quick fix.

## Tags
fix`;

    const sections = extractSections(summary);
    expect(sections.skipKnowledge).toBe(false);
  });

  test("handles case-insensitive 'Skip'", () => {
    const summary = `## Intent
Test chat.

## Relevance
Skip

## Tags
test`;

    const sections = extractSections(summary);
    expect(sections.skipKnowledge).toBe(true);
  });
});

describe("extractMistakeEntries — junk filtering", () => {
  test("filters 'None' variations", () => {
    expect(extractMistakeEntries("## Mistakes\nNone")).toEqual([]);
    expect(extractMistakeEntries("## Mistakes\nN/A")).toEqual([]);
    expect(extractMistakeEntries("## Mistakes\nNo mistakes this session.")).toEqual([]);
    expect(extractMistakeEntries("## Mistakes\nNo errors encountered.")).toEqual([]);
    expect(extractMistakeEntries("## Mistakes\nNo issues found.")).toEqual([]);
    expect(extractMistakeEntries("## Mistakes\nNot applicable")).toEqual([]);
    expect(extractMistakeEntries("## Mistakes\nNothing")).toEqual([]);
  });

  test("filters bold-formatted None", () => {
    expect(extractMistakeEntries("## Mistakes\n**None** - documentation task completed successfully")).toEqual([]);
  });

  test("still captures real mistakes", () => {
    const summary = `## Mistakes
**Wrong boundary condition:** Used >= instead of > for threshold.`;
    const entries = extractMistakeEntries(summary);
    expect(entries.length).toBe(1);
    expect(entries[0]!.text).toContain("Wrong boundary condition");
  });
});

describe("extractStrategyEntries", () => {
  test("extracts strategy entries with files", () => {
    const summary = `## Strategies
**Update existing vs replace object:** Considered updating the existing handle object in place vs deleting and replacing → chose update in place for referential integrity.
Files: src/handles/update.ts, src/handles/sync.ts`;

    const entries = extractStrategyEntries(summary);
    expect(entries.length).toBe(1);
    expect(entries[0]!.text).toContain("Update existing vs replace object");
    expect(entries[0]!.files).toEqual(["src/handles/update.ts", "src/handles/sync.ts"]);
  });

  test("extracts multiple strategy entries", () => {
    const summary = `## Strategies
**Polling vs WebSocket:** Compared polling every 5s vs WebSocket connection → unresolved
**Batch vs stream:** Process records in batch vs stream one at a time → chose streaming`;

    const entries = extractStrategyEntries(summary);
    expect(entries.length).toBe(2);
    expect(entries[0]!.text).toContain("Polling vs WebSocket");
    expect(entries[1]!.text).toContain("Batch vs stream");
  });

  test("filters None variations", () => {
    expect(extractStrategyEntries("## Strategies\nNone")).toEqual([]);
    expect(extractStrategyEntries("## Strategies\nN/A")).toEqual([]);
    expect(extractStrategyEntries("## Strategies\nNo strategies")).toEqual([]);
    expect(extractStrategyEntries("## Strategies\nNot applicable")).toEqual([]);
    expect(extractStrategyEntries("## Strategies\nNothing")).toEqual([]);
  });

  test("returns empty for missing section", () => {
    expect(extractStrategyEntries("## Intent\nSomething")).toEqual([]);
  });

  test("handles entries without Files line", () => {
    const summary = `## Strategies
**Cache invalidation approach:** TTL vs event-driven → unresolved`;

    const entries = extractStrategyEntries(summary);
    expect(entries.length).toBe(1);
    expect(entries[0]!.files).toEqual([]);
  });
});

describe("extractKnowledgeEntries", () => {
  test("extracts knowledge entries with files", () => {
    const summary = `## Knowledge
**Cart fee system uses percentage with cap:** The fee calculation applies a percentage to the subtotal with a hard $50 cap.
Files: src/cart/fees.ts`;

    const entries = extractKnowledgeEntries(summary);
    expect(entries.length).toBe(1);
    expect(entries[0]!.text).toContain("Cart fee system uses percentage with cap");
    expect(entries[0]!.files).toEqual(["src/cart/fees.ts"]);
  });

  test("extracts multiple knowledge entries", () => {
    const summary = `## Knowledge
**Router uses file-based routing:** Pages in app/routes/ map directly to URL paths.
Files: app/routes/
**Auth middleware checks JWT:** All API routes pass through auth middleware first.
Files: src/middleware/auth.ts`;

    const entries = extractKnowledgeEntries(summary);
    expect(entries.length).toBe(2);
  });

  test("filters None variations", () => {
    expect(extractKnowledgeEntries("## Knowledge\nNone")).toEqual([]);
    expect(extractKnowledgeEntries("## Knowledge\nN/A")).toEqual([]);
    expect(extractKnowledgeEntries("## Knowledge\nNo knowledge")).toEqual([]);
    expect(extractKnowledgeEntries("## Knowledge\nNot applicable")).toEqual([]);
    expect(extractKnowledgeEntries("## Knowledge\nNothing")).toEqual([]);
  });

  test("returns empty for missing section", () => {
    expect(extractKnowledgeEntries("## Intent\nSomething")).toEqual([]);
  });
});

describe("isValidSummary", () => {
  test("returns true for properly structured summary", () => {
    const summary = `## Intent
Something.

## Changes
- file.ts

## Tags
test`;

    expect(isValidSummary(summary)).toBe(true);
  });

  test("returns false for conversational response", () => {
    expect(isValidSummary("Sure! Here's a summary of what happened in this session...")).toBe(false);
  });

  test("returns false for summary missing Tags", () => {
    const summary = `## Intent
Something.

## Changes
- file.ts`;

    expect(isValidSummary(summary)).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isValidSummary("")).toBe(false);
  });

  test("returns true when Intent is not the first section but exists", () => {
    const summary = `Some preamble text

## Intent
Something.

## Tags
test`;

    expect(isValidSummary(summary)).toBe(true);
  });
});

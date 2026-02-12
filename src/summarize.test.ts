import { describe, expect, test } from "bun:test";
import { extractSections } from "./summarize.js";

describe("extractSections", () => {
  const fullSummary = `## Intent
Migrate cart fee system from fixed dollar amounts to percentage-based with a cap.

## Changes
- \`src/cart/fees.ts\` — Replaced fixed fee lookup with percentage calc
- \`src/cart/types.ts\` — Added FeeStrategy type union
- \`src/cart/__tests__/fees.test.ts\` — Added edge case tests

## Decisions
**Percentage with hard cap over tiered:** Client wanted flexible fees. Chose percentage with $50 cap — simpler.
**Keep backward compat:** Default strategy to 'percentage' if unset in existing data.

## Mistakes
**Wrong boundary condition:** Used >= instead of > for $500 threshold → caused double-cap. Fixed to strict >.

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

  test("extracts decisions", () => {
    const sections = extractSections(fullSummary);
    expect(sections.decisions.length).toBe(2);
    expect(sections.decisions[0]).toContain("Percentage with hard cap");
    expect(sections.decisions[1]).toContain("Keep backward compat");
  });

  test("extracts mistakes", () => {
    const sections = extractSections(fullSummary);
    expect(sections.mistakes.length).toBe(1);
    expect(sections.mistakes[0]).toContain("Wrong boundary condition");
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

  test("handles empty summary", () => {
    const sections = extractSections("");
    expect(sections.tags).toEqual([]);
    expect(sections.decisions).toEqual([]);
    expect(sections.mistakes).toEqual([]);
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

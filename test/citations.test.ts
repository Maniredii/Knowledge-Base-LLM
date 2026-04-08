import { describe, it, expect } from "vitest";
import {
  parseCitations,
  matchCitation,
  matchAllCitations,
  citationStatus,
  formatCitation,
  citationSummary,
} from "../src/citations.js";
import type { RawCitation, MatchedCitation } from "../src/citations.js";

// ── parseCitations ──────────────────────────────────────────────────────────

describe("parseCitations", () => {
  it("returns empty citations when no CITATIONS block exists", () => {
    const result = parseCitations("This is a regular answer with no citations.");
    expect(result.answer).toBe("This is a regular answer with no citations.");
    expect(result.citations).toEqual([]);
  });

  it("parses a single citation", () => {
    const response = `The lease starts on March 15, 2019.

CITATIONS:
- file: "lease-agreement.md", page: 12, quote: "Lease Start Date: 15 March 2019"`;

    const result = parseCitations(response);
    expect(result.answer).toBe("The lease starts on March 15, 2019.");
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toEqual({
      file: "lease-agreement.md",
      page: 12,
      quote: "Lease Start Date: 15 March 2019",
    });
  });

  it("parses multiple citations", () => {
    const response = `Revenue grew 12% quarter over quarter.

CITATIONS:
- file: "q3-report.md", page: 4, quote: "Total revenue: $142M"
- file: "q4-report.md", page: 2, quote: "Total revenue: $159M, growth of 12%"`;

    const result = parseCitations(response);
    expect(result.citations).toHaveLength(2);
    expect(result.citations[0].file).toBe("q3-report.md");
    expect(result.citations[0].page).toBe(4);
    expect(result.citations[1].file).toBe("q4-report.md");
    expect(result.citations[1].page).toBe(2);
  });

  it("handles case-insensitive CITATIONS marker", () => {
    const response = `Answer here.

citations:
- file: "doc.md", page: 1, quote: "some text"`;

    const result = parseCitations(response);
    expect(result.citations).toHaveLength(1);
  });

  it("handles empty or null input", () => {
    expect(parseCitations("").citations).toEqual([]);
    expect(parseCitations(null as any).citations).toEqual([]);
    expect(parseCitations(undefined as any).citations).toEqual([]);
  });

  it("preserves answer text before CITATIONS block", () => {
    const response = `## Key Findings

Revenue grew 12% QoQ.

### Breakdown
- Product: $100M
- Services: $59M

CITATIONS:
- file: "report.md", page: 1, quote: "Revenue grew 12%"`;

    const result = parseCitations(response);
    expect(result.answer).toContain("## Key Findings");
    expect(result.answer).toContain("Services: $59M");
    expect(result.answer).not.toContain("CITATIONS:");
  });

  it("handles citations with no quotes matched (lenient parse)", () => {
    const response = `Answer.

CITATIONS:
- file: doc.md, page: 5, quote: "test quote"`;

    const result = parseCitations(response);
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].file).toBe("doc.md");
  });
});

// ── matchCitation (unit - no actual files) ──────────────────────────────────

describe("matchCitation", () => {
  it("returns matched: false when JSON file doesn't exist", async () => {
    const citation: RawCitation = {
      file: "nonexistent.md",
      page: 1,
      quote: "some text",
    };
    const result = await matchCitation(citation, "/tmp/nonexistent-dir");
    expect(result.matched).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.boundingBoxes).toEqual([]);
  });
});

// ── Display helpers ─────────────────────────────────────────────────────────

describe("citationStatus", () => {
  it("returns ✅ for high confidence match", () => {
    const c: MatchedCitation = {
      file: "test.md", page: 1, quote: "test",
      matched: true, confidence: 0.95,
      boundingBoxes: [], mergedRect: null,
    };
    expect(citationStatus(c)).toBe("✅");
  });

  it("returns ⚠️ for low confidence match", () => {
    const c: MatchedCitation = {
      file: "test.md", page: 1, quote: "test",
      matched: true, confidence: 0.6,
      boundingBoxes: [], mergedRect: null,
    };
    expect(citationStatus(c)).toBe("⚠️");
  });

  it("returns ❌ for unmatched citation", () => {
    const c: MatchedCitation = {
      file: "test.md", page: 1, quote: "test",
      matched: false, confidence: 0,
      boundingBoxes: [], mergedRect: null,
    };
    expect(citationStatus(c)).toBe("❌");
  });
});

describe("formatCitation", () => {
  it("formats a matched citation with location", () => {
    const c: MatchedCitation = {
      file: "report.md", page: 4, quote: "Revenue: $142M",
      matched: true, confidence: 1.0,
      boundingBoxes: [{ x: 100, y: 200, width: 150, height: 14 }],
      mergedRect: { x: 100, y: 200, width: 150, height: 14 },
    };
    const output = formatCitation(c, 0);
    expect(output).toContain("[1]");
    expect(output).toContain("report.md");
    expect(output).toContain("p.4");
    expect(output).toContain("Revenue: $142M");
    expect(output).toContain("✅");
    expect(output).toContain("matched");
  });

  it("formats an unmatched citation", () => {
    const c: MatchedCitation = {
      file: "doc.md", page: 1, quote: "missing text",
      matched: false, confidence: 0,
      boundingBoxes: [], mergedRect: null,
    };
    const output = formatCitation(c, 2);
    expect(output).toContain("[3]");
    expect(output).toContain("❌");
    expect(output).toContain("not found");
  });
});

describe("citationSummary", () => {
  it("returns empty string for no citations", () => {
    expect(citationSummary([])).toBe("");
  });

  it("summarizes citations correctly", () => {
    const citations: MatchedCitation[] = [
      { file: "a.md", page: 1, quote: "x", matched: true, confidence: 0.95, boundingBoxes: [], mergedRect: null },
      { file: "b.md", page: 2, quote: "y", matched: true, confidence: 0.6, boundingBoxes: [], mergedRect: null },
      { file: "c.md", page: 3, quote: "z", matched: false, confidence: 0, boundingBoxes: [], mergedRect: null },
    ];
    const summary = citationSummary(citations);
    expect(summary).toBe("3 citations (1 verified)");
  });
});

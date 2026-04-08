/**
 * Citation parser and bounding box matcher.
 *
 * Parses structured CITATIONS: blocks from agent responses, then
 * fuzzy-matches quoted text against bounding box JSON data to verify
 * that each citation actually maps to content in the source PDF.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ── Types ───────────────────────────────────────────────────────────────────

export interface RawCitation {
  file: string;
  page: number;
  quote: string;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MatchedCitation extends RawCitation {
  matched: boolean;
  confidence: number;
  boundingBoxes: BoundingBox[];
  mergedRect: BoundingBox | null;
}

export interface ParseResult {
  /** The response text WITHOUT the CITATIONS block */
  answer: string;
  /** Parsed citations */
  citations: RawCitation[];
}

// ── Citation Parser ─────────────────────────────────────────────────────────

/**
 * Parse a CITATIONS: block from the end of an agent response.
 *
 * Expected format:
 * ```
 * CITATIONS:
 * - file: "lease-agreement.md", page: 12, quote: "Lease Start Date: 15 March 2019"
 * - file: "certificate.md", page: 3, quote: "Commencement Date: 15 March 2019"
 * ```
 */
export function parseCitations(agentResponse: string): ParseResult {
  if (!agentResponse || typeof agentResponse !== "string") {
    return { answer: agentResponse ?? "", citations: [] };
  }

  // Find the CITATIONS: marker (case-insensitive)
  const citationMarkerRegex = /\n\s*CITATIONS\s*:\s*\n/i;
  const match = citationMarkerRegex.exec(agentResponse);

  if (!match) {
    return { answer: agentResponse, citations: [] };
  }

  const answer = agentResponse.slice(0, match.index).trimEnd();
  const citationBlock = agentResponse.slice(match.index + match[0].length);

  const citations: RawCitation[] = [];

  // Parse each citation line:
  // - file: "name.md", page: N, quote: "..."
  const lineRegex = /^-\s*file:\s*"([^"]+)"\s*,\s*page:\s*(\d+)\s*,\s*quote:\s*"([^"]*(?:"[^"]*)*?)"\s*$/gm;

  let lineMatch: RegExpExecArray | null;
  while ((lineMatch = lineRegex.exec(citationBlock)) !== null) {
    citations.push({
      file: lineMatch[1],
      page: parseInt(lineMatch[2], 10),
      quote: lineMatch[3],
    });
  }

  // If the structured regex didn't work, try a more lenient parse
  if (citations.length === 0) {
    const lines = citationBlock.split("\n").filter((l) => l.trim().startsWith("-"));
    for (const line of lines) {
      const lenientMatch = line.match(
        /file:\s*"?([^",]+)"?\s*,\s*page:\s*(\d+)\s*,\s*quote:\s*"([^"]+)"/i
      );
      if (lenientMatch) {
        citations.push({
          file: lenientMatch[1].trim(),
          page: parseInt(lenientMatch[2], 10),
          quote: lenientMatch[3],
        });
      }
    }
  }

  return { answer, citations };
}

// ── Text Normalization ──────────────────────────────────────────────────────

/** Normalize text for fuzzy comparison: lowercase, collapse whitespace, strip punctuation edges */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Levenshtein distance between two strings */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Short-circuit for obvious cases
  if (m === 0) return n;
  if (n === 0) return m;
  if (a === b) return 0;

  // Use two-row optimization for memory efficiency
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,     // insertion
        prev[j] + 1,         // deletion
        prev[j - 1] + cost   // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

// ── Bounding Box Matching ───────────────────────────────────────────────────

interface TextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PageData {
  page: number;
  textItems: TextItem[];
}

interface SourceBboxData {
  pages: PageData[];
}

/**
 * Build text runs from individual textItems.
 * Groups items on the same line (y within tolerance), concatenates
 * items within horizontal proximity into runs.
 */
function buildTextRuns(
  items: TextItem[],
  yTolerance = 3,
  xGap = 8
): { text: string; items: TextItem[] }[] {
  if (items.length === 0) return [];

  // Sort by y (top→bottom), then x (left→right)
  const sorted = [...items].sort((a, b) => {
    const dy = a.y - b.y;
    if (Math.abs(dy) > yTolerance) return dy;
    return a.x - b.x;
  });

  const runs: { text: string; items: TextItem[] }[] = [];
  let currentRun: TextItem[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];

    const sameLine = Math.abs(curr.y - prev.y) <= yTolerance;
    const closeEnough = sameLine && (curr.x - (prev.x + prev.width)) <= xGap;

    if (closeEnough) {
      currentRun.push(curr);
    } else {
      // Finalize current run
      runs.push({
        text: currentRun.map((it) => it.text).join(" "),
        items: currentRun,
      });
      currentRun = [curr];
    }
  }

  // Finalize last run
  if (currentRun.length > 0) {
    runs.push({
      text: currentRun.map((it) => it.text).join(" "),
      items: currentRun,
    });
  }

  return runs;
}

/**
 * Merge an array of bounding boxes into a single enclosing rectangle.
 */
function mergeBoxes(boxes: BoundingBox[]): BoundingBox | null {
  if (boxes.length === 0) return null;

  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;

  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/**
 * Try to find the quote text in the page's text runs.
 * Returns matched textItems and confidence score.
 */
function findQuoteInRuns(
  quote: string,
  runs: { text: string; items: TextItem[] }[]
): { items: TextItem[]; confidence: number } | null {
  const normalizedQuote = normalize(quote);
  if (!normalizedQuote) return null;

  // Strategy 1: Exact substring match across concatenated page text
  const fullPageText = runs.map((r) => r.text).join(" ");
  const normalizedPage = normalize(fullPageText);

  const exactIdx = normalizedPage.indexOf(normalizedQuote);
  if (exactIdx !== -1) {
    // Find which runs contribute to this match
    const matchedItems = findItemsForRange(runs, normalizedQuote, exactIdx, normalizedPage);
    return { items: matchedItems, confidence: 1.0 };
  }

  // Strategy 2: Check each run individually for substring match
  for (const run of runs) {
    const normalizedRun = normalize(run.text);
    if (normalizedRun.includes(normalizedQuote)) {
      return { items: run.items, confidence: 0.95 };
    }
  }

  // Strategy 3: Sliding window fuzzy match
  const words = normalizedQuote.split(" ");
  const quoteLen = normalizedQuote.length;
  const maxDistance = Math.max(3, Math.floor(quoteLen * 0.15));

  // Try windows of similar length across the page text
  const pageWords = normalizedPage.split(" ");
  let bestDistance = Infinity;
  let bestStart = -1;
  let bestEnd = -1;

  const windowSize = words.length;
  for (let i = 0; i <= pageWords.length - windowSize; i++) {
    const window = pageWords.slice(i, i + windowSize).join(" ");
    const dist = levenshtein(normalizedQuote, window);
    if (dist < bestDistance) {
      bestDistance = dist;
      bestStart = i;
      bestEnd = i + windowSize;
    }
  }

  // Also try windows of windowSize ± 2
  for (const delta of [-2, -1, 1, 2]) {
    const ws = windowSize + delta;
    if (ws < 1 || ws > pageWords.length) continue;
    for (let i = 0; i <= pageWords.length - ws; i++) {
      const window = pageWords.slice(i, i + ws).join(" ");
      const dist = levenshtein(normalizedQuote, window);
      if (dist < bestDistance) {
        bestDistance = dist;
        bestStart = i;
        bestEnd = i + ws;
      }
    }
  }

  if (bestDistance <= maxDistance && bestStart >= 0) {
    const confidence = Math.max(0, 1 - bestDistance / quoteLen);
    // Find items for the best match window
    const matchedWindow = pageWords.slice(bestStart, bestEnd).join(" ");
    const windowIdx = normalizedPage.indexOf(matchedWindow);
    const matchedItems = windowIdx >= 0
      ? findItemsForRange(runs, matchedWindow, windowIdx, normalizedPage)
      : runs.flatMap((r) => r.items);
    return { items: matchedItems, confidence: Math.max(0.5, confidence) };
  }

  return null;
}

/**
 * Find which textItems contribute to a matched range in the page text.
 */
function findItemsForRange(
  runs: { text: string; items: TextItem[] }[],
  _matchText: string,
  matchStart: number,
  fullNormalizedPage: string
): TextItem[] {
  const matchEnd = matchStart + _matchText.length;
  const matched: TextItem[] = [];

  let charPos = 0;
  for (const run of runs) {
    const runNorm = normalize(run.text);
    const runStart = charPos;
    const runEnd = charPos + runNorm.length;

    // Check if this run overlaps with the match range
    if (runEnd > matchStart && runStart < matchEnd) {
      matched.push(...run.items);
    }

    charPos = runEnd + 1; // +1 for the space between runs
  }

  return matched;
}

/**
 * Match a single citation against bounding box data.
 */
export async function matchCitation(
  citation: RawCitation,
  sourcesDir: string
): Promise<MatchedCitation> {
  const base: MatchedCitation = {
    ...citation,
    matched: false,
    confidence: 0,
    boundingBoxes: [],
    mergedRect: null,
  };

  // Resolve the JSON file for this source
  const jsonName = citation.file.replace(/\.md$/, ".json");
  const jsonPath = join(sourcesDir, jsonName);

  if (!existsSync(jsonPath)) {
    return base; // No bbox data for this source
  }

  try {
    const raw = await readFile(jsonPath, "utf-8");
    const data = JSON.parse(raw) as SourceBboxData;

    if (!data.pages || !Array.isArray(data.pages)) {
      return base;
    }

    // Find the page
    const pageData = data.pages.find((p) => p.page === citation.page);
    if (!pageData || !pageData.textItems || pageData.textItems.length === 0) {
      return base;
    }

    // Build text runs from the page's textItems
    const runs = buildTextRuns(pageData.textItems);

    // Try to find the quote
    const result = findQuoteInRuns(citation.quote, runs);
    if (!result) {
      return base;
    }

    const boxes: BoundingBox[] = result.items.map((it) => ({
      x: it.x,
      y: it.y,
      width: it.width,
      height: it.height,
    }));

    return {
      ...citation,
      matched: true,
      confidence: result.confidence,
      boundingBoxes: boxes,
      mergedRect: mergeBoxes(boxes),
    };
  } catch {
    return base; // JSON parse error or file read error
  }
}

/**
 * Match all citations against bounding box data.
 */
export async function matchAllCitations(
  citations: RawCitation[],
  sourcesDir: string
): Promise<MatchedCitation[]> {
  return Promise.all(citations.map((c) => matchCitation(c, sourcesDir)));
}

// ── Display Helpers ─────────────────────────────────────────────────────────

/** Get a status emoji for a matched citation */
export function citationStatus(c: MatchedCitation): string {
  if (!c.matched) return "❌";
  if (c.confidence >= 0.8) return "✅";
  return "⚠️";
}

/** Format a citation for terminal display */
export function formatCitation(c: MatchedCitation, index: number): string {
  const status = citationStatus(c);
  const location = c.mergedRect
    ? ` (${Math.round(c.mergedRect.x)},${Math.round(c.mergedRect.y)} → ${Math.round(c.mergedRect.x + c.mergedRect.width)},${Math.round(c.mergedRect.y + c.mergedRect.height)})`
    : "";
  const conf = c.matched && c.confidence < 1.0
    ? ` (confidence: ${c.confidence.toFixed(2)})`
    : "";

  const statusLabel = !c.matched
    ? "not found in bbox data"
    : c.confidence >= 0.8
      ? `matched${location}`
      : `approximate${conf}`;

  return [
    `  [${index + 1}] 📄 ${c.file}, p.${c.page}`,
    `      "${c.quote}"`,
    `      ${status} ${statusLabel}`,
  ].join("\n");
}

/** Build a summary line for citations (for completion stats) */
export function citationSummary(citations: MatchedCitation[]): string {
  if (citations.length === 0) return "";
  const verified = citations.filter((c) => c.matched && c.confidence >= 0.8).length;
  return `${citations.length} citations (${verified} verified)`;
}

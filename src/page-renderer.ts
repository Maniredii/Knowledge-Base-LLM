import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type BoundingBox } from "./citations.js";

/**
 * Fallback page renderer when `pdfjs-dist` or `canvas` are not available.
 * Creates an SVG representing the coordinates and converts to PNG via sharp,
 * or simply saves the SVG.
 */
export async function renderHighlightedPage(
  pdfPath: string,
  pageNum: number,
  highlights: BoundingBox[],
  outputPath: string
): Promise<void> {
  let sharp;
  try {
    sharp = (await import("sharp")).default;
  } catch (err) {
    console.warn("Sharp is not installed, skipping image generation.");
    return;
  }

  // Define a standard page size
  const PAGE_WIDTH = 595; // A4 pt
  const PAGE_HEIGHT = 842; // A4 pt

  // Create SVG string
  let svg = `<svg width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect width="100%" height="100%" fill="white" />`;
  svg += `<text x="20" y="40" font-family="Arial" font-size="16" fill="black">File: ${pdfPath}</text>`;
  svg += `<text x="20" y="70" font-family="Arial" font-size="16" fill="black">Page: ${pageNum}</text>`;

  // Draw highlights
  for (const box of highlights) {
    svg += `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="yellow" fill-opacity="0.4" stroke="orange" stroke-width="2" />`;
    // Add coordinate label
    svg += `<text x="${box.x}" y="${box.y - 5}" font-family="Arial" font-size="10" fill="gray">(${box.x.toFixed(0)}, ${box.y.toFixed(0)})</text>`;
  }
  svg += `</svg>`;

  try {
    await sharp(Buffer.from(svg)).png().toFile(outputPath);
  } catch (e: any) {
    console.error(`Failed to rasterize PNG: ${e.message}`);
  }
}

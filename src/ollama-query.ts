/**
 * Ollama-based query handler for local inference.
 *
 * Replaces the Pi SDK agent session with a direct Ollama chat flow:
 * reads sources from disk, builds a context prompt, and streams
 * the answer via the local Ollama server.
 */

import { ollamaComplete, ollamaStream, type OllamaMessage, type OllamaOptions } from "./ollama.js";
import { readdir, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import chalk from "chalk";
import { MarkdownStream } from "./md-stream.js";
import { parseCitations, matchAllCitations, citationStatus, formatCitation, citationSummary } from "./citations.js";
import type { MatchedCitation } from "./citations.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface OllamaQueryOptions {
  ollamaModel: string;
  ollamaHost: string;
  save?: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function loadSources(folder: string): Promise<{ name: string; content: string }[]> {
  const sourcesDir = join(folder, ".llm-kb", "wiki", "sources");
  if (!existsSync(sourcesDir)) return [];

  const files = await readdir(sourcesDir);
  const mdFiles = files.filter((f) => f.endsWith(".md"));
  const sources: { name: string; content: string }[] = [];

  for (const file of mdFiles) {
    try {
      const content = await readFile(join(sourcesDir, file), "utf-8");
      sources.push({ name: file, content });
    } catch {}
  }

  return sources;
}

async function loadWiki(folder: string): Promise<string> {
  const wikiPath = join(folder, ".llm-kb", "wiki", "wiki.md");
  if (!existsSync(wikiPath)) return "";
  return readFile(wikiPath, "utf-8").catch(() => "");
}

async function loadIndex(folder: string): Promise<string> {
  const indexPath = join(folder, ".llm-kb", "wiki", "index.md");
  if (!existsSync(indexPath)) return "";
  return readFile(indexPath, "utf-8").catch(() => "");
}

function buildSystemPrompt(
  index: string,
  wiki: string,
  sourceNames: string[]
): string {
  const sourceList = sourceNames.map((f) => `  - ${f}`).join("\n");

  const wikiSection = wiki
    ? `## Knowledge Wiki (check this first)\n\nThe wiki below contains knowledge already extracted from sources.\nIf the user's question is covered here, answer directly — no need to re-read.\nAlways cite the original source files mentioned in the wiki.\n\n${wiki}\n\n---\n\n`
    : "";

  return `# llm-kb Knowledge Base — Local Query Mode

You are a knowledgeable assistant answering questions about a document collection.

${wikiSection}## Source Index
${index || "No index available yet."}

## Available sources
${sourceList}

## Rules
- Answer based ONLY on the provided source content — don't hallucinate
- Cite sources with filename and page number: (filename, p.X)
- If you can't find the answer in the sources, say so clearly
- Use markdown formatting for structured answers
- Be concise but thorough
- For comparisons, use tables when appropriate

## Citation Format

After your answer, include a CITATIONS block listing every source used:

CITATIONS:
- file: "lease-agreement.md", page: 12, quote: "Lease Start Date: 15 March 2019"
- file: "certificate.md", page: 3, quote: "Commencement Date: 15 March 2019"

Rules for citations:
- The quote MUST be the EXACT text from the source, not paraphrased
- Include the page number where you read it
- Every factual claim in your answer must have at least one citation
- If answering from wiki, cite the original sources listed in the wiki entry`;
}

// ── Interactive chat (TUI mode for `llm-kb run --local`) ────────────────────

export async function createOllamaChat(
  folder: string,
  options: OllamaQueryOptions
) {
  const sources = await loadSources(folder);
  const wiki = await loadWiki(folder);
  const index = await loadIndex(folder);

  if (sources.length === 0 && !wiki && !index) {
    throw new Error("No sources found. Run 'llm-kb run <folder>' first to parse documents.");
  }

  const sourceNames = sources.map((s) => s.name);
  const systemPrompt = buildSystemPrompt(index, wiki, sourceNames);

  // Build source context (truncate very large sources)
  const MAX_SOURCE_CHARS = 8000;
  const sourceContext = sources
    .map((s) => `### ${s.name}\n${s.content.slice(0, MAX_SOURCE_CHARS)}`)
    .join("\n\n---\n\n");

  const history: OllamaMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Here are the source documents for reference:\n\n${sourceContext}` },
    { role: "assistant", content: "I've reviewed the source documents. I'm ready to answer your questions about them. What would you like to know?" },
  ];

  const ollamaOpts: OllamaOptions = {
    model: options.ollamaModel,
    baseUrl: options.ollamaHost,
    timeoutMs: 180_000,
  };

  const dim = (s: string) => process.stdout.isTTY ? chalk.dim(s) : s;
  const md = new MarkdownStream(process.stdout.isTTY ?? false);

  const sourcesDir = join(folder, ".llm-kb", "wiki", "sources");

  return {
    async prompt(question: string): Promise<MatchedCitation[]> {
      history.push({ role: "user", content: question });

      const startTime = Date.now();
      process.stdout.write(dim(`\n⟡ ${options.ollamaModel} (local)`) + "\n");
      process.stdout.write(dim("─".repeat(process.stdout.columns || 80)) + "\n\n");

      let fullAnswer = "";
      const stream = new MarkdownStream(process.stdout.isTTY ?? false);

      try {
        for await (const chunk of ollamaStream(history, ollamaOpts)) {
          if (chunk.type === "delta") {
            fullAnswer += chunk.content;
            process.stdout.write(stream.push(chunk.content));
          }
          if (chunk.type === "done") {
            process.stdout.write(stream.end());
          }
        }
      } catch (err: any) {
        process.stdout.write(stream.end());
        console.error(chalk.red(`\n  Ollama error: ${err.message}`));
      }

      // Parse and match citations
      let matchedCitations: MatchedCitation[] = [];
      if (fullAnswer) {
        const { answer, citations } = parseCitations(fullAnswer);

        if (citations.length > 0) {
          matchedCitations = await matchAllCitations(citations, sourcesDir);

          // Display citation results
          process.stdout.write(dim("\n── Citations " + "─".repeat(Math.max(0, (process.stdout.columns || 80) - 15))) + "\n\n");
          for (let i = 0; i < matchedCitations.length; i++) {
            process.stdout.write(formatCitation(matchedCitations[i], i) + "\n\n");
          }
        }

        // Show completion stats with citation info
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const cols = process.stdout.columns || 80;
        const citationInfo = matchedCitations.length > 0 ? ` · ${citationSummary(matchedCitations)}` : "";
        const stats = `${elapsed}s · ${sources.length} sources · local${citationInfo}`;
        const pad = Math.max(0, cols - stats.length - 4);
        process.stdout.write(`\n${dim("── " + stats + " " + "─".repeat(pad))}\n`);

        // Store clean answer (without CITATIONS block) in history
        history.push({ role: "assistant", content: answer });
      } else {
        history.push({ role: "assistant", content: fullAnswer });
      }

      // Save answer if in save mode
      if (options.save && fullAnswer) {
        await saveAnswer(folder, question, fullAnswer);
      }

      return matchedCitations;
    },

    dispose() {
      // No cleanup needed for Ollama
    },
  };
}

// ── One-shot query (for `llm-kb query --local`) ─────────────────────────────

export async function ollamaQuery(
  folder: string,
  question: string,
  options: OllamaQueryOptions
): Promise<void> {
  const chat = await createOllamaChat(folder, options);
  await chat.prompt(question);
  chat.dispose();
}

// ── Save helper ─────────────────────────────────────────────────────────────

async function saveAnswer(folder: string, question: string, answer: string): Promise<void> {
  const outputsDir = join(folder, ".llm-kb", "wiki", "outputs");
  await mkdir(outputsDir, { recursive: true });

  const slug = question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

  const filename = `${slug}-${Date.now()}.md`;
  const content = `# ${question}\n\n*Generated locally via Ollama · ${new Date().toISOString().slice(0, 10)}*\n\n---\n\n${answer}\n`;

  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(outputsDir, filename), content, "utf-8");
  console.log(chalk.green(`\n  Saved: .llm-kb/wiki/outputs/${filename}`));
}

// ── Ollama-based wiki update ────────────────────────────────────────────────

export async function updateWikiWithOllama(
  kbRoot: string,
  question: string,
  answer: string,
  ollamaOpts: OllamaOptions
): Promise<void> {
  const wikiDir = join(kbRoot, ".llm-kb", "wiki");
  await mkdir(wikiDir, { recursive: true });
  const wikiPath = join(wikiDir, "wiki.md");

  const currentWiki = existsSync(wikiPath)
    ? await readFile(wikiPath, "utf-8").catch(() => "")
    : "";

  const date = new Date().toISOString().slice(0, 10);

  const prompt = currentWiki.trim()
    ? `You are maintaining a concept-organized knowledge wiki.

## Current wiki
${currentWiki}

## New Q&A to integrate
**Question:** ${question}
**Date:** ${date}

**Answer:**
${answer}

---

Update the wiki to integrate this new knowledge.
- Use ## for CONCEPTS and TOPICS — NOT source file names
- Be concise: bullet points for lists, short prose for explanations
- Include source citations inline
- Separate ## sections with: ---

Return ONLY the complete updated wiki markdown. No explanation.`
    : `Create a concept-organized knowledge wiki from this Q&A.

**Question:** ${question}
**Date:** ${date}

**Answer:**
${answer}

---

- Start with: # Knowledge Wiki
- Use ## for CONCEPTS and TOPICS
- Be concise
- Include inline citations

Return ONLY the wiki markdown. No explanation.`;

  try {
    const result = await ollamaComplete(
      [
        { role: "system", content: "You are a precise knowledge librarian. Return only clean markdown." },
        { role: "user", content: prompt },
      ],
      ollamaOpts
    );

    if (result.content.trim()) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(wikiPath, result.content.trim() + "\n", "utf-8");
    }
  } catch {
    // Wiki update failure is non-fatal
  }
}

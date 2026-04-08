import {
  TUI, Container, Spacer, Text, Markdown, ProcessTerminal,
  type MarkdownTheme, type Component, Input,
} from "@mariozechner/pi-tui";
import chalk from "chalk";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { citationStatus, formatCitation, citationSummary, type MatchedCitation } from "./citations.js";
import { renderHighlightedPage } from "./page-renderer.js";

// ── Markdown theme ──────────────────────────────────────────────────────────

function createMarkdownTheme(): MarkdownTheme {
  return {
    heading:         (t) => chalk.bold(t),
    link:            (t) => chalk.cyan(t),
    linkUrl:         (t) => chalk.dim(t),
    code:            (t) => chalk.cyan(t),
    codeBlock:       (t) => chalk.dim(t),
    codeBlockBorder: (t) => chalk.dim(t),
    quote:           (t) => chalk.italic(t),
    quoteBorder:     (t) => chalk.dim(t),
    hr:              (t) => chalk.dim(t),
    listBullet:      (t) => chalk.dim(t),
    bold:            (t) => chalk.bold(t),
    italic:          (t) => chalk.italic(t),
    underline:       (t) => chalk.underline(t),
    strikethrough:   (t) => chalk.strikethrough(t),
  };
}

const mdTheme = createMarkdownTheme();

// ── Helper components ───────────────────────────────────────────────────────

function dimText(text: string, px = 1, py = 0): Text {
  return new Text(chalk.dim(text), px, py);
}

class HRule implements Component {
  private colorFn: (s: string) => string;
  constructor(colorFn?: (s: string) => string) {
    this.colorFn = colorFn ?? chalk.dim;
  }
  invalidate() {}
  render(width: number): string[] {
    return [this.colorFn("\u2500".repeat(width))];
  }
}

// ── Chat display ────────────────────────────────────────────────────────────
//
// All components are appended sequentially to currentResponse in the order
// events arrive. This naturally handles interleaved thinking/tools/text:
//
//   ⟡ model
//   ▸ Thinking: reasoning...
//   Let me read the file...              ← 1st Markdown block
//   ▸ Reading  file.md                   ← tool call (between text blocks)
//   ──────────────────────
//   Based on the document...             ← 2nd Markdown block
//   ▸ Thinking: let me check another...
//   ▸ Reading  file2.md
//   ──────────────────────
//   The final answer is...               ← 3rd Markdown block
//   ── 12.3s · 2 files read ──────

export class ChatDisplay {
  private tui: TUI;
  private terminal: ProcessTerminal;
  private messageArea: Container;
  private inputArea: Container;
  private input: Input;

  // Current response (reset per prompt)
  private currentResponse: Container | null = null;
  private currentMd: Markdown | null = null;       // active text block
  private currentThinking: Text | null = null;      // active thinking block
  private hadSeparator = false;                     // has a ─── line been drawn?

  private filesReadCount = 0;
  private shownToolCalls = new Set<string>();
  private startTime = Date.now();
  private latestCitations: MatchedCitation[] = [];

  onSubmit?: (text: string) => void;
  onExit?: () => void;

  constructor(private readonly kbRoot: string = process.cwd()) {
    this.terminal = new ProcessTerminal();
    this.tui = new TUI(this.terminal);

    this.messageArea = new Container();
    this.tui.addChild(this.messageArea);

    this.inputArea = new Container();
    this.inputArea.addChild(new HRule((s) => chalk.hex("#c678dd")(s)));

    this.input = new Input();
    this.input.onSubmit = async (text) => {
      const trimmed = text.trim();
      if (!trimmed) {
        this.input.setValue("");
        return;
      }

      // Handle TUI commands
      if (trimmed.startsWith("/cite ")) {
        this.input.setValue("");
        await this.handleCiteCommand(trimmed);
        return;
      }

      if (this.onSubmit) {
        this.addUserMessage(trimmed);
        this.onSubmit(trimmed);
      }
      this.input.setValue("");
    };
    this.inputArea.addChild(this.input);
    this.inputArea.addChild(new HRule((s) => chalk.hex("#c678dd")(s)));

    this.tui.addChild(this.inputArea);
    this.tui.setFocus(this.input);
  }

  start(): void {
    this.tui.start();

    this.tui.addInputListener((data) => {
      if (data === "\x03" || data === "\x04") {
        this.stop();
        if (this.onExit) this.onExit();
        else process.exit(0);
        return { consume: true };
      }
      return undefined;
    });

    this.tui.requestRender();
  }

  stop(): void {
    this.tui.stop();
  }

  addUserMessage(text: string): void {
    this.messageArea.addChild(new Spacer(1));
    this.messageArea.addChild(new Text(chalk.bold(text), 1, 0));
    this.tui.requestRender();
  }

  // ── Per-prompt lifecycle (events arrive in any order) ───────────────────

  beginResponse(modelName: string): void {
    this.filesReadCount = 0;
    this.shownToolCalls = new Set();
    this.startTime = Date.now();
    this.currentMd = null;
    this.currentThinking = null;
    this.hadSeparator = false;
    this.latestCitations = [];

    this.currentResponse = new Container();
    this.currentResponse.addChild(new Spacer(1));
    this.currentResponse.addChild(dimText(`\u27e1 ${modelName}`));
    this.messageArea.addChild(this.currentResponse);
    this.tui.requestRender();
  }

  /** Start or continue a thinking block. Closes any active text block. */
  appendThinking(text: string): void {
    if (!this.currentResponse) return;

    // Close active text block — thinking interrupts it
    this.currentMd = null;

    if (!this.currentThinking) {
      this.currentResponse.addChild(new Spacer(1));
      this.currentResponse.addChild(dimText("\u25b8 Thinking"));
      this.currentThinking = new Text(chalk.dim(chalk.italic(text)), 2, 0);
      this.currentResponse.addChild(this.currentThinking);
    } else {
      const prev = (this.currentThinking as any).text ?? "";
      this.currentThinking.setText(
        chalk.dim(chalk.italic(prev.replace(/\x1b\[[0-9;]*m/g, "") + text))
      );
    }
    this.tui.requestRender();
  }

  /** End the current thinking block */
  endThinking(): void {
    this.currentThinking = null;
  }

  /** Add a tool call line. Closes active text block. */
  addToolCall(toolCallId: string, label: string, toolName: string): void {
    if (!this.currentResponse || this.shownToolCalls.has(toolCallId)) return;
    this.shownToolCalls.add(toolCallId);
    if (toolName === "read") this.filesReadCount++;

    // Close active text block — tool call interrupts it
    this.currentMd = null;

    this.currentResponse.addChild(dimText(`  \u25b8 ${label}`));
    this.tui.requestRender();
  }

  /** Show code block (e.g. bash script the agent wrote) */
  addCodeBlock(code: string): void {
    if (!this.currentResponse) return;
    this.currentMd = null;
    // Use Markdown component to render the code block with proper formatting
    this.currentResponse.addChild(new Markdown("```javascript\n" + code + "\n```", 2, 0, mdTheme));
    this.tui.requestRender();
  }

  /** Show tool execution result (success/error) */
  addToolResult(toolCallId: string, isError: boolean): void {
    if (!this.currentResponse) return;
    if (isError) {
      this.currentResponse.addChild(new Text(chalk.red("    \u2717 failed"), 0, 0));
      this.tui.requestRender();
    }
  }

  /** Start a NEW text block with a separator (if not the first). */
  beginAnswer(): void {
    if (!this.currentResponse) return;

    // Close previous thinking
    this.currentThinking = null;

    // Add separator line before answer text
    this.currentResponse.addChild(new Spacer(1));
    this.currentResponse.addChild(new HRule());
    this.currentResponse.addChild(new Spacer(1));
    this.hadSeparator = true;

    // Create a new Markdown block for this text segment
    this.currentMd = new Markdown("", 1, 0, mdTheme);
    this.currentResponse.addChild(this.currentMd);
    this.tui.requestRender();
  }

  /** Append text to the active Markdown block (creates one if needed) */
  appendAnswer(text: string): void {
    if (!this.currentResponse) return;

    if (!this.currentMd) {
      // No active text block — create one (with separator if this is the first)
      if (!this.hadSeparator) {
        this.currentResponse.addChild(new Spacer(1));
        this.currentResponse.addChild(new HRule());
        this.currentResponse.addChild(new Spacer(1));
        this.hadSeparator = true;
      }
      this.currentMd = new Markdown("", 1, 0, mdTheme);
      this.currentResponse.addChild(this.currentMd);
    }

    const prev = (this.currentMd as any).text ?? "";
    this.currentMd.setText(prev + text);
    this.tui.requestRender();
  }

  /** Display matched citations with verification status */
  showCitations(citations: MatchedCitation[]): void {
    this.latestCitations = citations;
    if (!this.currentResponse || citations.length === 0) return;

    // Citation header
    this.currentResponse.addChild(new Spacer(1));
    const citHeader: Component = {
      invalidate() {},
      render(width: number) {
        const label = "── Citations ";
        const pad = Math.max(0, width - label.length);
        return [chalk.dim(label + "─".repeat(pad))];
      },
    };
    this.currentResponse.addChild(citHeader);
    this.currentResponse.addChild(new Spacer(1));

    // Each citation
    for (let i = 0; i < citations.length; i++) {
      const c = citations[i];
      const status = citationStatus(c);
      const statusLabel = !c.matched
        ? "not found in bbox data"
        : c.confidence >= 0.8
          ? "matched"
          : `approximate (confidence: ${c.confidence.toFixed(2)})`;

      this.currentResponse.addChild(
        new Text(`  [${i + 1}] 📄 ${chalk.cyan(c.file)}, p.${c.page}`, 0, 0)
      );
      this.currentResponse.addChild(
        new Text(chalk.dim(`      "${c.quote}"`), 0, 0)
      );
      this.currentResponse.addChild(
        new Text(`      ${status} ${chalk.dim(statusLabel)}`, 0, 0)
      );
    }

    // Summary line
    const summary = citationSummary(citations);
    if (summary) {
      this.currentResponse.addChild(new Spacer(1));
      this.currentResponse.addChild(new Text(chalk.dim(`  ${summary}`), 0, 0));
    }

    this.tui.requestRender();
  }

  showCompletion(): void {
    if (!this.currentResponse) return;
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const source = this.filesReadCount > 0
      ? `${this.filesReadCount} file${this.filesReadCount !== 1 ? "s" : ""} read`
      : "wiki";
    const stats = `\u2500\u2500 ${elapsed}s \u00b7 ${source} `;

    const completion: Component = {
      invalidate() {},
      render(width: number) {
        const pad = Math.max(0, width - stats.length);
        return [chalk.dim(stats + "\u2500".repeat(pad))];
      },
    };

    this.currentResponse.addChild(new Spacer(1));
    this.currentResponse.addChild(completion);
    this.currentResponse = null;
    this.currentMd = null;
    this.currentThinking = null;
    this.tui.requestRender();
  }

  enableInput(): void {
    this.tui.setFocus(this.input);
    this.tui.requestRender();
  }

  disableInput(): void {
    this.tui.setFocus(null);
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  private async handleCiteCommand(cmd: string) {
    const numMatch = cmd.match(/\/cite\s+(\d+)/);
    if (!numMatch) {
      this.addUserMessage(chalk.red("Usage: /cite <number>"));
      return;
    }
    const idx = parseInt(numMatch[1], 10) - 1;
    if (idx < 0 || idx >= this.latestCitations.length) {
      this.addUserMessage(chalk.red(`Invalid citation number. Pick between 1 and ${this.latestCitations.length}.`));
      return;
    }

    const citation = this.latestCitations[idx];
    this.addUserMessage(chalk.cyan(`Opening citation [${idx + 1}] (${citation.file}, p.${citation.page})...`));

    try {
      const open = (await import("open")).default;
      const outDir = join(this.kbRoot, ".llm-kb", "highlights");
      await mkdir(outDir, { recursive: true });

      const safeName = citation.file.replace(/\.md$/, "");
      const outPath = join(outDir, `${safeName}-p${citation.page}.png`);

      await renderHighlightedPage(
        citation.file,
        citation.page,
        citation.boundingBoxes,
        outPath
      );

      await open(outPath);
      this.messageArea.addChild(new Spacer(1));
      this.messageArea.addChild(new Text(chalk.dim(`  Opened ${outPath}`), 0, 0));
      this.tui.requestRender();
    } catch (err: any) {
      this.messageArea.addChild(new Spacer(1));
      this.messageArea.addChild(new Text(chalk.red(`  Error opening citation: ${err.message}`), 0, 0));
      this.tui.requestRender();
    }
  }
}

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock fs ─────────────────────────────────────────────────────────────────

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: vi.fn() };
});

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    readdir: vi.fn(),
    readFile: vi.fn(),
    mkdir: vi.fn(),
    writeFile: vi.fn(),
  };
});

// ── Mock ollama client ──────────────────────────────────────────────────────

vi.mock("../src/ollama.js", () => ({
  ollamaComplete: vi.fn(),
  ollamaStream: vi.fn(),
}));

// ── Mock citations ──────────────────────────────────────────────────────────

vi.mock("../src/citations.js", async () => {
  const actual = await vi.importActual<typeof import("../src/citations.js")>("../src/citations.js");
  return {
    ...actual,
    matchAllCitations: vi.fn().mockResolvedValue([]),
  };
});

// ── Mock md-stream (class-based) ────────────────────────────────────────────

vi.mock("../src/md-stream.js", () => ({
  MarkdownStream: class {
    push(s: string) { return s; }
    end() { return ""; }
  },
}));

// ── Mock chalk (for non-TTY tests) ──────────────────────────────────────────

vi.mock("chalk", () => {
  const passthrough = (s: string) => s;
  const handler: ProxyHandler<any> = {
    get(_target, _prop) {
      return new Proxy(passthrough, handler);
    },
    apply(_target, _this, args) {
      return args[0];
    },
  };
  return { default: new Proxy(passthrough, handler) };
});

import { existsSync } from "node:fs";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { ollamaComplete, ollamaStream } from "../src/ollama.js";
import { matchAllCitations } from "../src/citations.js";
import { updateWikiWithOllama, createOllamaChat } from "../src/ollama-query.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReaddir = vi.mocked(readdir);
const mockReadFile = vi.mocked(readFile);
const mockMkdir = vi.mocked(mkdir);
const mockWriteFile = vi.mocked(writeFile);
const mockOllamaComplete = vi.mocked(ollamaComplete);
const mockOllamaStream = vi.mocked(ollamaStream);
const mockMatchAllCitations = vi.mocked(matchAllCitations);

// Suppress stdout during tests
const origWrite = process.stdout.write;
const origIsTTY = process.stdout.isTTY;
const origColumns = process.stdout.columns;

beforeEach(() => {
  process.stdout.write = vi.fn().mockReturnValue(true) as any;
  (process.stdout as any).isTTY = false;
  (process.stdout as any).columns = 80;
  vi.clearAllMocks();
});

afterEach(() => {
  process.stdout.write = origWrite;
  (process.stdout as any).isTTY = origIsTTY;
  (process.stdout as any).columns = origColumns;
});

// ── Helper: set up mock filesystem with sources ─────────────────────────────

function setupSources(sources: { name: string; content: string }[] = [{ name: "doc.md", content: "Test content" }]) {
  mockExistsSync.mockImplementation((p: any) => {
    const path = String(p);
    if (path.includes("sources")) return sources.length > 0;
    if (path.includes("wiki.md")) return true;
    if (path.includes("index.md")) return false;
    return false;
  });

  mockReaddir.mockResolvedValue(sources.map((s) => s.name) as any);
  mockReadFile.mockImplementation(async (p: any) => {
    const path = String(p);
    for (const s of sources) {
      if (path.endsWith(s.name)) return s.content;
    }
    if (path.includes("wiki.md")) return "# Wiki\nSome wiki content";
    return "";
  });
}

// ── createOllamaChat ────────────────────────────────────────────────────────

describe("createOllamaChat", () => {
  const folder = "/test/kb";

  it("throws when no sources found", async () => {
    mockExistsSync.mockReturnValue(false);

    await expect(
      createOllamaChat(folder, { ollamaModel: "llama3", ollamaHost: "http://localhost:11434" })
    ).rejects.toThrow(/No sources found/);
  });

  it("creates a chat with prompt and dispose methods", async () => {
    setupSources();

    async function* fakeStream(): AsyncGenerator<any> {
      yield { type: "delta", content: "The answer is 42." };
      yield { type: "done", model: "llama3", durationMs: 1000 };
    }
    mockOllamaStream.mockReturnValue(fakeStream() as any);

    const chat = await createOllamaChat(folder, {
      ollamaModel: "llama3",
      ollamaHost: "http://localhost:11434",
    });

    expect(chat).toHaveProperty("prompt");
    expect(chat).toHaveProperty("dispose");
    expect(typeof chat.prompt).toBe("function");

    const citations = await chat.prompt("What is the answer?");
    expect(Array.isArray(citations)).toBe(true);
    expect(citations.length).toBe(0); // no CITATIONS block in response

    // ollamaStream was called with system + source context + assistant ack + user question
    expect(mockOllamaStream).toHaveBeenCalledOnce();
    const messages = mockOllamaStream.mock.calls[0][0];
    expect(messages[0].role).toBe("system");
    const userMsg = messages.find((m: any) => m.role === "user" && m.content === "What is the answer?");
    expect(userMsg).toBeDefined();
  });

  it("system prompt includes citation format instructions", async () => {
    setupSources();

    async function* fakeStream(): AsyncGenerator<any> {
      yield { type: "delta", content: "Answer" };
      yield { type: "done", model: "llama3", durationMs: 100 };
    }
    mockOllamaStream.mockReturnValue(fakeStream() as any);

    const chat = await createOllamaChat(folder, {
      ollamaModel: "llama3",
      ollamaHost: "http://localhost:11434",
    });

    await chat.prompt("test");

    const systemMsg = mockOllamaStream.mock.calls[0][0][0];
    expect(systemMsg.role).toBe("system");
    expect(systemMsg.content).toContain("CITATIONS:");
    expect(systemMsg.content).toContain("Citation Format");
    expect(systemMsg.content).toContain("quote MUST be the EXACT text");
  });

  it("parses citations from response and matches against bbox data", async () => {
    setupSources();

    const answerWithCitations = `The lease starts on March 15.

CITATIONS:
- file: "doc.md", page: 1, quote: "Lease Start Date: 15 March"`;

    async function* fakeStream(): AsyncGenerator<any> {
      yield { type: "delta", content: answerWithCitations };
      yield { type: "done", model: "llama3", durationMs: 500 };
    }
    mockOllamaStream.mockReturnValue(fakeStream() as any);

    mockMatchAllCitations.mockResolvedValue([
      {
        file: "doc.md",
        page: 1,
        quote: "Lease Start Date: 15 March",
        matched: true,
        confidence: 0.95,
        boundingBoxes: [],
        mergedRect: null,
      },
    ]);

    const chat = await createOllamaChat(folder, {
      ollamaModel: "llama3",
      ollamaHost: "http://localhost:11434",
    });

    const citations = await chat.prompt("When does the lease start?");
    expect(citations).toHaveLength(1);
    expect(citations[0].matched).toBe(true);
    expect(citations[0].confidence).toBe(0.95);

    // matchAllCitations was called with the parsed raw citations
    expect(mockMatchAllCitations).toHaveBeenCalledOnce();
    const [rawCitations] = mockMatchAllCitations.mock.calls[0];
    expect(rawCitations).toHaveLength(1);
    expect(rawCitations[0].file).toBe("doc.md");
  });

  it("handles stream errors gracefully", async () => {
    setupSources();

    async function* fakeStream(): AsyncGenerator<any> {
      yield { type: "delta", content: "Partial..." };
      throw new Error("Connection reset");
    }
    mockOllamaStream.mockReturnValue(fakeStream() as any);

    const chat = await createOllamaChat(folder, {
      ollamaModel: "llama3",
      ollamaHost: "http://localhost:11434",
    });

    // Should not throw — errors are caught internally
    const citations = await chat.prompt("Test question");
    expect(Array.isArray(citations)).toBe(true);
  });

  it("saves answer when save option is true", async () => {
    setupSources();
    mockMkdir.mockResolvedValue(undefined as any);
    mockWriteFile.mockResolvedValue(undefined);

    async function* fakeStream(): AsyncGenerator<any> {
      yield { type: "delta", content: "Saved answer content." };
      yield { type: "done", model: "llama3", durationMs: 100 };
    }
    mockOllamaStream.mockReturnValue(fakeStream() as any);

    const chat = await createOllamaChat(folder, {
      ollamaModel: "llama3",
      ollamaHost: "http://localhost:11434",
      save: true,
    });

    await chat.prompt("Save this");
    expect(mockMkdir).toHaveBeenCalled();
  });

  it("stores clean answer (without CITATIONS block) in chat history", async () => {
    setupSources();

    const fullResponse = `The answer is yes.

CITATIONS:
- file: "doc.md", page: 1, quote: "yes it is"`;

    async function* fakeStream1(): AsyncGenerator<any> {
      yield { type: "delta", content: fullResponse };
      yield { type: "done", model: "llama3", durationMs: 100 };
    }
    async function* fakeStream2(): AsyncGenerator<any> {
      yield { type: "delta", content: "Follow-up answer." };
      yield { type: "done", model: "llama3", durationMs: 100 };
    }

    mockOllamaStream
      .mockReturnValueOnce(fakeStream1() as any)
      .mockReturnValueOnce(fakeStream2() as any);

    mockMatchAllCitations.mockResolvedValue([]);

    const chat = await createOllamaChat(folder, {
      ollamaModel: "llama3",
      ollamaHost: "http://localhost:11434",
    });

    await chat.prompt("First question");
    await chat.prompt("Second question");

    // Second call should have history without CITATIONS block
    const secondCallMessages = mockOllamaStream.mock.calls[1][0];
    const assistantMsg = secondCallMessages.find(
      (m: any) => m.role === "assistant" && m.content.includes("The answer")
    );
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).not.toContain("CITATIONS:");
    expect(assistantMsg!.content).toBe("The answer is yes.");
  });
});

// ── updateWikiWithOllama ────────────────────────────────────────────────────

describe("updateWikiWithOllama", () => {
  it("creates wiki from scratch when no existing wiki", async () => {
    mockExistsSync.mockReturnValue(false);
    mockMkdir.mockResolvedValue(undefined as any);
    mockWriteFile.mockResolvedValue(undefined);

    mockOllamaComplete.mockResolvedValue({
      content: "# Knowledge Wiki\n\n## Topic\n- Fact 1",
      model: "llama3",
      durationMs: 2000,
    });

    await updateWikiWithOllama(
      "/test/kb",
      "What is X?",
      "X is a thing.",
      { model: "llama3" }
    );

    expect(mockOllamaComplete).toHaveBeenCalledOnce();
    expect(mockWriteFile).toHaveBeenCalled();

    // Check the system prompt asks for a wiki
    const callArgs = mockOllamaComplete.mock.calls[0][0];
    expect(callArgs[0].role).toBe("system");
    expect(callArgs[1].content).toContain("Create a concept-organized");
  });

  it("updates existing wiki content", async () => {
    const existingWiki = "# Knowledge Wiki\n\n## Old Topic\n- Old fact";

    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(existingWiki);
    mockMkdir.mockResolvedValue(undefined as any);
    mockWriteFile.mockResolvedValue(undefined);

    mockOllamaComplete.mockResolvedValue({
      content: "# Knowledge Wiki\n\n## Old Topic\n- Old fact\n\n---\n\n## New Topic\n- New fact",
      model: "llama3",
      durationMs: 3000,
    });

    await updateWikiWithOllama(
      "/test/kb",
      "What is Y?",
      "Y is another thing.",
      { model: "llama3" }
    );

    const callArgs = mockOllamaComplete.mock.calls[0][0];
    expect(callArgs[1].content).toContain("Current wiki");
    expect(callArgs[1].content).toContain("Old Topic");
  });

  it("silently fails on ollama error (non-fatal)", async () => {
    mockExistsSync.mockReturnValue(false);
    mockMkdir.mockResolvedValue(undefined as any);

    mockOllamaComplete.mockRejectedValue(new Error("Connection refused"));

    // Should not throw
    await expect(
      updateWikiWithOllama("/test/kb", "Q", "A", { model: "llama3" })
    ).resolves.toBeUndefined();
  });

  it("does not write wiki if response is empty", async () => {
    mockExistsSync.mockReturnValue(false);
    mockMkdir.mockResolvedValue(undefined as any);

    mockOllamaComplete.mockResolvedValue({
      content: "   ",
      model: "llama3",
      durationMs: 100,
    });

    await updateWikiWithOllama("/test/kb", "Q", "A", { model: "llama3" });
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});

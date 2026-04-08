import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkOllama } from "../src/ollama.js";

// ── checkOllama ─────────────────────────────────────────────────────────────

describe("checkOllama", () => {
  const origFetch = globalThis.fetch;
  const origOllamaHost = process.env.OLLAMA_HOST;
  const origOllamaModel = process.env.OLLAMA_MODEL;

  afterEach(() => {
    globalThis.fetch = origFetch;
    if (origOllamaHost !== undefined) process.env.OLLAMA_HOST = origOllamaHost;
    else delete process.env.OLLAMA_HOST;
    if (origOllamaModel !== undefined) process.env.OLLAMA_MODEL = origOllamaModel;
    else delete process.env.OLLAMA_MODEL;
  });

  it("returns ok when model is found", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: "llama3:latest" },
          { name: "mistral:latest" },
        ],
      }),
    }) as any;

    const result = await checkOllama({ model: "llama3" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model).toBe("llama3");
      expect(result.models).toContain("llama3");
    }
  });

  it("returns error when model is not found", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [{ name: "mistral:latest" }],
      }),
    }) as any;

    const result = await checkOllama({ model: "llama3" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not found");
      expect(result.error).toContain("ollama pull llama3");
    }
  });

  it("returns error when Ollama returns non-OK status", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }) as any;

    const result = await checkOllama();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("HTTP 500");
    }
  });

  it("returns error when connection refused", async () => {
    const err = new Error("Connection refused");
    (err as any).code = "ECONNREFUSED";
    globalThis.fetch = vi.fn().mockRejectedValue(err) as any;

    const result = await checkOllama();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not running");
    }
  });

  it("returns error on timeout", async () => {
    const err = new Error("Timeout");
    err.name = "TimeoutError";
    globalThis.fetch = vi.fn().mockRejectedValue(err) as any;

    const result = await checkOllama();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not running");
    }
  });

  it("respects OLLAMA_HOST env var", async () => {
    process.env.OLLAMA_HOST = "http://custom:9999";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: "llama3:latest" }] }),
    }) as any;

    await checkOllama({ model: "llama3" });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://custom:9999/api/tags",
      expect.any(Object)
    );
  });

  it("respects OLLAMA_MODEL env var", async () => {
    process.env.OLLAMA_MODEL = "phi3";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: "phi3:latest" }] }),
    }) as any;

    const result = await checkOllama();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model).toBe("phi3");
    }
  });

  it("handles empty models list", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [] }),
    }) as any;

    const result = await checkOllama({ model: "llama3" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("none");
    }
  });

  it("matches model with tag suffix", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [{ name: "llama3:8b-instruct" }],
      }),
    }) as any;

    const result = await checkOllama({ model: "llama3" });
    expect(result.ok).toBe(true);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock existsSync before importing auth module
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: vi.fn() };
});

import { checkAuth } from "../src/auth.js";
import { existsSync } from "node:fs";

const mockExistsSync = vi.mocked(existsSync);

describe("checkAuth", () => {
  const origEnv = process.env.ANTHROPIC_API_KEY;
  const origProvider = process.env.LLM_KB_PROVIDER;

  afterEach(() => {
    if (origEnv !== undefined) process.env.ANTHROPIC_API_KEY = origEnv;
    else delete process.env.ANTHROPIC_API_KEY;
    if (origProvider !== undefined) process.env.LLM_KB_PROVIDER = origProvider;
    else delete process.env.LLM_KB_PROVIDER;
    vi.restoreAllMocks();
  });

  it("returns pi-sdk when auth.json exists", () => {
    mockExistsSync.mockReturnValue(true);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.LLM_KB_PROVIDER;

    const result = checkAuth();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.method).toBe("pi-sdk");
      expect(result.authStorage).toBeDefined();
    }
  });

  it("returns api-key when ANTHROPIC_API_KEY is set", () => {
    mockExistsSync.mockReturnValue(false);
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";

    const result = checkAuth();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.method).toBe("api-key");
      expect(result.authStorage).toBeDefined();
    }
  });

  it("returns failure when neither is available", () => {
    mockExistsSync.mockReturnValue(false);
    delete process.env.ANTHROPIC_API_KEY;

    const result = checkAuth();
    expect(result.ok).toBe(false);
  });

  it("prefers pi-sdk over api-key when both exist", () => {
    mockExistsSync.mockReturnValue(true);
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    delete process.env.LLM_KB_PROVIDER;

    const result = checkAuth();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.method).toBe("pi-sdk");
    }
  });

  it("returns ollama when forceOllama is true", () => {
    mockExistsSync.mockReturnValue(false);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.LLM_KB_PROVIDER;

    const result = checkAuth(true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.method).toBe("ollama");
      expect(result.authStorage).toBeUndefined();
    }
  });

  it("returns ollama when LLM_KB_PROVIDER env is set", () => {
    mockExistsSync.mockReturnValue(false);
    delete process.env.ANTHROPIC_API_KEY;
    process.env.LLM_KB_PROVIDER = "ollama";

    const result = checkAuth();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.method).toBe("ollama");
    }
  });
});

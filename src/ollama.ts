/**
 * Ollama integration for local LLM inference.
 *
 * Provides a lightweight client that talks to a locally running Ollama server
 * (default: http://localhost:11434). Supports both one-shot completions and
 * streaming responses — no API key required.
 */

export interface OllamaOptions {
  /** Ollama server URL. Default: http://localhost:11434 */
  baseUrl?: string;
  /** Model name. Default: llama3 */
  model?: string;
  /** Request timeout in ms. Default: 120_000 */
  timeoutMs?: number;
}

export interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaCompletionResult {
  content: string;
  model: string;
  durationMs: number;
  tokenCount?: number;
}

const DEFAULTS = {
  baseUrl: "http://localhost:11434",
  model: "llama3",
  timeoutMs: 120_000,
} as const;

/**
 * Check if Ollama is running and the specified model is available.
 */
export async function checkOllama(
  opts?: OllamaOptions
): Promise<{ ok: true; model: string; models: string[] } | { ok: false; error: string }> {
  const baseUrl = opts?.baseUrl ?? process.env.OLLAMA_HOST ?? DEFAULTS.baseUrl;
  const model = opts?.model ?? process.env.OLLAMA_MODEL ?? DEFAULTS.model;

  try {
    // Check Ollama is running
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      return { ok: false, error: `Ollama returned HTTP ${res.status}` };
    }

    const data = (await res.json()) as { models?: { name: string }[] };
    const models = (data.models ?? []).map((m) => m.name.replace(/:latest$/, ""));

    // Check if desired model is available
    const hasModel = models.some(
      (m) => m === model || m.startsWith(model + ":")
    );

    if (!hasModel) {
      return {
        ok: false,
        error: `Model "${model}" not found. Available: ${models.join(", ") || "none"}. Run: ollama pull ${model}`,
      };
    }

    return { ok: true, model, models };
  } catch (err: any) {
    if (err.name === "TimeoutError" || err.code === "ECONNREFUSED") {
      return {
        ok: false,
        error: "Ollama is not running. Start it with: ollama serve",
      };
    }
    return { ok: false, error: `Cannot reach Ollama: ${err.message}` };
  }
}

/**
 * Send a one-shot completion request to Ollama (non-streaming).
 * Used for indexing, wiki updates, and eval — tasks that don't need streaming.
 */
export async function ollamaComplete(
  messages: OllamaMessage[],
  opts?: OllamaOptions
): Promise<OllamaCompletionResult> {
  const baseUrl = opts?.baseUrl ?? process.env.OLLAMA_HOST ?? DEFAULTS.baseUrl;
  const model = opts?.model ?? process.env.OLLAMA_MODEL ?? DEFAULTS.model;
  const timeoutMs = opts?.timeoutMs ?? DEFAULTS.timeoutMs;

  const start = Date.now();

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama error (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    message?: { content: string };
    model: string;
    eval_count?: number;
  };

  return {
    content: data.message?.content ?? "",
    model: data.model ?? model,
    durationMs: Date.now() - start,
    tokenCount: data.eval_count,
  };
}

/**
 * Stream a completion from Ollama, yielding content chunks as they arrive.
 * Used for interactive query mode — gives real-time feedback to the user.
 */
export async function* ollamaStream(
  messages: OllamaMessage[],
  opts?: OllamaOptions
): AsyncGenerator<{ type: "delta"; content: string } | { type: "done"; model: string; durationMs: number }> {
  const baseUrl = opts?.baseUrl ?? process.env.OLLAMA_HOST ?? DEFAULTS.baseUrl;
  const model = opts?.model ?? process.env.OLLAMA_MODEL ?? DEFAULTS.model;
  const timeoutMs = opts?.timeoutMs ?? DEFAULTS.timeoutMs;

  const start = Date.now();

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama error (${res.status}): ${body}`);
  }

  if (!res.body) {
    throw new Error("Ollama returned no response body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as {
            message?: { content: string };
            done?: boolean;
            model?: string;
          };

          if (parsed.message?.content) {
            yield { type: "delta", content: parsed.message.content };
          }

          if (parsed.done) {
            yield {
              type: "done",
              model: parsed.model ?? model,
              durationMs: Date.now() - start,
            };
            return;
          }
        } catch {
          // Skip malformed JSON lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield { type: "done", model, durationMs: Date.now() - start };
}

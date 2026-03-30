/**
 * EmbeddingService — lazy-loaded semantic embedding using @huggingface/transformers.
 *
 * Model: Xenova/all-MiniLM-L6-v2 (384-dim, ONNX/WASM, offline after first download)
 * Model cache: ~/.contextlens-turbo/models/
 *
 * Lifecycle states:
 *   unloaded  → (first embed() call triggers load)
 *   loading   → (model downloading / warming up)
 *   ready     → (model loaded, embed() works)
 *   failed    → (load error, embed() returns null, tools fall back to keyword-only)
 *
 * Design: all tools that use embeddings check `isReady()` before calling `embed()`.
 * If not ready, they operate in keyword-only mode without throwing.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";

export const EMBEDDING_DIMENSIONS = 384;
export const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

// Max input tokens for all-MiniLM-L6-v2: 256 tokens (~192 words)
// We truncate embedding text to stay within this limit.
const MAX_EMBEDDING_CHARS = 512;

type EmbeddingState = "unloaded" | "loading" | "ready" | "failed";

// Type stub for @huggingface/transformers dynamic import.
// The pipeline always returns a Tensor-like object regardless of single vs batch input.
// For batch input of N strings, data is a flat Float32Array of length N * dimensions.
interface EmbeddingTensor {
  data: Float32Array;
  dims: number[];
}

interface FeatureExtractionPipeline {
  (text: string | string[], options: { pooling: string; normalize: boolean }): Promise<EmbeddingTensor>;
}

export class EmbeddingService {
  private state: EmbeddingState = "unloaded";
  private pipeline: FeatureExtractionPipeline | null = null;
  private loadPromise: Promise<void> | null = null;
  private loadError: Error | null = null;
  private readonly cacheDir: string;

  constructor() {
    this.cacheDir = join(homedir(), ".contextlens-turbo", "models");
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Returns true if the model is loaded and embed() will succeed.
   */
  isReady(): boolean {
    return this.state === "ready";
  }

  /**
   * Returns true if the model load failed (permanent failure).
   */
  hasFailed(): boolean {
    return this.state === "failed";
  }

  /**
   * Trigger model loading. Idempotent — safe to call multiple times.
   * Returns a Promise that resolves when the model is ready (or rejects on failure).
   * Callers that don't need to await completion can fire-and-forget.
   */
  async load(): Promise<void> {
    if (this.state === "ready") return;
    if (this.state === "failed") throw this.loadError!;
    if (this.loadPromise !== null) return this.loadPromise;

    this.state = "loading";
    this.loadPromise = this._doLoad();
    return this.loadPromise;
  }

  private async _doLoad(): Promise<void> {
    try {
      // Dynamic import keeps @huggingface/transformers out of the cold-start path
      const { pipeline, env } = await import("@huggingface/transformers");

      // Point model cache to our dedicated directory
      env.cacheDir = this.cacheDir;

      // Load the feature extraction pipeline with ONNX/WASM backend.
      // dtype "q8" uses int8-quantized weights (~23MB vs 90MB fp32).
      // On CPU: ~3x faster load, ~2x faster inference, negligible accuracy loss.
      const pipe = await pipeline("feature-extraction", MODEL_ID, {
        local_files_only: false,
        dtype: "q8",
      });

      // Warm up: run a single dummy inference to JIT-compile the WASM module
      await pipe("warmup", { pooling: "mean", normalize: true });

      this.pipeline = pipe as unknown as FeatureExtractionPipeline;
      this.state = "ready";
    } catch (err) {
      this.state = "failed";
      this.loadError = err instanceof Error ? err : new Error(String(err));
      this.loadPromise = null; // Allow retry on next load() call attempt
      throw this.loadError;
    }
  }

  /**
   * Embed a text string into a 384-dim Float32Array.
   * Returns null if the model is not ready (keyword fallback).
   *
   * Text is truncated to MAX_EMBEDDING_CHARS to stay within MiniLM's token window.
   */
  async embed(text: string): Promise<Float32Array | null> {
    if (this.state !== "ready" || this.pipeline === null) return null;

    const truncated = text.length > MAX_EMBEDDING_CHARS
      ? text.slice(0, MAX_EMBEDDING_CHARS)
      : text;

    try {
      const tensor = await this.pipeline(truncated, { pooling: "mean", normalize: true });
      // Single input: tensor.data is Float32Array of length 384
      return tensor.data.slice(0, EMBEDDING_DIMENSIONS);
    } catch {
      return null;
    }
  }

  /**
   * Batch-embed multiple texts in a single ONNX forward pass.
   * Significantly faster than N sequential embed() calls — use during indexing.
   *
   * Returns one Float32Array per input text (same order). Never throws.
   * Texts are truncated to MAX_EMBEDDING_CHARS each.
   */
  async embedBatch(texts: string[]): Promise<Array<Float32Array | null>> {
    if (this.state !== "ready" || this.pipeline === null) {
      return texts.map(() => null);
    }

    if (texts.length === 0) return [];

    const truncated = texts.map((t) =>
      t.length > MAX_EMBEDDING_CHARS ? t.slice(0, MAX_EMBEDDING_CHARS) : t
    );

    try {
      // Batch input → Tensor with dims [N, EMBEDDING_DIMENSIONS].
      // tensor.data is a flat Float32Array of length N * 384.
      const tensor = await this.pipeline(truncated, { pooling: "mean", normalize: true });
      const n = texts.length;
      return Array.from({ length: n }, (_, i) =>
        tensor.data.slice(i * EMBEDDING_DIMENSIONS, (i + 1) * EMBEDDING_DIMENSIONS)
      );
    } catch {
      return texts.map(() => null);
    }
  }

  /**
   * Returns the current state for status reporting.
   */
  getStatus(): { state: EmbeddingState; model: string; dimensions: number; error?: string } {
    return {
      state: this.state,
      model: MODEL_ID,
      dimensions: EMBEDDING_DIMENSIONS,
      ...(this.loadError ? { error: this.loadError.message } : {}),
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// Embedding text construction
// ─────────────────────────────────────────────────────────────────

/**
 * Construct embedding text for a code symbol.
 * Format: "{kind} {name} {signature} {docComment}"
 * Keeps semantic focus within the 256-token MiniLM window.
 */
export function buildSymbolEmbeddingText(symbol: {
  kind: string;
  name: string;
  signature: string;
  doc_comment: string | null;
}): string {
  const parts = [symbol.kind, symbol.name];
  if (symbol.signature) parts.push(symbol.signature);
  if (symbol.doc_comment) parts.push(symbol.doc_comment);
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Construct embedding text for a documentation section.
 * Format: "{title} {summary}"
 */
export function buildSectionEmbeddingText(section: {
  title: string;
  summary: string | null;
}): string {
  const parts = [section.title];
  if (section.summary) parts.push(section.summary);
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

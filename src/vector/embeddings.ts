import { pipeline } from "@xenova/transformers";
import { Result } from "better-result";
import { EmbedderNotInitializedError } from "../errors.js";

const MODEL_NAME = "Xenova/bge-base-en-v1.5";
const EMBEDDING_DIM = 768;

// BGE models benefit from instruction prefix for retrieval queries
const QUERY_PREFIX = "Represent this code search query: ";

// BGE has 512 token limit (~2000 chars for code)
const MAX_CHARS = 1800;

// Use any for the embedder since @xenova/transformers types are complex
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let embedder: any = null;

/**
 * Initialize the embedding model (lazy, downloads on first use)
 */
export async function initEmbedder(): Promise<void> {
  if (!embedder) {
    embedder = await pipeline("feature-extraction", MODEL_NAME);
  }
}

/**
 * Check if embedder is initialized
 */
export function isEmbedderReady(): boolean {
  return embedder !== null;
}

/**
 * Extract Float32Array from embedder output
 */
function toFloat32Array(output: unknown): Float32Array {
  // The output has a .data property that contains the embedding values
  const data = (output as { data: ArrayLike<number> }).data;
  return new Float32Array(data);
}

/**
 * Embed a search query (with query prefix for better retrieval)
 */
export async function embedQuery(
  query: string
): Promise<Result<Float32Array, EmbedderNotInitializedError>> {
  if (!embedder) {
    return Result.err(new EmbedderNotInitializedError());
  }

  const text = QUERY_PREFIX + query;
  const output = await embedder(text, { pooling: "mean", normalize: true });

  return Result.ok(toFloat32Array(output));
}

/**
 * Embed code chunks for storage (batched for performance)
 */
export async function embedChunks(
  chunks: string[]
): Promise<Result<Float32Array[], EmbedderNotInitializedError>> {
  if (!embedder) {
    return Result.err(new EmbedderNotInitializedError());
  }

  if (chunks.length === 0) {
    return Result.ok([]);
  }

  // Truncate all chunks first
  const texts = chunks.map(truncateForEmbedding);

  // Batch embed - transformers.js supports array input
  const output = await embedder(texts, { pooling: "mean", normalize: true });

  // Extract individual embeddings from batched output
  // Output shape: [batch_size, embedding_dim] stored in flat .data array
  const results: Float32Array[] = [];
  const data = (output as { data: ArrayLike<number> }).data;

  for (let i = 0; i < chunks.length; i++) {
    const start = i * EMBEDDING_DIM;
    const end = start + EMBEDDING_DIM;
    results.push(new Float32Array(Array.prototype.slice.call(data, start, end)));
  }

  return Result.ok(results);
}

/**
 * Embed a single chunk
 */
export async function embedChunk(
  chunk: string
): Promise<Result<Float32Array, EmbedderNotInitializedError>> {
  if (!embedder) {
    return Result.err(new EmbedderNotInitializedError());
  }

  const text = truncateForEmbedding(chunk);
  const output = await embedder(text, { pooling: "mean", normalize: true });

  return Result.ok(toFloat32Array(output));
}

/**
 * Truncate text to fit within embedding model's token limit
 * Keeps the beginning (usually contains signature/name) and truncates body
 */
function truncateForEmbedding(text: string): string {
  if (text.length <= MAX_CHARS) {
    return text;
  }

  // Keep first part and add truncation marker
  return text.slice(0, MAX_CHARS) + "\n// ... truncated";
}

/**
 * Get the embedding dimension
 */
export function getEmbeddingDim(): number {
  return EMBEDDING_DIM;
}

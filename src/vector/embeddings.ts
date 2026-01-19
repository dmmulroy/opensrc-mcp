import { pipeline } from "@xenova/transformers";

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
export async function embedQuery(query: string): Promise<Float32Array> {
  if (!embedder) {
    throw new Error("Embedder not initialized. Call initEmbedder() first.");
  }

  const text = QUERY_PREFIX + query;
  const output = await embedder(text, { pooling: "mean", normalize: true });

  return toFloat32Array(output);
}

/**
 * Embed code chunks for storage
 */
export async function embedChunks(chunks: string[]): Promise<Float32Array[]> {
  if (!embedder) {
    throw new Error("Embedder not initialized. Call initEmbedder() first.");
  }

  const results: Float32Array[] = [];

  for (const chunk of chunks) {
    // Truncate if too long
    const text = truncateForEmbedding(chunk);
    const output = await embedder(text, { pooling: "mean", normalize: true });
    results.push(toFloat32Array(output));
  }

  return results;
}

/**
 * Embed a single chunk
 */
export async function embedChunk(chunk: string): Promise<Float32Array> {
  if (!embedder) {
    throw new Error("Embedder not initialized. Call initEmbedder() first.");
  }

  const text = truncateForEmbedding(chunk);
  const output = await embedder(text, { pooling: "mean", normalize: true });

  return toFloat32Array(output);
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

import type { CodeChunk } from "../types.js";

const WINDOW_SIZE = 50;
const OVERLAP = 15;

/**
 * Fallback sliding window chunker for unsupported file types
 */
export function fallbackChunk(file: string, content: string): CodeChunk[] {
  const lines = content.split("\n");
  const chunks: CodeChunk[] = [];

  for (let i = 0; i < lines.length; i += WINDOW_SIZE - OVERLAP) {
    const end = Math.min(i + WINDOW_SIZE, lines.length);
    const chunkContent = lines.slice(i, end).join("\n").trim();

    // Skip empty chunks
    if (!chunkContent) continue;

    chunks.push({
      file,
      identifier: `lines_${i + 1}_${end}`,
      kind: "unknown",
      startLine: i + 1,
      endLine: end,
      content: chunkContent,
    });

    if (end >= lines.length) break;
  }

  return chunks;
}

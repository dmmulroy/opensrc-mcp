import { TypeScriptChunker } from "./typescript.js";
import { RustChunker } from "./rust.js";
import { chunkMarkdown } from "./markdown.js";
import { fallbackChunk } from "./fallback.js";
import type { CodeChunk } from "../types.js";

type Lang = "ts" | "rust" | "md" | "fallback";

const EXT_MAP: Record<string, Lang> = {
  // TypeScript/JavaScript
  ".ts": "ts",
  ".tsx": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".js": "ts",
  ".jsx": "ts",
  ".mjs": "ts",
  ".cjs": "ts",
  // Rust
  ".rs": "rust",
  // Markdown
  ".md": "md",
  ".mdx": "md",
  ".markdown": "md",
};

// Lazy init chunkers (heavy to construct)
let tsChunker: TypeScriptChunker | null = null;
let rustChunker: RustChunker | null = null;

function getTsChunker(): TypeScriptChunker {
  if (!tsChunker) {
    tsChunker = new TypeScriptChunker();
  }
  return tsChunker;
}

function getRustChunker(): RustChunker {
  if (!rustChunker) {
    rustChunker = new RustChunker();
  }
  return rustChunker;
}

/**
 * Chunk a file based on its extension
 */
export function chunk(file: string, content: string): CodeChunk[] {
  const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
  const lang = EXT_MAP[ext] ?? "fallback";

  switch (lang) {
    case "ts":
      return getTsChunker().chunk(file, content);
    case "rust":
      return getRustChunker().chunk(file, content);
    case "md":
      return chunkMarkdown(file, content);
    default:
      return fallbackChunk(file, content);
  }
}

/**
 * Get supported file extensions for glob patterns
 */
export function getSupportedExtensions(): string[] {
  return Object.keys(EXT_MAP);
}

/**
 * Check if a file extension is supported
 */
export function isSupported(file: string): boolean {
  const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
  return ext in EXT_MAP;
}

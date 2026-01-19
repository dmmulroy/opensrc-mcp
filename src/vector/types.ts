/**
 * Code chunk extracted from source files for embedding
 */
export interface CodeChunk {
  file: string;
  identifier: string;
  kind: ChunkKind;
  startLine: number;
  endLine: number;
  content: string;
  parent?: string;
}

export type ChunkKind =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "variable"
  | "enum"
  | "struct"
  | "trait"
  | "impl"
  | "mod"
  | "macro"
  | "section"
  | "codeblock"
  | "unknown";

/**
 * Result from semantic search
 */
export interface SearchResult {
  source: string;
  file: string;
  identifier: string;
  kind: ChunkKind;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
}

/**
 * Search response - either results or not_indexed error
 */
export type SearchResponse =
  | SearchResult[]
  | { error: "not_indexed"; sources: string[] };

/**
 * Message types for worker communication
 */
export type WorkerMessage =
  | { type: "init"; opensrcDir: string }
  | { type: "index"; source: string; path: string }
  | { type: "search"; id: string; query: string; options?: SearchOptions }
  | { type: "ready" }
  | { type: "indexed"; source: string; skipped: boolean }
  | { type: "results"; id: string; results?: SearchResult[]; error?: "not_indexed"; sources?: string[] }
  | { type: "error"; error: string };

export interface SearchOptions {
  sources?: string[];
  topK?: number;
}

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
 * Search response - results or error with reason
 */
export type SearchResponse =
  | SearchResult[]
  | { error: "not_indexed"; sources: string[] }
  | { error: "indexing"; sources: string[] };

export interface SearchOptions {
  sources?: string[];
  topK?: number;
}

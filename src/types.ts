/**
 * Represents a fetched source (package or repo)
 */
export interface Source {
  type: "npm" | "pypi" | "crates" | "repo";
  name: string;
  version?: string;
  ref?: string;
  path: string; // relative path in opensrc/repos/
  fetchedAt: string; // ISO timestamp
  repository: string; // full repo URL
}

/**
 * File entry from directory listing
 */
export interface FileEntry {
  path: string;
  size: number;
  isDirectory: boolean;
}

/**
 * Grep search result
 */
export interface GrepResult {
  source: string;
  file: string;
  line: number;
  content: string;
}

/**
 * Result of parsing a package spec
 */
export interface ParsedSpec {
  type: "npm" | "pypi" | "crates" | "repo";
  name: string;
  version?: string;
  ref?: string;
  repoUrl?: string;
}

/**
 * Result of a fetch operation (discriminated union for type safety)
 */
export type FetchResult =
  | { success: true; source: Source; alreadyExists: boolean }
  | { success: false; error: string };

/**
 * Result of remove/clean operations
 */
export interface RemoveResult {
  success: boolean;
  removed: string[];
}

/**
 * Executor result
 */
export interface ExecutorResult {
  result?: unknown;
  error?: string;
}

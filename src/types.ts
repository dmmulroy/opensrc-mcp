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
 * Successful fetch data
 */
export interface FetchedSource {
  source: Source;
  alreadyExists: boolean;
}

/**
 * Result of remove/clean operations
 */
export interface RemoveResult {
  success: boolean;
  removed: string[];
}

/**
 * AST-grep search match
 */
export interface AstGrepMatch {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  text: string;
  metavars: Record<string, string>;
}

/**
 * AST-grep search options
 */
export interface AstGrepOptions {
  glob?: string;
  lang?: string | string[];
  limit?: number;
}

/**
 * Tree node for directory structure visualization
 */
export interface TreeNode {
  name: string;
  type: "file" | "dir";
  children?: TreeNode[];
}

/**
 * Executor result - uses Result for type-safe error handling
 */
export type { Result } from "better-result";
export type { ExecutorError } from "./errors.js";

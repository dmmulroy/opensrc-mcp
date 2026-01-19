import { createContext, Script, type Context } from "node:vm";
import type { Source, ExecutorResult } from "./types.js";

/**
 * Deep freeze an object to prevent modification
 */
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;

  Object.getOwnPropertyNames(obj).forEach((prop) => {
    const value = (obj as Record<string, unknown>)[prop];
    if (value && typeof value === "object") {
      deepFreeze(value);
    }
  });

  return Object.freeze(obj);
}

export type SearchAPI = {
  list: () => Source[];
  has: (name: string, version?: string) => boolean;
  get: (name: string) => Source | undefined;
  files: (
    sourceName: string,
    glob?: string
  ) => Promise<Array<{ path: string; size: number; isDirectory: boolean }>>;
  grep: (
    pattern: string,
    options?: { sources?: string[]; include?: string; maxResults?: number }
  ) => Promise<
    Array<{ source: string; file: string; line: number; content: string }>
  >;
  read: (sourceName: string, filePath: string) => Promise<string>;
  resolve: (spec: string) => Promise<{
    type: "npm" | "pypi" | "crates" | "repo";
    name: string;
    version?: string;
    ref?: string;
    repoUrl?: string;
  }>;
};

export type ExecuteAPI = {
  fetch: (
    specs: string | string[],
    options?: { modify?: boolean }
  ) => Promise<
    Array<{
      success: boolean;
      source?: Source;
      error?: string;
      alreadyExists?: boolean;
    }>
  >;
  remove: (names: string[]) => Promise<{ success: boolean; removed: string[] }>;
  clean: (options?: {
    packages?: boolean;
    repos?: boolean;
    npm?: boolean;
    pypi?: boolean;
    crates?: boolean;
  }) => Promise<{ success: boolean; removed: string[] }>;
  readMany: (
    sourceName: string,
    paths: string[]
  ) => Promise<Record<string, string>>;
};

interface ExecutorOptions {
  projectDir: string;
  getSources: () => Source[];
  mode: "search" | "execute";
  api: SearchAPI | ExecuteAPI;
}

/**
 * Create a sandboxed code executor
 */
export function createExecutor(options: ExecutorOptions) {
  const { getSources, projectDir, mode, api } = options;

  return async (code: string): Promise<ExecutorResult> => {
    // Build frozen context with injected API
    const frozenContext = deepFreeze({
      opensrc: api,
      sources: getSources(),
      cwd: projectDir,
    });

    // Create isolated context with minimal safe globals
    const context: Context = createContext({
      ...frozenContext,
      // Minimal safe globals
      console: Object.freeze({
        log: () => {},
        warn: () => {},
        error: () => {},
      }),
      JSON: Object.freeze({ parse: JSON.parse, stringify: JSON.stringify }),
      Object: Object.freeze({
        keys: Object.keys,
        values: Object.values,
        entries: Object.entries,
        fromEntries: Object.fromEntries,
      }),
      Array: Object.freeze({ isArray: Array.isArray }),
      Promise: Promise,
      // Block dangerous globals
      setTimeout: undefined,
      setInterval: undefined,
      setImmediate: undefined,
      fetch: undefined,
      require: undefined,
      process: undefined,
      global: undefined,
      globalThis: undefined,
    });

    try {
      // Compile script
      const script = new Script(`(${code})()`, {
        filename: `agent-code-${mode}.js`,
      });

      // Execute and await result
      const resultPromise = script.runInContext(context, {
        timeout: 30000,
        breakOnSigint: true,
      });

      // Handle async results with timeout
      const result = await Promise.race([
        resultPromise,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Execution timeout (30s)")),
            30000
          )
        ),
      ]);

      return { result };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };
}

import { createContext, runInContext, Script, type Context } from "node:vm";
import type { Source, ExecutorResult } from "./types.js";
import type { OpensrcAPI } from "./api/opensrc.js";

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

/**
 * Code to freeze built-in prototypes in the VM context.
 * Prevents prototype pollution attacks from persisting across requests.
 */
const PROTOTYPE_FREEZE_CODE = `
  Object.freeze(Object.prototype);
  Object.freeze(Array.prototype);
  Object.freeze(String.prototype);
  Object.freeze(Number.prototype);
  Object.freeze(Boolean.prototype);
  Object.freeze(Function.prototype);
`;

interface ExecutorOptions {
  projectDir: string;
  getSources: () => Source[];
  api: OpensrcAPI;
}

/**
 * Create a sandboxed code executor
 */
export function createExecutor(options: ExecutorOptions) {
  const { getSources, projectDir, api } = options;

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
        freeze: Object.freeze,
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

    // Freeze built-in prototypes to prevent pollution
    runInContext(PROTOTYPE_FREEZE_CODE, context);

    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      // Compile script
      const script = new Script(`(${code})()`, {
        filename: "agent-code.js",
      });

      // Execute and await result
      const resultPromise = script.runInContext(context, {
        timeout: 30000,
        breakOnSigint: true,
      });

      // Handle async results with timeout (clear timer to prevent leak)
      const result = await Promise.race([
        resultPromise,
        new Promise((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("Execution timeout (30s)")),
            30000
          );
        }),
      ]);

      return { result };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  };
}

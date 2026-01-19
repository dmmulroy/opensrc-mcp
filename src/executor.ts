import { createContext, runInContext, Script, type Context } from "node:vm";
import { Result } from "better-result";
import type { Source } from "./types.js";
import type { OpensrcAPI } from "./api/opensrc.js";
import { CodeExecutionError, ExecutionTimeoutError, type ExecutorError } from "./errors.js";

/**
 * Executor result type
 */
export type ExecutorResult = Result<unknown, ExecutorError>;

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
  /** Current working directory (project the user is in) */
  cwd: string;
  getSources: () => Source[];
  api: OpensrcAPI;
}

/**
 * Create a sandboxed code executor
 */
export function createExecutor(options: ExecutorOptions) {
  const { getSources, cwd, api } = options;

  return async (code: string): Promise<ExecutorResult> => {
    // Build frozen context with injected API
    const frozenContext = deepFreeze({
      opensrc: api,
      sources: getSources(),
      cwd,
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
      // Expose Result for agent code to work with Result values
      Result: Object.freeze({
        ok: Result.ok,
        err: Result.err,
        isOk: Result.isOk,
        isError: Result.isError,
      }),
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
    const TIMEOUT_MS = 30000;

    const executeResult = await Result.tryPromise({
      try: async () => {
        // Compile script
        const script = new Script(`(${code})()`, {
          filename: "agent-code.js",
        });

        // Execute and await result
        const resultPromise = script.runInContext(context, {
          timeout: TIMEOUT_MS,
          breakOnSigint: true,
        });

        // Handle async results with timeout
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new ExecutionTimeoutError(TIMEOUT_MS)),
            TIMEOUT_MS
          );
        });

        return await Promise.race([resultPromise, timeoutPromise]);
      },
      catch: (cause) => {
        if (cause instanceof ExecutionTimeoutError) {
          return cause;
        }
        return new CodeExecutionError(cause);
      },
    });

    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }

    return executeResult;
  };
}

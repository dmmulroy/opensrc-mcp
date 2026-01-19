import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { SearchResponse, SearchResult, WorkerMessage, SearchOptions } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Worker path: dist/vector/worker.mjs relative to dist/index.mjs
// __dirname is dist/ when bundled
const WORKER_PATH = join(__dirname, "vector", "worker.mjs");

let worker: Worker | null = null;
let ready = false;
let initPromise: Promise<void> | null = null;

const pending = new Map<string, {
  resolve: (r: SearchResponse) => void;
  reject: (err: Error) => void;
}>();

/**
 * Initialize the vector search worker
 */
export function initVector(opensrcDir: string): Promise<void> {
  if (initPromise) {
    return initPromise;
  }

  initPromise = new Promise((resolve, reject) => {
    try {
      worker = new Worker(WORKER_PATH);

      worker.on("message", (msg: WorkerMessage) => {
        switch (msg.type) {
          case "ready":
            ready = true;
            resolve();
            break;

          case "results": {
            const pendingReq = pending.get(msg.id);
            if (pendingReq) {
              if (msg.error) {
                pendingReq.resolve({ error: msg.error, sources: msg.sources ?? [] });
              } else {
                pendingReq.resolve(msg.results ?? []);
              }
              pending.delete(msg.id);
            }
            break;
          }

          case "indexed":
            // Indexing complete - could emit event if needed
            break;

          case "error":
            // If not ready yet, this is an init error
            if (!ready) {
              reject(new Error(msg.error));
            } else {
              console.error(`Vector worker error: ${msg.error}`);
            }
            break;
        }
      });

      worker.on("error", (err) => {
        console.error("Vector worker error:", err);
        reject(err);
      });

      worker.on("exit", (code) => {
        if (code !== 0) {
          console.error(`Vector worker exited with code ${code}`);
        }
        worker = null;
        ready = false;
        initPromise = null;
      });

      // Send init message
      worker.postMessage({ type: "init", opensrcDir } satisfies WorkerMessage);
    } catch (err) {
      reject(err);
    }
  });

  return initPromise;
}

/**
 * Check if vector search is ready
 */
export function isVectorReady(): boolean {
  return ready;
}

/**
 * Queue a source for indexing (non-blocking)
 */
export function queueIndex(source: string, path: string): void {
  if (!worker || !ready) {
    return;
  }

  worker.postMessage({ type: "index", source, path } satisfies WorkerMessage);
}

/**
 * Search for code chunks matching a query
 */
export function search(
  query: string,
  options?: SearchOptions
): Promise<SearchResponse> {
  return new Promise((resolve, reject) => {
    if (!worker || !ready) {
      resolve({ error: "not_indexed", sources: options?.sources ?? [] });
      return;
    }

    const id = randomUUID();

    // Set timeout for search
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Search timeout"));
    }, 30000);

    pending.set(id, {
      resolve: (r) => {
        clearTimeout(timeout);
        resolve(r);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    });

    worker.postMessage({
      type: "search",
      id,
      query,
      options,
    } satisfies WorkerMessage);
  });
}

/**
 * Shutdown the vector worker
 */
export async function shutdownVector(): Promise<void> {
  if (worker) {
    await worker.terminate();
    worker = null;
    ready = false;
    initPromise = null;
  }
}

// Re-export types
export type { SearchResult, SearchResponse, SearchOptions };

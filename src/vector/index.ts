/**
 * Vector search module - semantic code search using sqlite-vector
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import { Result } from "better-result";
import { createLogger } from "../logger.js";
import {
  initDB,
  isIndexed,
  markIndexed,
  insertChunks,
  searchChunks,
  finalizeVectorIndex,
} from "./db.js";
import { initEmbedder, embedQuery, embedChunks } from "./embeddings.js";
import { chunk } from "./chunker/index.js";
import type { SearchResponse, SearchResult, SearchOptions, CodeChunk } from "./types.js";
import type Database from "better-sqlite3";

const log = createLogger("vector");

const BATCH_SIZE = 50; // Increased since embeddings are now batched properly
const MAX_CONCURRENT_INDEX = 2; // Limit concurrent indexing to prevent resource exhaustion

/**
 * Yield to event loop to allow other work (e.g., search queries) to process
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const FILE_PATTERNS = [
  "**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx",
  "**/*.mts", "**/*.cts", "**/*.mjs", "**/*.cjs",
  "**/*.rs", "**/*.md", "**/*.mdx", "**/*.markdown",
];

const IGNORE_PATTERNS = [
  "**/node_modules/**", "**/.git/**", "**/*.d.ts", "**/*.min.js",
  "**/dist/**", "**/build/**", "**/target/**",
  "**/CHANGELOG.md", "**/HISTORY.md",
];

let db: Database.Database | null = null;
let opensrcDir: string = "";
let ready = false;

/** Track sources currently being indexed */
const indexingInProgress = new Set<string>();

/** Semaphore for limiting concurrent indexing */
let activeIndexCount = 0;
const indexQueue: Array<{ source: string; path: string; resolve: () => void; }> = [];

/**
 * Check if a source is currently being indexed
 */
export function isIndexing(source: string): boolean {
  return indexingInProgress.has(source);
}

/**
 * Get all sources currently being indexed
 */
export function getIndexingSources(): string[] {
  return Array.from(indexingInProgress);
}

/**
 * Initialize vector search
 */
export async function initVector(dir: string): Promise<Result<void, Error>> {
  log.info("init", { dir });
  opensrcDir = dir;

  const dbResult = initDB(opensrcDir);
  if (dbResult.isErr()) {
    log.error("db init failed", dbResult.error);
    return Result.err(dbResult.error);
  }
  db = dbResult.value;

  log.debug("db ready, loading embedder");

  try {
    await initEmbedder();
    ready = true;
    log.info("ready");
    return Result.ok(undefined);
  } catch (err) {
    log.error("embedder init failed", err instanceof Error ? err : new Error(String(err)));
    return Result.err(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Check if vector search is ready
 */
export function isVectorReady(): boolean {
  return ready;
}

/**
 * Index all sources that haven't been indexed yet
 * Call this after initVector with the list of existing sources
 */
export function indexExistingSources(sources: Array<{ name: string; path: string; }>): void {
  const database = db;
  if (!database || !ready) {
    log.warn("indexExistingSources called but not ready");
    return;
  }

  const unindexed = sources.filter((s) => !isIndexed(database, s.name));
  if (unindexed.length === 0) {
    log.debug("all sources already indexed");
    return;
  }

  log.info("indexing existing sources", { count: unindexed.length, sources: unindexed.map(s => s.name) });

  // Queue all sources for indexing with concurrency control
  for (const source of unindexed) {
    queueIndex(source.name, source.path);
  }
}

/**
 * Process the next item in the index queue if we have capacity
 */
function processIndexQueue(): void {
  while (activeIndexCount < MAX_CONCURRENT_INDEX && indexQueue.length > 0) {
    const item = indexQueue.shift();
    if (item) {
      activeIndexCount++;
      indexSourceInternal(item.source, item.path)
        .finally(() => {
          activeIndexCount--;
          item.resolve();
          processIndexQueue(); // Process next in queue
        });
    }
  }
}

/**
 * Queue a source for indexing with concurrency control
 */
export function queueIndex(source: string, path: string): void {
  const database = db;
  if (!database || !ready) return;

  // Skip if already indexed or being indexed
  if (isIndexed(database, source) || indexingInProgress.has(source)) {
    return;
  }

  // Skip if already in queue
  if (indexQueue.some((item) => item.source === source)) {
    return;
  }

  // Add to queue with a promise for tracking
  new Promise<void>((resolve) => {
    indexQueue.push({ source, path, resolve });
    processIndexQueue();
  }).catch((err) => {
    log.error("indexing failed", { source, error: err instanceof Error ? err.message : String(err) });
  });
}

/**
 * Generator that yields chunks from files (streams to avoid loading all into memory)
 */
async function* chunkFiles(
  sourcePath: string,
  files: string[]
): AsyncGenerator<CodeChunk> {
  for (const file of files) {
    try {
      const content = await readFile(join(sourcePath, file), "utf8");
      yield* chunk(file, content);
    } catch {
      // skip unreadable files
    }
  }
}

/**
 * Internal indexing implementation
 */
async function indexSourceInternal(source: string, path: string): Promise<void> {
  const database = db;
  if (!database) return;

  if (isIndexed(database, source)) {
    log.debug("already indexed", { source });
    return;
  }

  if (indexingInProgress.has(source)) {
    log.debug("already indexing", { source });
    return;
  }

  // Mark as indexing
  indexingInProgress.add(source);
  log.info("indexing", { source, path });

  let totalChunks = 0;

  try {
    const sourcePath = join(opensrcDir, path);

    const files = await fg(FILE_PATTERNS, {
      cwd: sourcePath,
      ignore: IGNORE_PATTERNS,
      onlyFiles: true,
    });

    // Stream chunks and process in batches to avoid loading all into memory
    const batch: CodeChunk[] = [];

    for await (const c of chunkFiles(sourcePath, files)) {
      batch.push(c);

      if (batch.length >= BATCH_SIZE) {
        const processedCount = await processBatch(database, source, batch);
        if (processedCount === -1) return; // Error occurred
        totalChunks += processedCount;
        batch.length = 0; // Clear batch

        // Yield to event loop to allow search queries to be processed
        await yieldToEventLoop();
      }
    }

    // Process remaining chunks
    if (batch.length > 0) {
      const processedCount = await processBatch(database, source, batch);
      if (processedCount === -1) return;
      totalChunks += processedCount;
    }

    // Finalize vector index ONCE after all batches (not per-batch)
    if (totalChunks > 0) {
      const finalizeResult = finalizeVectorIndex(database);
      if (finalizeResult.isErr()) {
        log.error("finalize failed", finalizeResult.error);
        return;
      }
    }

    markIndexed(database, source);
    log.info("indexed", { source, chunks: totalChunks });
  } finally {
    // Always remove from indexing set
    indexingInProgress.delete(source);
  }
}

/**
 * Process a batch of chunks: embed and insert
 * Returns number of chunks processed, or -1 on error
 */
async function processBatch(
  database: Database.Database,
  source: string,
  batch: CodeChunk[]
): Promise<number> {
  const texts = batch.map((c) => c.content);
  const embeddingsResult = await embedChunks(texts);

  if (embeddingsResult.isErr()) {
    log.error("embedding failed", embeddingsResult.error);
    return -1;
  }

  const insertResult = insertChunks(database, source, batch, embeddingsResult.value);
  if (insertResult.isErr()) {
    log.error("insert failed", insertResult.error);
    return -1;
  }

  return batch.length;
}

/**
 * Search for code chunks matching a query
 */
export async function search(
  query: string,
  options?: SearchOptions
): Promise<SearchResponse> {
  const database = db;
  if (!database || !ready) {
    return { error: "not_indexed", sources: options?.sources ?? [] };
  }

  const { sources, topK = 20 } = options ?? {};
  log.debug("search", { query: query.slice(0, 50), sources, topK });

  // Fast existence check instead of COUNT(*) - only need to know if any data exists
  const hasData = database.prepare("SELECT 1 FROM chunks LIMIT 1").get();
  if (!hasData) {
    // Check if anything is currently indexing
    const indexing = getIndexingSources();
    if (indexing.length > 0) {
      log.debug("no chunks yet, indexing in progress", { indexing });
      return { error: "indexing", sources: indexing };
    }
    log.debug("no chunks in db");
    return { error: "not_indexed", sources: options?.sources ?? [] };
  }

  // Check which sources are indexed or indexing
  if (sources && sources.length > 0) {
    const indexing = sources.filter((s) => indexingInProgress.has(s));
    if (indexing.length > 0) {
      log.info("sources indexing", { indexing });
      return { error: "indexing", sources: indexing };
    }

    const notIndexed = sources.filter((s) => !isIndexed(database, s));
    if (notIndexed.length > 0) {
      log.warn("sources not indexed", { notIndexed });
      return { error: "not_indexed", sources: notIndexed };
    }
  }

  // Embed query
  log.debug("embedding query");
  const queryEmbeddingResult = await embedQuery(query);
  if (queryEmbeddingResult.isErr()) {
    log.error("embed query failed", queryEmbeddingResult.error);
    return { error: "not_indexed", sources: [] };
  }

  // Search
  log.debug("searching");
  const searchResult = searchChunks(database, queryEmbeddingResult.value, { sources, topK });

  if (searchResult.isErr()) {
    log.error("search failed", searchResult.error);
    return { error: "not_indexed", sources: [] };
  }

  log.info("search done", { results: searchResult.value.length });
  return searchResult.value;
}

/**
 * Shutdown vector search
 */
export async function shutdownVector(): Promise<void> {
  if (db) {
    db.close();
    db = null;
    ready = false;
  }
}

// Re-export types
export type { SearchResult, SearchResponse, SearchOptions };

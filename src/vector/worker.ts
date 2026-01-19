import { parentPort } from "node:worker_threads";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import {
  initDB,
  isIndexed,
  markIndexed,
  insertChunks,
  searchChunks,
} from "./db.js";
import { initEmbedder, embedQuery, embedChunks } from "./embeddings.js";
import { chunk } from "./chunker/index.js";
import type { WorkerMessage, CodeChunk } from "./types.js";
import type Database from "better-sqlite3";

const BATCH_SIZE = 20; // Embed in batches to manage memory

// Supported file patterns
const FILE_PATTERNS = [
  "**/*.ts",
  "**/*.tsx",
  "**/*.js",
  "**/*.jsx",
  "**/*.mts",
  "**/*.cts",
  "**/*.mjs",
  "**/*.cjs",
  "**/*.rs",
  "**/*.md",
  "**/*.mdx",
  "**/*.markdown",
];

const IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/*.d.ts",
  "**/*.min.js",
  "**/dist/**",
  "**/build/**",
  "**/target/**", // Rust
  "**/CHANGELOG.md",
  "**/HISTORY.md",
];

let db: Database.Database | null = null;
let opensrcDir: string = "";

/**
 * Index a source - chunk files and generate embeddings
 */
async function indexSource(source: string, sourcePath: string): Promise<void> {
  if (!db) throw new Error("DB not initialized");

  // Skip if already indexed
  if (isIndexed(db, source)) {
    parentPort?.postMessage({ type: "indexed", source, skipped: true });
    return;
  }

  const files = await fg(FILE_PATTERNS, {
    cwd: sourcePath,
    ignore: IGNORE_PATTERNS,
    onlyFiles: true,
  });

  const allChunks: Array<{ chunk: CodeChunk; text: string }> = [];

  for (const file of files) {
    try {
      const content = await readFile(join(sourcePath, file), "utf8");
      const chunks = chunk(file, content);

      for (const c of chunks) {
        allChunks.push({ chunk: c, text: c.content });
      }
    } catch {
      // Skip unreadable files
    }
  }

  // Embed and insert in batches
  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE);
    const embeddings = await embedChunks(batch.map((b) => b.text));
    insertChunks(
      db,
      source,
      batch.map((b) => b.chunk),
      embeddings
    );
  }

  markIndexed(db, source);
  parentPort?.postMessage({ type: "indexed", source, skipped: false });
}

/**
 * Search indexed chunks
 */
async function handleSearch(
  id: string,
  query: string,
  options?: { sources?: string[]; topK?: number }
): Promise<void> {
  if (!db) {
    parentPort?.postMessage({
      type: "results",
      id,
      error: "not_indexed",
      sources: options?.sources ?? [],
    });
    return;
  }

  const { sources, topK = 20 } = options ?? {};

  // Check which sources are indexed
  if (sources && sources.length > 0) {
    const notIndexed = sources.filter((s) => !isIndexed(db!, s));
    if (notIndexed.length > 0) {
      parentPort?.postMessage({
        type: "results",
        id,
        error: "not_indexed",
        sources: notIndexed,
      });
      return;
    }
  }

  try {
    const queryEmbedding = await embedQuery(query);
    const results = searchChunks(db, queryEmbedding, { sources, topK });
    parentPort?.postMessage({ type: "results", id, results });
  } catch (err) {
    parentPort?.postMessage({
      type: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Handle messages from main thread
 */
parentPort?.on("message", async (msg: WorkerMessage) => {
  try {
    switch (msg.type) {
      case "init": {
        opensrcDir = msg.opensrcDir;
        db = initDB(opensrcDir);
        await initEmbedder();
        parentPort?.postMessage({ type: "ready" });
        break;
      }

      case "index": {
        // source.path already includes the relative path (e.g., "repos/github.com/owner/repo")
        const sourcePath = join(opensrcDir, msg.path);
        await indexSource(msg.source, sourcePath);
        break;
      }

      case "search": {
        await handleSearch(msg.id, msg.query, msg.options);
        break;
      }
    }
  } catch (err) {
    parentPort?.postMessage({
      type: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

import Database from "better-sqlite3";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { platform, arch } from "node:os";
import { existsSync, mkdirSync } from "node:fs";
import { Result } from "better-result";
import type { CodeChunk, SearchResult } from "./types.js";
import {
  UnsupportedPlatformError,
  VectorExtensionError,
  VectorExtensionNotAvailableError,
  DatabaseError,
} from "../errors.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const EMBEDDING_DIM = 768; // BGE-base dimension

// Track if vector extension is available
let vectorExtensionAvailable = false;

/**
 * Get platform-specific sqlite-vector extension path
 */
function getExtensionPath(): Result<string, UnsupportedPlatformError> {
  const p = platform();
  const a = arch();

  // Map Node.js platform/arch to extension names
  const platformMap: Record<string, string> = {
    darwin: "darwin",
    linux: "linux",
    win32: "win32",
  };

  const archMap: Record<string, string> = {
    x64: "x64",
    arm64: "arm64",
  };

  const plat = platformMap[p];
  const architecture = archMap[a];

  if (!plat || !architecture) {
    return Result.err(new UnsupportedPlatformError(p, a));
  }

  const ext = p === "win32" ? "dll" : p === "darwin" ? "dylib" : "so";

  // Try multiple locations
  const candidates = [
    join(__dirname, "..", "..", "libs", `vector.${plat}-${architecture}.${ext}`),
    join(__dirname, "..", "libs", `vector.${plat}-${architecture}.${ext}`),
    join(process.cwd(), "libs", `vector.${plat}-${architecture}.${ext}`),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return Result.ok(candidate);
    }
  }

  // Fall back to expecting it in PATH or system lib
  return Result.ok("vector");
}

/**
 * Initialize SQLite database with vector extension
 */
export function initDB(
  opensrcDir: string
): Result<Database.Database, UnsupportedPlatformError | VectorExtensionError> {
  // Ensure directory exists
  mkdirSync(opensrcDir, { recursive: true });

  const dbPath = join(opensrcDir, "vector.db");
  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent access across projects
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");

  // Get extension path
  const extPathResult = getExtensionPath();
  if (extPathResult.isErr()) {
    db.close();
    return extPathResult;
  }
  const extPath = extPathResult.value;

  // Load extension
  const loadResult = Result.try({
    try: () => {
      db.loadExtension(extPath);
      vectorExtensionAvailable = true;
    },
    catch: (cause) => new VectorExtensionError(extPath, cause),
  });

  if (loadResult.isErr()) {
    db.close();
    return loadResult;
  }

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS indexed_sources (
      name TEXT PRIMARY KEY,
      indexed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      file TEXT NOT NULL,
      identifier TEXT NOT NULL,
      kind TEXT NOT NULL,
      parent TEXT,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
  `);

  // Initialize vector search with COSINE distance (best for normalized embeddings)
  db.exec(`SELECT vector_init('chunks', 'embedding', 'type=FLOAT32,dimension=${EMBEDDING_DIM},distance=COSINE')`);

  // Preload existing quantized data if table has data
  const hasData = db.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as { cnt: number };
  if (hasData.cnt > 0) {
    Result.try(() => db.exec(`SELECT vector_quantize_preload('chunks', 'embedding')`));
  }

  return Result.ok(db);
}

/**
 * Check if a source is already indexed
 */
export function isIndexed(db: Database.Database, source: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM indexed_sources WHERE name = ?")
    .get(source);
  return row !== undefined;
}

/**
 * Mark a source as indexed
 */
export function markIndexed(db: Database.Database, source: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO indexed_sources (name, indexed_at) VALUES (?, ?)"
  ).run(source, new Date().toISOString());
}

/**
 * Convert Float32Array to JSON string for sqlite-vector
 */
function embeddingToJson(embedding: Float32Array): string {
  return JSON.stringify(Array.from(embedding));
}

/**
 * Insert chunks with embeddings (does NOT quantize - call finalizeVectorIndex after all batches)
 */
export function insertChunks(
  db: Database.Database,
  source: string,
  chunks: CodeChunk[],
  embeddings: Float32Array[]
): Result<void, VectorExtensionNotAvailableError | DatabaseError> {
  if (!vectorExtensionAvailable) {
    return Result.err(new VectorExtensionNotAvailableError());
  }

  return Result.try({
    try: () => {
      // Use vector_as_f32() wrapper for inserting embeddings
      const insert = db.prepare(`
        INSERT INTO chunks (source, file, identifier, kind, parent, start_line, end_line, content, embedding)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, vector_as_f32(?))
      `);

      const tx = db.transaction(() => {
        for (let i = 0; i < chunks.length; i++) {
          const c = chunks[i];
          const embeddingJson = embeddingToJson(embeddings[i]);
          insert.run(
            source,
            c.file,
            c.identifier,
            c.kind,
            c.parent ?? null,
            c.startLine,
            c.endLine,
            c.content,
            embeddingJson
          );
        }
      });

      tx();
    },
    catch: (cause) => new DatabaseError("insertChunks", cause),
  });
}

/**
 * Finalize vector index after all chunks are inserted.
 * This is expensive - call ONCE after all batches, not per-batch.
 */
export function finalizeVectorIndex(
  db: Database.Database
): Result<void, VectorExtensionNotAvailableError | DatabaseError> {
  if (!vectorExtensionAvailable) {
    return Result.err(new VectorExtensionNotAvailableError());
  }

  return Result.try({
    try: () => {
      db.exec(`SELECT vector_quantize('chunks', 'embedding')`);
      db.exec(`SELECT vector_quantize_preload('chunks', 'embedding')`);
    },
    catch: (cause) => new DatabaseError("finalizeVectorIndex", cause),
  });
}

/**
 * Check if vector extension is available
 */
export function isVectorExtensionAvailable(): boolean {
  return vectorExtensionAvailable;
}

/**
 * Search chunks using vector similarity
 */
export function searchChunks(
  db: Database.Database,
  queryEmbedding: Float32Array,
  options: { sources?: string[]; topK: number }
): Result<SearchResult[], VectorExtensionNotAvailableError | DatabaseError> {
  if (!vectorExtensionAvailable) {
    return Result.err(new VectorExtensionNotAvailableError());
  }

  return Result.try({
    try: () => {
      const { sources, topK } = options;
      const queryJson = embeddingToJson(queryEmbedding);

      let sql: string;
      const params: unknown[] = [];

      // IMPORTANT: Must use vector_as_f32() for query vector per sqlite-vector API
      // NOTE: sqlite-vector requires literal values for limit param, not placeholders
      if (sources && sources.length > 0) {
        // Filter by sources - use subquery approach
        const placeholders = sources.map(() => "?").join(",");
        sql = `
          SELECT c.source, c.file, c.identifier, c.kind, c.start_line, c.end_line, c.content, v.distance
          FROM chunks c
          JOIN vector_quantize_scan('chunks', 'embedding', vector_as_f32(?), ${topK * 2}) v ON c.id = v.rowid
          WHERE c.source IN (${placeholders})
          ORDER BY v.distance ASC
          LIMIT ${topK}
        `;
        params.push(queryJson, ...sources);
      } else {
        sql = `
          SELECT c.source, c.file, c.identifier, c.kind, c.start_line, c.end_line, c.content, v.distance
          FROM chunks c
          JOIN vector_quantize_scan('chunks', 'embedding', vector_as_f32(?), ${topK}) v ON c.id = v.rowid
          ORDER BY v.distance ASC
        `;
        params.push(queryJson);
      }

      const rows = db.prepare(sql).all(...params) as Array<{
        source: string;
        file: string;
        identifier: string;
        kind: string;
        start_line: number;
        end_line: number;
        content: string;
        distance: number;
      }>;

      return rows.map((r) => ({
        source: r.source,
        file: r.file,
        identifier: r.identifier,
        kind: r.kind as SearchResult["kind"],
        startLine: r.start_line,
        endLine: r.end_line,
        content: r.content,
        score: 1 - r.distance,
      }));
    },
    catch: (cause) => new DatabaseError("searchChunks", cause),
  });
}

/**
 * Delete all chunks for a source
 */
export function deleteSource(db: Database.Database, source: string): void {
  db.prepare("DELETE FROM chunks WHERE source = ?").run(source);
  db.prepare("DELETE FROM indexed_sources WHERE name = ?").run(source);
}

/**
 * Get list of all indexed sources
 */
export function getIndexedSources(db: Database.Database): string[] {
  const rows = db.prepare("SELECT name FROM indexed_sources").all() as Array<{
    name: string;
  }>;
  return rows.map((r) => r.name);
}

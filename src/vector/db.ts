import Database from "better-sqlite3";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { platform, arch } from "node:os";
import { existsSync } from "node:fs";
import type { CodeChunk, SearchResult } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const EMBEDDING_DIM = 768; // BGE-base dimension

// Track if vector extension is available
let vectorExtensionAvailable = false;

/**
 * Get platform-specific sqlite-vector extension path
 */
function getExtensionPath(): string {
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
    throw new Error(`Unsupported platform: ${p}-${a}`);
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
      return candidate;
    }
  }

  // Fall back to expecting it in PATH or system lib
  return `vector`;
}

/**
 * Initialize SQLite database with vector extension
 * Throws if sqlite-vector extension cannot be loaded
 */
export function initDB(opensrcDir: string): Database.Database {
  const dbPath = join(opensrcDir, "vector.db");
  const db = new Database(dbPath);

  // Load sqlite-vector extension (required)
  const extPath = getExtensionPath();
  try {
    db.loadExtension(extPath);
    vectorExtensionAvailable = true;
  } catch (err) {
    db.close();
    throw new Error(
      `sqlite-vector extension not found at ${extPath}. ` +
      `Download from https://github.com/sqliteai/sqlite-vector/releases and place in libs/. ` +
      `Original error: ${err}`
    );
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

  // Initialize vector search
  db.exec(`SELECT vector_init('chunks', 'embedding', 'type=FLOAT32,dimension=${EMBEDDING_DIM}')`);

  // Preload existing quantized data if table has data
  const hasData = db.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as { cnt: number };
  if (hasData.cnt > 0) {
    try {
      db.exec(`SELECT vector_quantize_preload('chunks', 'embedding')`);
    } catch {
      // Quantization not done yet or failed
    }
  }

  return db;
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
 * Insert chunks with embeddings
 */
export function insertChunks(
  db: Database.Database,
  source: string,
  chunks: CodeChunk[],
  embeddings: Float32Array[]
): void {
  if (!vectorExtensionAvailable) {
    throw new Error("sqlite-vector extension not available. See libs/README.md for installation.");
  }

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

  // Quantize and preload for vector search
  try {
    db.exec(`SELECT vector_quantize('chunks', 'embedding')`);
    db.exec(`SELECT vector_quantize_preload('chunks', 'embedding')`);
  } catch {
    // Quantization optional
  }
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
): SearchResult[] {
  if (!vectorExtensionAvailable) {
    throw new Error("sqlite-vector extension not available. See libs/README.md for installation.");
  }

  const { sources, topK } = options;
  const queryJson = embeddingToJson(queryEmbedding);

  let sql: string;
  const params: unknown[] = [];

  if (sources && sources.length > 0) {
    // Filter by sources - use subquery approach
    const placeholders = sources.map(() => "?").join(",");
    sql = `
      SELECT c.source, c.file, c.identifier, c.kind, c.start_line, c.end_line, c.content, v.distance
      FROM chunks c
      JOIN vector_quantize_scan('chunks', 'embedding', ?, ?) v ON c.id = v.rowid
      WHERE c.source IN (${placeholders})
      ORDER BY v.distance ASC
      LIMIT ?
    `;
    params.push(queryJson, topK * 2, ...sources, topK);
  } else {
    sql = `
      SELECT c.source, c.file, c.identifier, c.kind, c.start_line, c.end_line, c.content, v.distance
      FROM chunks c
      JOIN vector_quantize_scan('chunks', 'embedding', ?, ?) v ON c.id = v.rowid
      ORDER BY v.distance ASC
    `;
    params.push(queryJson, topK);
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

import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import fg, { type Entry } from "fast-glob";
import { Result } from "better-result";
import type { Source, FileEntry, GrepResult, ParsedSpec, FetchedSource, RemoveResult } from "../types.js";
import {
  SourceNotFoundError,
  PathTraversalError,
  FileReadError,
  FetchError,
  type SourceError,
  type FileSystemError,
} from "../errors.js";
import {
  getOpensrcDir,
  removeSourcesByName,
  cleanSourcesFiltered,
  writeSources,
  readSources,
} from "../sources.js";
import { getOpensrcCwd } from "../config.js";
import { fetchCommand } from "opensrc/dist/commands/fetch.js";
import { parsePackageSpec, detectInputType } from "opensrc/dist/lib/registries/index.js";
import { queueIndex, search as vectorSearch, type SearchResponse } from "../vector/index.js";
import { createLogger } from "../logger.js";

const log = createLogger("api");

interface OpensrcFetchResult {
  package: string;
  version: string;
  path: string;
  success: boolean;
  error?: string;
  registry?: "npm" | "pypi" | "crates";
}

export interface OpensrcAPI {
  // Read operations
  list(): Source[];
  has(name: string, version?: string): boolean;
  get(name: string): Result<Source, SourceNotFoundError>;
  files(sourceName: string, glob?: string): Promise<Result<FileEntry[], SourceNotFoundError>>;
  grep(pattern: string, options?: {
    sources?: string[];
    include?: string;
    maxResults?: number;
  }): Promise<GrepResult[]>;
  read(sourceName: string, filePath: string): Promise<Result<string, SourceError>>;
  resolve(spec: string): Promise<ParsedSpec>;

  // Vector search
  semanticSearch(query: string, options?: {
    sources?: string[];
    topK?: number;
  }): Promise<SearchResponse>;

  // Mutation operations
  fetch(specs: string | string[], options?: { modify?: boolean; }): Promise<Result<FetchedSource[], FetchError>>;
  remove(names: string[]): Promise<Result<RemoveResult, FileSystemError>>;
  clean(options?: {
    packages?: boolean;
    repos?: boolean;
    npm?: boolean;
    pypi?: boolean;
    crates?: boolean;
  }): Promise<Result<RemoveResult, FileSystemError>>;
  readMany(sourceName: string, paths: string[]): Promise<Result<Record<string, string>, SourceNotFoundError>>;
}

/**
 * Create unified opensrc API for the executor sandbox
 */
export function createOpensrcAPI(
  getSources: () => Source[],
  updateSources: (sources: Source[]) => void
): OpensrcAPI {
  const opensrcDir = getOpensrcDir();

  return {
    // ── Read Operations ──────────────────────────────────────────────────

    list: (): Source[] => getSources(),

    has: (name: string, version?: string): boolean => {
      const sources = getSources();
      return sources.some(
        (s) =>
          s.name === name &&
          (!version || s.version === version || s.ref === version)
      );
    },

    get: (name: string): Result<Source, SourceNotFoundError> => {
      const source = getSources().find((s) => s.name === name);
      if (!source) {
        return Result.err(new SourceNotFoundError(name));
      }
      return Result.ok(source);
    },

    files: async (
      sourceName: string,
      glob = "**/*"
    ): Promise<Result<FileEntry[], SourceNotFoundError>> => {
      const source = getSources().find((s) => s.name === sourceName);
      if (!source) {
        return Result.err(new SourceNotFoundError(sourceName));
      }

      const sourcePath = join(opensrcDir, source.path);
      const entries = await fg(glob, {
        cwd: sourcePath,
        dot: false,
        ignore: ["**/node_modules/**", "**/.git/**"],
        stats: true,
        onlyFiles: false,
      });

      return Result.ok(
        entries.map((e: Entry) => ({
          path: e.path,
          size: e.stats?.size ?? 0,
          isDirectory: e.stats?.isDirectory() ?? false,
        }))
      );
    },

    read: async (
      sourceName: string,
      filePath: string
    ): Promise<Result<string, SourceError>> => {
      log.debug("read", { source: sourceName, file: filePath });
      const source = getSources().find((s) => s.name === sourceName);
      if (!source) {
        log.warn("read failed: source not found", { source: sourceName });
        return Result.err(new SourceNotFoundError(sourceName));
      }

      const sourcePath = resolve(opensrcDir, source.path);
      const fullPath = resolve(sourcePath, filePath);

      // Verify resolved path is within source directory (path traversal protection)
      if (!fullPath.startsWith(sourcePath + "/") && fullPath !== sourcePath) {
        log.warn("read failed: path traversal", { path: fullPath });
        return Result.err(new PathTraversalError(fullPath));
      }

      return Result.tryPromise({
        try: () => readFile(fullPath, "utf8"),
        catch: (cause) => new FileReadError(fullPath, cause),
      });
    },

    grep: async (
      pattern: string,
      options: {
        sources?: string[];
        include?: string;
        maxResults?: number;
      } = {}
    ): Promise<GrepResult[]> => {
      const { sources: sourceFilter, include, maxResults = 100 } = options;
      log.debug("grep", { pattern, include, sources: sourceFilter, maxResults });
      const sources = getSources().filter(
        (s) => !sourceFilter || sourceFilter.includes(s.name)
      );

      const results: GrepResult[] = [];
      // Use 'i' flag only - no 'g' flag since we test line-by-line
      const regex = new RegExp(pattern, "i");

      for (const source of sources) {
        if (results.length >= maxResults) break;

        const sourcePath = join(opensrcDir, source.path);
        const files = await fg(include ?? "**/*", {
          cwd: sourcePath,
          ignore: ["**/node_modules/**", "**/.git/**", "**/*.min.js"],
          onlyFiles: true,
        });

        for (const file of files) {
          if (results.length >= maxResults) break;

          try {
            const content = await readFile(join(sourcePath, file), "utf8");
            const lines = content.split("\n");

            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                results.push({
                  source: source.name,
                  file,
                  line: i + 1,
                  content: lines[i].trim().slice(0, 200),
                });
                if (results.length >= maxResults) break;
              }
            }
          } catch {
            // skip unreadable files
          }
        }
      }

      return results;
    },

    resolve: async (spec: string): Promise<ParsedSpec> => {
      const inputType = detectInputType(spec);

      if (inputType === "repo") {
        const cleanSpec = spec
          .replace(/^github:/, "")
          .replace(/^https?:\/\/github\.com\//, "");
        const [ownerRepo, ref] = cleanSpec.split("@");
        return {
          type: "repo",
          name: `github.com/${ownerRepo}`,
          ref,
          repoUrl: `https://github.com/${ownerRepo}`,
        };
      }

      const parsed = parsePackageSpec(spec);
      return {
        type: parsed.registry,
        name: parsed.name,
        version: parsed.version,
      };
    },

    // ── Semantic Search ─────────────────────────────────────────────────

    semanticSearch: async (
      query: string,
      options?: { sources?: string[]; topK?: number; }
    ): Promise<SearchResponse> => {
      log.info("semanticSearch called", { query: query.slice(0, 50) });
      // vectorSearch already returns error states in SearchResponse, no need for try/catch
      const result = await vectorSearch(query, options);
      log.info("semanticSearch done", { resultCount: Array.isArray(result) ? result.length : "error" });
      return result;
    },

    // ── Mutation Operations ──────────────────────────────────────────────

    fetch: async (
      specs: string | string[],
      options: { modify?: boolean; } = {}
    ): Promise<Result<FetchedSource[], FetchError>> => {
      const specList = Array.isArray(specs) ? specs : [specs];
      log.info("fetch", { specs: specList, modify: options.modify });

      return Result.tryPromise({
        try: async () => {
          const opensrcResults: OpensrcFetchResult[] = await fetchCommand(
            specList,
            {
              cwd: getOpensrcCwd(),
              allowModifications: options.modify ?? false,
            }
          );
          log.debug("fetch results", { results: opensrcResults.map(r => ({ pkg: r.package, success: r.success })) });

          const newSources = await readSources();
          updateSources(newSources);

          const results: FetchedSource[] = [];

          for (const r of opensrcResults) {
            if (!r.success) {
              throw new FetchError(r.package, new Error(r.error ?? "Unknown fetch error"));
            }

            const source = newSources.find(
              (s) => s.name === r.package || s.path.includes(r.package)
            );

            if (!source) {
              throw new FetchError(r.package, new Error(`Source not found after fetch: ${r.package}`));
            }

            results.push({
              source,
              alreadyExists: false,
            });
          }

          // Queue successful fetches for vector indexing (non-blocking)
          for (const res of results) {
            queueIndex(res.source.name, res.source.path);
          }

          return results;
        },
        catch: (cause) => {
          if (cause instanceof FetchError) return cause;
          return new FetchError(specList.join(", "), cause);
        },
      });
    },

    remove: async (names: string[]): Promise<Result<RemoveResult, FileSystemError>> => {
      log.info("remove", { names });
      return Result.tryPromise({
        try: async () => {
          const sources = getSources();
          const removed = await removeSourcesByName(names, sources);
          log.debug("remove complete", { removed });
          const newSources = sources.filter((s) => !names.includes(s.name));
          updateSources(newSources);
          await writeSources(newSources);
          return { success: true, removed };
        },
        catch: (cause) => new FileReadError("remove operation", cause),
      });
    },

    clean: async (
      options: {
        packages?: boolean;
        repos?: boolean;
        npm?: boolean;
        pypi?: boolean;
        crates?: boolean;
      } = {}
    ): Promise<Result<RemoveResult, FileSystemError>> => {
      return Result.tryPromise({
        try: async () => {
          const sources = getSources();
          const removed = await cleanSourcesFiltered(sources, options);
          const newSources = sources.filter((s) => !removed.includes(s.name));
          updateSources(newSources);
          await writeSources(newSources);
          return { success: true, removed };
        },
        catch: (cause) => new FileReadError("clean operation", cause),
      });
    },

    readMany: async (
      sourceName: string,
      paths: string[]
    ): Promise<Result<Record<string, string>, SourceNotFoundError>> => {
      const source = getSources().find((s) => s.name === sourceName);
      if (!source) {
        return Result.err(new SourceNotFoundError(sourceName));
      }

      const sourcePath = resolve(opensrcDir, source.path);

      const readResults = await Promise.all(
        paths.map(async (filePath): Promise<[string, string]> => {
          const fullPath = resolve(sourcePath, filePath);

          // Verify resolved path is within source directory
          if (!fullPath.startsWith(sourcePath + "/") && fullPath !== sourcePath) {
            return [filePath, "[Error: Path traversal not allowed]"];
          }

          const result = await Result.tryPromise(() => readFile(fullPath, "utf8"));

          return result.match({
            ok: (content) => [filePath, content],
            err: (e) => [filePath, `[Error: ${e.message}]`],
          });
        })
      );

      return Result.ok(Object.fromEntries(readResults));
    },
  };
}

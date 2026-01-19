import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import fg, { type Entry } from "fast-glob";
import type { Source, FileEntry, GrepResult, ParsedSpec, FetchResult, RemoveResult } from "../types.js";
import {
  getOpensrcDir,
  removeSourcesByName,
  cleanSourcesFiltered,
  writeSources,
  readSources,
} from "../sources.js";
import { fetchCommand } from "opensrc/dist/commands/fetch.js";
import { parsePackageSpec, detectInputType } from "opensrc/dist/lib/registries/index.js";
import { queueIndex, search as vectorSearch, type SearchResponse } from "../vector/index.js";

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
  get(name: string): Source | undefined;
  files(sourceName: string, glob?: string): Promise<FileEntry[]>;
  grep(pattern: string, options?: {
    sources?: string[];
    include?: string;
    maxResults?: number;
  }): Promise<GrepResult[]>;
  read(sourceName: string, filePath: string): Promise<string>;
  resolve(spec: string): Promise<ParsedSpec>;

  // Semantic search
  search(query: string, options?: {
    sources?: string[];
    topK?: number;
  }): Promise<SearchResponse>;

  // Mutation operations
  fetch(specs: string | string[], options?: { modify?: boolean }): Promise<FetchResult[]>;
  remove(names: string[]): Promise<RemoveResult>;
  clean(options?: {
    packages?: boolean;
    repos?: boolean;
    npm?: boolean;
    pypi?: boolean;
    crates?: boolean;
  }): Promise<RemoveResult>;
  readMany(sourceName: string, paths: string[]): Promise<Record<string, string>>;
}

/**
 * Create unified opensrc API for the executor sandbox
 */
export function createOpensrcAPI(
  projectDir: string,
  getSources: () => Source[],
  updateSources: (sources: Source[]) => void
): OpensrcAPI {
  const opensrcDir = getOpensrcDir(projectDir);

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

    get: (name: string): Source | undefined =>
      getSources().find((s) => s.name === name),

    files: async (sourceName: string, glob = "**/*"): Promise<FileEntry[]> => {
      const source = getSources().find((s) => s.name === sourceName);
      if (!source) throw new Error(`Source not found: ${sourceName}`);

      const sourcePath = join(opensrcDir, source.path);
      const entries = await fg(glob, {
        cwd: sourcePath,
        dot: false,
        ignore: ["**/node_modules/**", "**/.git/**"],
        stats: true,
        onlyFiles: false,
      });

      return entries.map((e: Entry) => ({
        path: e.path,
        size: e.stats?.size ?? 0,
        isDirectory: e.stats?.isDirectory() ?? false,
      }));
    },

    read: async (sourceName: string, filePath: string): Promise<string> => {
      const source = getSources().find((s) => s.name === sourceName);
      if (!source) throw new Error(`Source not found: ${sourceName}`);

      const sourcePath = resolve(opensrcDir, source.path);
      const fullPath = resolve(sourcePath, filePath);

      // Verify resolved path is within source directory (path traversal protection)
      if (!fullPath.startsWith(sourcePath + "/") && fullPath !== sourcePath) {
        throw new Error("Path traversal not allowed");
      }

      return readFile(fullPath, "utf8");
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
      const sources = getSources().filter(
        (s) => !sourceFilter || sourceFilter.includes(s.name)
      );

      const results: GrepResult[] = [];
      // Use 'i' flag only - no 'g' flag since we test line-by-line
      // This avoids stateful lastIndex behavior
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
        // opensrc stores repos as "github.com/owner/repo"
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

    search: async (
      query: string,
      options?: { sources?: string[]; topK?: number }
    ): Promise<SearchResponse> => {
      return vectorSearch(query, options);
    },

    // ── Mutation Operations ──────────────────────────────────────────────

    fetch: async (
      specs: string | string[],
      options: { modify?: boolean } = {}
    ): Promise<FetchResult[]> => {
      const specList = Array.isArray(specs) ? specs : [specs];

      try {
        const opensrcResults: OpensrcFetchResult[] = await fetchCommand(
          specList,
          {
            cwd: projectDir,
            allowModifications: options.modify ?? false,
          }
        );

        const newSources = await readSources(projectDir);
        updateSources(newSources);

        const results = opensrcResults.map((r): FetchResult => {
          if (!r.success) {
            return { success: false, error: r.error ?? "Unknown fetch error" };
          }

          const source = newSources.find(
            (s) => s.name === r.package || s.path.includes(r.package)
          );

          if (!source) {
            return { success: false, error: `Source not found after fetch: ${r.package}` };
          }

          return {
            success: true,
            source,
            alreadyExists: false,
          };
        });

        // Queue successful fetches for vector indexing (non-blocking)
        for (const result of results) {
          if (result.success) {
            queueIndex(result.source.name, result.source.path);
          }
        }

        return results;
      } catch (err) {
        return [
          {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          },
        ];
      }
    },

    remove: async (names: string[]): Promise<RemoveResult> => {
      const sources = getSources();
      const removed = await removeSourcesByName(projectDir, names, sources);
      const newSources = sources.filter((s) => !names.includes(s.name));
      updateSources(newSources);
      await writeSources(projectDir, newSources);
      return { success: true, removed };
    },

    clean: async (
      options: {
        packages?: boolean;
        repos?: boolean;
        npm?: boolean;
        pypi?: boolean;
        crates?: boolean;
      } = {}
    ): Promise<RemoveResult> => {
      const sources = getSources();
      const removed = await cleanSourcesFiltered(projectDir, sources, options);
      const newSources = sources.filter((s) => !removed.includes(s.name));
      updateSources(newSources);
      await writeSources(projectDir, newSources);
      return { success: true, removed };
    },

    readMany: async (
      sourceName: string,
      paths: string[]
    ): Promise<Record<string, string>> => {
      const source = getSources().find((s) => s.name === sourceName);
      if (!source) throw new Error(`Source not found: ${sourceName}`);

      const sourcePath = resolve(opensrcDir, source.path);

      const readResults = await Promise.all(
        paths.map(async (filePath): Promise<[string, string]> => {
          try {
            const fullPath = resolve(sourcePath, filePath);

            // Verify resolved path is within source directory
            if (!fullPath.startsWith(sourcePath + "/") && fullPath !== sourcePath) {
              return [filePath, "[Error: Path traversal not allowed]"];
            }

            const content = await readFile(fullPath, "utf8");
            return [filePath, content];
          } catch (err) {
            return [filePath, `[Error: ${err instanceof Error ? err.message : String(err)}]`];
          }
        })
      );

      return Object.fromEntries(readResults);
    },
  };
}

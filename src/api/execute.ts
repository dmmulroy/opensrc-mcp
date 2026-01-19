import type { Source, FetchResult, RemoveResult } from "../types.js";
// Import opensrc's internal fetch command
// opensrc doesn't export from main, using internal path
import { fetchCommand } from "opensrc/dist/commands/fetch.js";
import {
  removeSourcesByName,
  cleanSourcesFiltered,
  writeSources,
  readSources,
  getOpensrcDir,
} from "../sources.js";
import { createSearchAPI } from "./search.js";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

interface OpensrcFetchResult {
  package: string;
  version: string;
  path: string;
  success: boolean;
  error?: string;
  registry?: "npm" | "pypi" | "crates";
}

/**
 * Convert opensrc's sources.json format to our Source format
 */
async function loadOpensrcSources(projectDir: string): Promise<Source[]> {
  const sourcesPath = join(getOpensrcDir(projectDir), "sources.json");
  if (!existsSync(sourcesPath)) return [];

  try {
    const content = await readFile(sourcesPath, "utf8");
    const data = JSON.parse(content);

    // opensrc uses { packages: [...], repos: [...] } format
    const sources: Source[] = [];

    for (const pkg of data.packages ?? []) {
      sources.push({
        type: pkg.registry ?? "npm",
        name: pkg.name,
        version: pkg.version,
        path: pkg.path.replace(/^opensrc\//, ""),
        fetchedAt: new Date().toISOString(),
        repository: pkg.repository ?? "",
      });
    }

    for (const repo of data.repos ?? []) {
      sources.push({
        type: "repo",
        name: repo.name,
        ref: repo.version,
        path: repo.path.replace(/^opensrc\//, ""),
        fetchedAt: repo.fetchedAt ?? new Date().toISOString(),
        repository: repo.name.startsWith("github.com")
          ? `https://${repo.name}`
          : `https://github.com/${repo.name}`,
      });
    }

    return sources;
  } catch {
    return [];
  }
}

/**
 * Create the execute API for the executor sandbox
 */
export function createExecuteAPI(
  projectDir: string,
  getSources: () => Source[],
  updateSources: (sources: Source[]) => void
) {
  return {
    /**
     * Fetch package(s) or repo(s) using opensrc
     */
    fetch: async (
      specs: string | string[],
      options: { modify?: boolean } = {}
    ): Promise<FetchResult[]> => {
      const specList = Array.isArray(specs) ? specs : [specs];

      try {
        // Use opensrc's fetchCommand
        const opensrcResults: OpensrcFetchResult[] = await fetchCommand(
          specList,
          {
            cwd: projectDir,
            allowModifications: options.modify ?? false,
          }
        );

        // Reload sources from opensrc's sources.json
        const newSources = await loadOpensrcSources(projectDir);
        updateSources(newSources);

        // Convert to our FetchResult format
        return opensrcResults.map((r) => {
          if (!r.success) {
            return { success: false, error: r.error };
          }

          const source = newSources.find(
            (s) => s.name === r.package || s.path.includes(r.package)
          );

          return {
            success: true,
            source,
            alreadyExists: false,
          };
        });
      } catch (err) {
        return [
          {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          },
        ];
      }
    },

    /**
     * Remove specific sources
     */
    remove: async (names: string[]): Promise<RemoveResult> => {
      const sources = getSources();
      const removed = await removeSourcesByName(projectDir, names, sources);
      const newSources = sources.filter((s) => !names.includes(s.name));
      updateSources(newSources);
      await writeSources(projectDir, newSources);
      return { success: true, removed };
    },

    /**
     * Clean all or filtered sources
     */
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

    /**
     * Batch read multiple files from a source
     */
    readMany: async (
      sourceName: string,
      paths: string[]
    ): Promise<Record<string, string>> => {
      const searchAPI = createSearchAPI(projectDir, getSources);
      const results: Record<string, string> = {};

      for (const path of paths) {
        try {
          results[path] = await searchAPI.read(sourceName, path);
        } catch (err) {
          results[path] = `[Error: ${err instanceof Error ? err.message : String(err)}]`;
        }
      }

      return results;
    },
  };
}

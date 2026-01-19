import { join } from "node:path";
import { readFile } from "node:fs/promises";
import fg, { type Entry } from "fast-glob";
import type { Source, FileEntry, GrepResult, ParsedSpec } from "../types.js";
import { getOpensrcDir } from "../sources.js";
// Use opensrc's parsing
import { parsePackageSpec, detectInputType } from "opensrc/dist/lib/registries/index.js";

/**
 * Create the search API for the executor sandbox
 */
export function createSearchAPI(
  projectDir: string,
  getSources: () => Source[]
) {
  const opensrcDir = getOpensrcDir(projectDir);

  return {
    /**
     * List all fetched sources
     */
    list: (): Source[] => getSources(),

    /**
     * Check if a package exists (by name, optionally version)
     */
    has: (name: string, version?: string): boolean => {
      const sources = getSources();
      return sources.some(
        (s) => s.name === name && (!version || s.version === version)
      );
    },

    /**
     * Get source by name
     */
    get: (name: string): Source | undefined =>
      getSources().find((s) => s.name === name),

    /**
     * List files in a fetched source
     */
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

    /**
     * Read a file from a source
     */
    read: async (sourceName: string, filePath: string): Promise<string> => {
      const source = getSources().find((s) => s.name === sourceName);
      if (!source) throw new Error(`Source not found: ${sourceName}`);

      // Prevent path traversal
      const normalizedPath = filePath.replace(/\.\./g, "");
      const fullPath = join(opensrcDir, source.path, normalizedPath);

      if (!fullPath.startsWith(join(opensrcDir, source.path))) {
        throw new Error("Path traversal not allowed");
      }

      return readFile(fullPath, "utf8");
    },

    /**
     * Search file contents across fetched sources
     */
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
      const regex = new RegExp(pattern, "gi");

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
              regex.lastIndex = 0; // reset for 'g' flag
            }
          } catch {
            // skip unreadable files
          }
        }
      }

      return results;
    },

    /**
     * Parse a package spec without fetching
     */
    resolve: async (spec: string): Promise<ParsedSpec> => {
      const inputType = detectInputType(spec);

      if (inputType === "repo") {
        // Extract owner/repo from spec
        const cleanSpec = spec
          .replace(/^github:/, "")
          .replace(/^https?:\/\/github\.com\//, "");
        const [ownerRepo, ref] = cleanSpec.split("@");
        return {
          type: "repo",
          name: ownerRepo.replace("/", "-"),
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
  };
}

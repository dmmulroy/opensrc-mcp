import { join, resolve, extname } from "node:path";
import { readFile } from "node:fs/promises";
import fg, { type Entry } from "fast-glob";
import { Lang, parse, type SgNode } from "@ast-grep/napi";
import type { Source, FileEntry, GrepResult, ParsedSpec, FetchedSource, RemoveResult, AstGrepMatch, AstGrepOptions, TreeNode } from "../types.js";
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
import { createLogger } from "../logger.js";

const log = createLogger("api");

// Extension → Lang mapping for ast-grep
const EXT_LANG: Record<string, Lang> = {
  ".js": Lang.JavaScript,
  ".mjs": Lang.JavaScript,
  ".cjs": Lang.JavaScript,
  ".jsx": Lang.JavaScript,
  ".ts": Lang.TypeScript,
  ".tsx": Lang.Tsx,
  ".html": Lang.Html,
  ".css": Lang.Css,
};

// String → Lang mapping (for options.lang)
const STR_LANG: Record<string, Lang> = {
  javascript: Lang.JavaScript,
  js: Lang.JavaScript,
  typescript: Lang.TypeScript,
  ts: Lang.TypeScript,
  tsx: Lang.Tsx,
  jsx: Lang.JavaScript,
  html: Lang.Html,
  css: Lang.Css,
};

// Extract metavar names from pattern (e.g. "$NAME", "$$$ARGS")
function parseMetavars(pattern: string): string[] {
  const matches = pattern.match(/\$+[A-Z_][A-Z0-9_]*/g) ?? [];
  return [...new Set(matches.map((m) => m.replace(/^\$+/, "")))];
}

// Extract captured metavars from matched node
function extractMetavars(
  node: SgNode,
  varNames: string[]
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of varNames) {
    const match = node.getMatch(name);
    if (match) {
      result[name] = match.text();
      continue;
    }
    // For $$$ multi-matches
    const multi = node.getMultipleMatches(name);
    if (multi.length > 0) {
      result[name] = multi.map((n) => n.text()).join(", ");
    }
  }
  return result;
}

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
  tree(sourceName: string, options?: { depth?: number; pattern?: string }): Promise<TreeNode>;
  grep(pattern: string, options?: {
    sources?: string[];
    include?: string;
    maxResults?: number;
  }): Promise<GrepResult[]>;
  astGrep(
    sourceName: string,
    pattern: string,
    options?: AstGrepOptions
  ): Promise<AstGrepMatch[]>;
  read(sourceName: string, filePath: string): Promise<string>;
  readMany(sourceName: string, paths: string[]): Promise<Record<string, string>>;
  resolve(spec: string): Promise<ParsedSpec>;

  // Mutation operations
  fetch(specs: string | string[], options?: { modify?: boolean; }): Promise<FetchedSource[]>;
  remove(names: string[]): Promise<RemoveResult>;
  clean(options?: {
    packages?: boolean;
    repos?: boolean;
    npm?: boolean;
    pypi?: boolean;
    crates?: boolean;
  }): Promise<RemoveResult>;
}

/**
 * Create unified opensrc API for the executor sandbox
 * Simple API: returns values directly, throws on errors
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

    get: (name: string): Source | undefined => {
      return getSources().find((s) => s.name === name);
    },

    files: async (sourceName: string, glob = "**/*"): Promise<FileEntry[]> => {
      const source = getSources().find((s) => s.name === sourceName);
      if (!source) {
        throw new Error(`Source not found: ${sourceName}`);
      }

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

    tree: async (
      sourceName: string,
      options: { depth?: number; pattern?: string } = {}
    ): Promise<TreeNode> => {
      const { depth = 3, pattern } = options;
      const source = getSources().find((s) => s.name === sourceName);
      if (!source) {
        throw new Error(`Source not found: ${sourceName}`);
      }

      const sourcePath = join(opensrcDir, source.path);

      // Get all entries up to depth
      const globPattern = pattern ?? Array(depth).fill("*").join("/");
      const entries = await fg([globPattern, ...Array(depth - 1).fill(0).map((_, i) => Array(i + 1).fill("*").join("/"))], {
        cwd: sourcePath,
        dot: false,
        ignore: ["**/node_modules/**", "**/.git/**"],
        onlyFiles: false,
        markDirectories: true,
      });

      // Build tree structure
      const root: TreeNode = { name: source.name, type: "dir", children: [] };
      const nodeMap = new Map<string, TreeNode>();
      nodeMap.set("", root);

      // Sort entries to ensure parents come before children
      const sortedEntries = [...entries].sort();

      for (const entry of sortedEntries) {
        const isDir = entry.endsWith("/");
        const path = isDir ? entry.slice(0, -1) : entry;
        const parts = path.split("/");
        const name = parts[parts.length - 1];
        const parentPath = parts.slice(0, -1).join("/");

        const node: TreeNode = {
          name,
          type: isDir ? "dir" : "file",
          ...(isDir ? { children: [] } : {}),
        };

        // Find or create parent
        let parent = nodeMap.get(parentPath);
        if (!parent) {
          // Create missing parent directories
          let currentPath = "";
          let currentParent = root;
          for (const part of parts.slice(0, -1)) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            let existing = nodeMap.get(currentPath);
            if (!existing) {
              existing = { name: part, type: "dir", children: [] };
              nodeMap.set(currentPath, existing);
              currentParent.children = currentParent.children ?? [];
              currentParent.children.push(existing);
            }
            currentParent = existing;
          }
          parent = currentParent;
        }

        parent.children = parent.children ?? [];
        parent.children.push(node);
        nodeMap.set(path, node);
      }

      return root;
    },

    read: async (sourceName: string, filePath: string): Promise<string> => {
      log.debug("read", { source: sourceName, file: filePath });
      const source = getSources().find((s) => s.name === sourceName);
      if (!source) {
        throw new Error(`Source not found: ${sourceName}`);
      }

      const sourcePath = resolve(opensrcDir, source.path);
      const fullPath = resolve(sourcePath, filePath);

      // Verify resolved path is within source directory (path traversal protection)
      if (!fullPath.startsWith(sourcePath + "/") && fullPath !== sourcePath) {
        throw new Error(`Path traversal not allowed: ${filePath}`);
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
      log.debug("grep", { pattern, include, sources: sourceFilter, maxResults });
      const sources = getSources().filter(
        (s) => !sourceFilter || sourceFilter.includes(s.name)
      );

      const results: GrepResult[] = [];
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

    astGrep: async (
      sourceName: string,
      pattern: string,
      options: AstGrepOptions = {}
    ): Promise<AstGrepMatch[]> => {
      const { glob: globPattern, lang, limit = 1000 } = options;
      log.debug("astGrep", { source: sourceName, pattern, lang, limit });

      // Validate source
      const source = getSources().find((s) => s.name === sourceName);
      if (!source) {
        throw new Error(`Source not found: ${sourceName}`);
      }

      // Normalize lang to array of Lang values
      const langs: Lang[] | null = lang
        ? (Array.isArray(lang) ? lang : [lang])
            .map((l) => STR_LANG[l.toLowerCase()])
            .filter((l): l is Lang => l !== undefined)
        : null;

      const sourcePath = resolve(opensrcDir, source.path);
      const matches: AstGrepMatch[] = [];
      const metavarNames = parseMetavars(pattern);

      // Get files using existing files() method logic
      const fileEntries = await fg(globPattern ?? "**/*", {
        cwd: sourcePath,
        dot: false,
        ignore: ["**/node_modules/**", "**/.git/**"],
        stats: true,
        onlyFiles: true,
      });

      for (const entry of fileEntries) {
        if (matches.length >= limit) break;

        const filePath = typeof entry === "string" ? entry : entry.path;
        const ext = extname(filePath);
        const extLang = EXT_LANG[ext];

        // Skip if lang specified but file extension doesn't match any
        if (langs && langs.length > 0 && !langs.includes(extLang)) continue;

        // Determine language from extension
        const fileLang = extLang;
        if (!fileLang) continue;

        // Parse and search
        try {
          const fullPath = resolve(sourcePath, filePath);

          // Path traversal check
          if (!fullPath.startsWith(sourcePath + "/") && fullPath !== sourcePath) {
            continue;
          }

          const content = await readFile(fullPath, "utf-8");
          const root = parse(fileLang, content).root();
          const nodes = root.findAll(pattern);

          for (const node of nodes) {
            if (matches.length >= limit) break;
            const range = node.range();
            matches.push({
              file: filePath,
              line: range.start.line + 1,
              column: range.start.column + 1,
              endLine: range.end.line + 1,
              endColumn: range.end.column + 1,
              text: node.text(),
              metavars: extractMetavars(node, metavarNames),
            });
          }
        } catch {
          // Skip unparseable files
          continue;
        }
      }

      log.debug("astGrep complete", { matches: matches.length });
      return matches;
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

    // ── Mutation Operations ──────────────────────────────────────────────

    fetch: async (
      specs: string | string[],
      options: { modify?: boolean; } = {}
    ): Promise<FetchedSource[]> => {
      const specList = Array.isArray(specs) ? specs : [specs];
      log.info("fetch", { specs: specList, modify: options.modify });

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
          throw new Error(`Failed to fetch ${r.package}: ${r.error ?? "Unknown error"}`);
        }

        const source = newSources.find(
          (s) => s.name === r.package || s.path.includes(r.package)
        );

        if (!source) {
          throw new Error(`Source not found after fetch: ${r.package}`);
        }

        results.push({
          source,
          alreadyExists: false,
        });
      }

      return results;
    },

    remove: async (names: string[]): Promise<RemoveResult> => {
      log.info("remove", { names });
      const sources = getSources();
      const removed = await removeSourcesByName(names, sources);
      log.debug("remove complete", { removed });
      const newSources = sources.filter((s) => !names.includes(s.name));
      updateSources(newSources);
      await writeSources(newSources);
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
      const removed = await cleanSourcesFiltered(sources, options);
      const newSources = sources.filter((s) => !removed.includes(s.name));
      updateSources(newSources);
      await writeSources(newSources);
      return { success: true, removed };
    },

    readMany: async (
      sourceName: string,
      paths: string[]
    ): Promise<Record<string, string>> => {
      const source = getSources().find((s) => s.name === sourceName);
      if (!source) {
        throw new Error(`Source not found: ${sourceName}`);
      }

      const sourcePath = resolve(opensrcDir, source.path);

      // Check if path contains glob characters
      const isGlob = (p: string) => /[*?[\]{}]/.test(p);

      // Expand globs to actual file paths
      const expandedPaths: string[] = [];
      for (const p of paths) {
        if (isGlob(p)) {
          const matches = await fg(p, {
            cwd: sourcePath,
            dot: false,
            ignore: ["**/node_modules/**", "**/.git/**"],
            onlyFiles: true,
          });
          expandedPaths.push(...matches);
        } else {
          expandedPaths.push(p);
        }
      }

      const readResults = await Promise.all(
        expandedPaths.map(async (filePath): Promise<[string, string]> => {
          const fullPath = resolve(sourcePath, filePath);

          // Verify resolved path is within source directory
          if (!fullPath.startsWith(sourcePath + "/") && fullPath !== sourcePath) {
            return [filePath, "[Error: Path traversal not allowed]"];
          }

          try {
            const content = await readFile(fullPath, "utf8");
            return [filePath, content];
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return [filePath, `[Error: ${msg}]`];
          }
        })
      );

      return Object.fromEntries(readResults);
    },
  };
}

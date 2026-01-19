import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Source } from "./types.js";
import { createExecutor } from "./executor.js";
import { createOpensrcAPI } from "./api/opensrc.js";
import { truncate } from "./truncate.js";
import pkg from "../package.json" with { type: "json" };

/**
 * Type declarations exposed to agent in tool description
 */
const TYPES = `
interface Source {
  type: "npm" | "pypi" | "crates" | "repo";
  name: string;
  version?: string;
  ref?: string;
  path: string;
  fetchedAt: string;
  repository: string;
}

interface FileEntry {
  path: string;
  size: number;
  isDirectory: boolean;
}

interface GrepResult {
  source: string;
  file: string;
  line: number;
  content: string;
}

interface ParsedSpec {
  type: "npm" | "pypi" | "crates" | "repo";
  name: string;
  version?: string;
  ref?: string;
  repoUrl?: string;
}

type FetchResult =
  | { success: true; source: Source; alreadyExists: boolean }
  | { success: false; error: string };

interface RemoveResult {
  success: boolean;
  removed: string[];
}

interface SearchResult {
  source: string;
  file: string;
  identifier: string;
  kind: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
}

type SearchResponse =
  | SearchResult[]
  | { error: "not_indexed"; sources: string[] };

declare const sources: Source[];
declare const cwd: string;

declare const opensrc: {
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

  // Semantic search (vector-based)
  search(query: string, options?: {
    sources?: string[];
    topK?: number;
  }): Promise<SearchResponse>;

  // Mutation operations
  fetch(specs: string | string[], options?: {
    modify?: boolean;
  }): Promise<FetchResult[]>;
  remove(names: string[]): Promise<RemoveResult>;
  clean(options?: {
    packages?: boolean;
    repos?: boolean;
    npm?: boolean;
    pypi?: boolean;
    crates?: boolean;
  }): Promise<RemoveResult>;
  readMany(sourceName: string, paths: string[]): Promise<Record<string, string>>;
};
`;

const PACKAGE_FORMATS = `
Fetch spec formats (input to opensrc.fetch):
- zod               -> npm package (latest or lockfile version)
- zod@3.22.0        -> npm specific version  
- pypi:requests     -> Python/PyPI package
- crates:serde      -> Rust/crates.io package
- vercel/ai         -> GitHub repo (default branch)
- vercel/ai@v3.0.0  -> GitHub repo at tag/branch/commit

Source names (returned in FetchResult.source.name, used for search/read):
- npm packages:  "zod", "drizzle-orm", "@tanstack/react-query"
- pypi packages: "requests", "numpy"  
- crates:        "serde", "tokio"
- GitHub repos:  "github.com/vercel/ai", "github.com/anthropics/sdk"
- GitLab repos:  "gitlab.com/owner/repo"

IMPORTANT: After fetching, always use result.source.name for subsequent API calls.
`;

const EXAMPLES = `
// List all fetched sources and their names
async () => {
  const sources = opensrc.list();
  return sources.map(s => ({ name: s.name, type: s.type, version: s.version || s.ref }));
}

// Fetch a package and get its source name for subsequent searches
async () => {
  const results = await opensrc.fetch("zod");
  const result = results[0];
  
  if (!result.success) return { error: result.error };
  
  // Use source.name in future search calls
  // For npm: name is "zod"
  // For repos: name is "github.com/owner/repo"
  return { 
    sourceName: result.source.name,
    type: result.source.type,
    path: result.source.path 
  };
}

// Fetch a GitHub repo and immediately explore its structure
async () => {
  const results = await opensrc.fetch("vercel/ai");
  const result = results[0];
  
  if (!result.success) return { error: result.error };
  
  // Repo source names include the host: "github.com/vercel/ai"
  const sourceName = result.source.name;
  
  // Now read key files
  const files = await opensrc.readMany(sourceName, [
    "package.json",
    "README.md",
    "src/index.ts"
  ]);
  
  return { sourceName, files };
}

// Fetch multiple packages at once
async () => {
  const results = await opensrc.fetch(["zod", "drizzle-orm", "hono"]);
  return results.map(r => r.success 
    ? { name: r.source.name, success: true }
    : { error: r.error, success: false }
  );
}

// Find where a function is defined, then read the implementation
async () => {
  const matches = await opensrc.grep("export function parse", { sources: ["zod"], include: "*.ts" });
  if (matches.length === 0) return "No matches found";
  
  const match = matches[0];
  const content = await opensrc.read(match.source, match.file);
  const lines = content.split("\\n");
  
  // Return 30 lines starting from the match
  return lines.slice(match.line - 1, match.line + 29).join("\\n");
}

// Search across all sources for error handling patterns
async () => {
  const results = await opensrc.grep("catch|throw new Error", { include: "*.ts", maxResults: 20 });
  return results.map(r => \`\${r.source}:\${r.file}:\${r.line} - \${r.content}\`);
}

// Explore a repo's structure and read key files
async () => {
  // Source names for repos are like "github.com/owner/repo"
  const name = "github.com/vercel/ai";
  
  // Find entry points
  const files = await opensrc.files(name, "**/{index,main,mod}.{ts,js}");
  
  // Read the first entry point found
  if (files.length > 0) {
    return await opensrc.read(name, files[0].path);
  }
  return "No entry point found";
}

// Find all exports from a package
async () => {
  const matches = await opensrc.grep("^export ", { sources: ["hono"], include: "src/**/*.ts" });
  return matches.map(m => m.content);
}

// Batch read related files from a source
async () => {
  const files = await opensrc.readMany("zod", [
    "src/index.ts",
    "src/types.ts", 
    "src/ZodError.ts",
    "src/helpers/parseUtil.ts"
  ]);
  
  // files is Record<string, string> - path -> content
  return Object.keys(files).filter(path => !files[path].startsWith("[Error:"));
}

// Clean up: remove specific sources or by type
async () => {
  // Remove specific packages
  await opensrc.remove(["zod", "github.com/vercel/ai"]);
  
  // Or clean by type
  // await opensrc.clean({ repos: true });  // remove all repos
  // await opensrc.clean({ npm: true });    // remove all npm packages
  
  return "Cleaned";
}

// Semantic search: find code by meaning, not exact text
async () => {
  // Search for code related to "parsing user input and validating schema"
  const results = await opensrc.search("parse and validate user input", {
    sources: ["zod"],
    topK: 10
  });
  
  // Returns SearchResult[] or { error: "not_indexed", sources: [...] }
  if ("error" in results) {
    return { error: results.error, notIndexed: results.sources };
  }
  
  return results.map(r => ({
    source: r.source,
    file: r.file,
    identifier: r.identifier,
    kind: r.kind,
    lines: \`\${r.startLine}-\${r.endLine}\`,
    score: r.score.toFixed(3)
  }));
}

// Search across all indexed sources
async () => {
  const results = await opensrc.search("error handling and retry logic");
  if ("error" in results) return results;
  
  // Read the top result's full content
  if (results.length > 0) {
    const top = results[0];
    const content = await opensrc.read(top.source, top.file);
    const lines = content.split("\\n");
    return lines.slice(top.startLine - 1, top.endLine).join("\\n");
  }
  return "No results";
}
`;

/**
 * Create and configure the MCP server
 */
export function createServer(
  projectDir: string,
  getSources: () => Source[],
  updateSources: (sources: Source[]) => void
): McpServer {
  const server = new McpServer({
    name: pkg.name,
    version: pkg.version,
  });

  // Create unified API
  const api = createOpensrcAPI(projectDir, getSources, updateSources);

  // Create executor
  const executor = createExecutor({
    projectDir,
    getSources,
    api,
  });

  // Register single unified tool
  server.tool(
    "execute",
    `Query and mutate fetched source code. Data stays server-side.

Types:
${TYPES}

${PACKAGE_FORMATS}

Examples:
${EXAMPLES}`,
    {
      code: z.string().describe("JavaScript async arrow function to execute"),
    },
    async ({ code }) => {
      const result = await executor(code);

      if (result.error) {
        return {
          content: [{ type: "text", text: `Error: ${result.error}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: truncate(result.result) }],
      };
    }
  );

  return server;
}

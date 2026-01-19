import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Source } from "./types.js";
import { createExecutor, type SearchAPI, type ExecuteAPI } from "./executor.js";
import { createSearchAPI } from "./api/search.js";
import { createExecuteAPI } from "./api/execute.js";
import { truncate } from "./truncate.js";

/**
 * Type declarations exposed to agent in tool descriptions
 */
const SEARCH_TYPES = `
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

declare const sources: Source[];
declare const cwd: string;

declare const opensrc: {
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
};
`;

const EXECUTE_TYPES = `
interface Source {
  type: "npm" | "pypi" | "crates" | "repo";
  name: string;
  version?: string;
  ref?: string;
  path: string;
  fetchedAt: string;
  repository: string;
}

interface FetchResult {
  success: boolean;
  source?: Source;
  error?: string;
  alreadyExists?: boolean;
}

interface RemoveResult {
  success: boolean;
  removed: string[];
}

declare const opensrc: {
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

const SEARCH_EXAMPLES = `
// List all fetched sources and their names
async () => {
  const sources = opensrc.list();
  return sources.map(s => ({ name: s.name, type: s.type, version: s.version || s.ref }));
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
`;

const EXECUTE_EXAMPLES = `
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
  return results.map(r => ({
    name: r.source?.name,
    success: r.success,
    error: r.error
  }));
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

/**
 * Create and configure the MCP server
 */
export function createServer(
  projectDir: string,
  getSources: () => Source[],
  updateSources: (sources: Source[]) => void
): McpServer {
  const server = new McpServer({
    name: "opensrc-mcp",
    version: "0.1.0",
  });

  // Create APIs
  const searchAPI: SearchAPI = createSearchAPI(projectDir, getSources);
  const executeAPI: ExecuteAPI = createExecuteAPI(
    projectDir,
    getSources,
    updateSources
  );

  // Create executors
  const searchExecutor = createExecutor({
    projectDir,
    getSources,
    mode: "search",
    api: searchAPI,
  });

  const executeExecutor = createExecutor({
    projectDir,
    getSources,
    mode: "execute",
    api: executeAPI,
  });

  // Register search tool
  server.tool(
    "search",
    `Query fetched source code without consuming context. Data stays server-side.

Types:
${SEARCH_TYPES}

Examples:
${SEARCH_EXAMPLES}`,
    {
      code: z.string().describe("JavaScript async arrow function to execute"),
    },
    async ({ code }) => {
      const result = await searchExecutor(code);

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

  // Register execute tool
  server.tool(
    "execute",
    `Perform mutations: fetch packages/repos, remove, clean, batch read.

Types:
${EXECUTE_TYPES}

${PACKAGE_FORMATS}

Examples:
${EXECUTE_EXAMPLES}`,
    {
      code: z.string().describe("JavaScript async arrow function to execute"),
    },
    async ({ code }) => {
      const result = await executeExecutor(code);

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

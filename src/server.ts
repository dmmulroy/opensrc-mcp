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
// List all fetched sources
async () => opensrc.list()

// Check if zod is fetched
async () => opensrc.has("zod")

// Find all TypeScript files in zod source
async () => opensrc.files("zod", "**/*.ts")

// Search for "parse" in zod source
async () => opensrc.grep("parse", { sources: ["zod"], include: "*.ts" })

// Read zod's main index
async () => opensrc.read("zod", "src/index.ts")

// Resolve a package spec without fetching
async () => opensrc.resolve("@tanstack/react-query@5.0.0")
`;

const EXECUTE_EXAMPLES = `
// Fetch a single npm package
async () => opensrc.fetch("zod")

// Fetch multiple packages
async () => opensrc.fetch(["zod", "drizzle-orm", "hono"])

// Fetch a GitHub repo at specific ref
async () => opensrc.fetch("vercel/ai@v3.0.0")

// Fetch PyPI package
async () => opensrc.fetch("pypi:requests==2.31.0")

// Remove a package
async () => opensrc.remove(["zod"])

// Clean all npm packages
async () => opensrc.clean({ npm: true })

// Read multiple files at once
async () => opensrc.readMany("zod", ["src/index.ts", "src/types.ts"])
`;

const PACKAGE_FORMATS = `
Package formats:
- <name>            -> npm (auto-detects version from lockfile)
- <name>@<version>  -> npm specific version
- npm:<name>        -> explicit npm
- pypi:<name>       -> Python/PyPI
- pip:<name>        -> alias for pypi
- crates:<name>     -> Rust/crates.io
- cargo:<name>      -> alias for crates
- owner/repo        -> GitHub repo
- owner/repo@ref    -> GitHub at ref
- github:owner/repo -> explicit GitHub
- gitlab:owner/repo -> GitLab repo
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

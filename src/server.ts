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

interface FetchedSource {
  source: Source;
  alreadyExists: boolean;
}

interface RemoveResult {
  success: boolean;
  removed: string[];
}

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

  // Mutation operations
  fetch(specs: string | string[], options?: {
    modify?: boolean;
  }): Promise<FetchedSource[]>;
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

Source names (returned in FetchedSource.source.name, used for read/grep):
- npm packages:  "zod", "drizzle-orm", "@tanstack/react-query"
- pypi packages: "requests", "numpy"  
- crates:        "serde", "tokio"
- GitHub repos:  "github.com/vercel/ai", "github.com/anthropics/sdk"

IMPORTANT: After fetching, always use source.name for subsequent API calls.
`;

const EXAMPLES = `
// List all fetched sources
async () => {
  return opensrc.list().map(s => ({ name: s.name, type: s.type, version: s.version || s.ref }));
}

// Fetch a package and explore it
async () => {
  const [{ source }] = await opensrc.fetch("zod");
  // Use source.name for all subsequent calls
  const files = await opensrc.files(source.name, "src/**/*.ts");
  return { name: source.name, fileCount: files.length };
}

// Fetch a GitHub repo and read key files
async () => {
  const [{ source }] = await opensrc.fetch("vercel/ai");
  // Repo names include host: "github.com/vercel/ai"
  
  const files = await opensrc.readMany(source.name, [
    "package.json",
    "README.md",
    "src/index.ts"
  ]);
  return { sourceName: source.name, files: Object.keys(files) };
}

// Fetch multiple packages
async () => {
  const results = await opensrc.fetch(["zod", "drizzle-orm", "hono"]);
  return results.map(r => r.source.name);
}

// Find function definition and read implementation
async () => {
  const matches = await opensrc.grep("export function parse", { sources: ["zod"], include: "*.ts" });
  if (matches.length === 0) return "No matches";
  
  const { source, file, line } = matches[0];
  const content = await opensrc.read(source, file);
  const lines = content.split("\\n");
  
  // Return 30 lines starting from match
  return lines.slice(line - 1, line + 29).join("\\n");
}

// Search across all sources
async () => {
  const results = await opensrc.grep("catch|throw new Error", { include: "*.ts", maxResults: 20 });
  return results.map(r => \`\${r.source}:\${r.file}:\${r.line}\`);
}

// Find entry points in a repo
async () => {
  const name = "github.com/vercel/ai";
  const files = await opensrc.files(name, "**/{index,main}.{ts,js}");
  
  if (files.length > 0) {
    return await opensrc.read(name, files[0].path);
  }
  return "No entry point found";
}

// Batch read related files
async () => {
  const files = await opensrc.readMany("zod", [
    "src/index.ts",
    "src/types.ts",
    "src/ZodError.ts"
  ]);
  // Files that failed have "[Error: ...]" as value
  return Object.keys(files).filter(p => !files[p].startsWith("[Error:"));
}

// Remove sources
async () => {
  const result = await opensrc.remove(["zod", "github.com/vercel/ai"]);
  return result.removed;
}
`;

/**
 * Create and configure the MCP server
 * @param cwd - Current working directory (project the user is in)
 */
export function createServer(
  cwd: string,
  getSources: () => Source[],
  updateSources: (sources: Source[]) => void
): McpServer {
  const server = new McpServer({
    name: pkg.name,
    version: pkg.version,
  });

  // Create unified API (uses global opensrc dir)
  const api = createOpensrcAPI(getSources, updateSources);

  // Create executor (cwd exposed to sandbox for project context)
  const executor = createExecutor({
    cwd,
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

      return result.match({
        ok: (value) => ({
          content: [{ type: "text", text: truncate(value) }],
        }),
        err: (error) => ({
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        }),
      });
    }
  );

  return server;
}

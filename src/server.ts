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

interface TreeNode {
  name: string;
  type: "file" | "dir";
  children?: TreeNode[];
}

interface GrepResult {
  source: string;
  file: string;
  line: number;
  content: string;
}

interface AstGrepMatch {
  file: string;
  line: number;
  column: number;
  text: string;
  metavars: Record<string, string>;  // captured $VAR values
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
  tree(sourceName: string, options?: { depth?: number }): Promise<TreeNode>;
  grep(pattern: string, options?: {
    sources?: string[];
    include?: string;
    maxResults?: number;
  }): Promise<GrepResult[]>;
  astGrep(sourceName: string, pattern: string, options?: {
    glob?: string;
    lang?: string | string[];
    limit?: number;
  }): Promise<AstGrepMatch[]>;
  read(sourceName: string, filePath: string): Promise<string>;
  readMany(sourceName: string, paths: string[]): Promise<Record<string, string>>;
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

// Fetch and explore structure with tree()
async () => {
  const [{ source }] = await opensrc.fetch("zod");
  return await opensrc.tree(source.name, { depth: 2 });
}

// Fetch a GitHub repo and read key files
async () => {
  const [{ source }] = await opensrc.fetch("vercel/ai");
  const files = await opensrc.readMany(source.name, [
    "package.json",
    "README.md",
    "src/index.ts"
  ]);
  return { sourceName: source.name, files: Object.keys(files) };
}

// readMany with globs
async () => {
  return await opensrc.readMany("zod", ["packages/*/package.json"]);
}

// Fetch multiple packages
async () => {
  const results = await opensrc.fetch(["zod", "drizzle-orm", "hono"]);
  return results.map(r => r.source.name);
}

// Text search with grep
async () => {
  const results = await opensrc.grep("export function parse", { sources: ["zod"], include: "*.ts" });
  if (matches.length === 0) return "No matches";
  const { source, file, line } = matches[0];
  const content = await opensrc.read(source, file);
  return content.split("\\n").slice(line - 1, line + 29).join("\\n");
}

// Search across all sources
async () => {
  const results = await opensrc.grep("throw new Error", { include: "*.ts", maxResults: 20 });
  return results.map(r => \`\${r.source}:\${r.file}:\${r.line}\`);
}

// AST search with astGrep (use $VAR for single node, $$$VAR for multiple)
// Patterns: "function $NAME($$$)" | "const $X = $Y" | "useState($INIT)" | "$OBJ.$METHOD($$$)"
async () => {
  const matches = await opensrc.astGrep("zod", "function $NAME($$$ARGS)", { glob: "**/*.ts", limit: 10 });
  return matches.map(m => ({ file: m.file, name: m.metavars.NAME, line: m.line }));
}

// Find entry points
async () => {
  const files = await opensrc.files("github.com/vercel/ai", "**/{index,main}.{ts,js}");
  if (files.length > 0) return await opensrc.read("github.com/vercel/ai", files[0].path);
  return "No entry point found";
}

// Batch read with error handling
async () => {
  const files = await opensrc.readMany("zod", ["src/index.ts", "src/types.ts", "nonexistent.ts"]);
  // Failed reads have "[Error: ...]" as value
  return Object.keys(files).filter(p => !files[p].startsWith("[Error:"));
}

// Remove sources
async () => {
  return await opensrc.remove(["zod", "github.com/vercel/ai"]);
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

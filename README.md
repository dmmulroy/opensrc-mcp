# opensrc-mcp

A codemode MCP server for fetching and querying dependency source code.

## Why?

Traditional MCP exposes tools directly to LLMs. This server uses the **codemode pattern**: agents write JavaScript that executes server-side, and only results return. Benefits:

- **Context efficient** - Large source trees stay server-side
- **Batch operations** - One call to search/read multiple files
- **LLMs are better at code** - More training data for JS than tool-calling

## Installation

```bash
npm install -g opensrc-mcp
# or
npx opensrc-mcp
```

## OpenCode Configuration

Add to your OpenCode config (`~/.config/opencode/config.json` or project `opencode.json`):

```json
{
  "mcp": {
    "opensrc": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "opensrc-mcp"]
    }
  }
}
```

## Tool

### `execute`

Single tool exposing all operations. Agents write JS that runs server-side; only results return.

```typescript
// Available in sandbox:
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
  fetch(specs: string | string[], options?: { modify?: boolean }): Promise<FetchedSource[]>;
  remove(names: string[]): Promise<RemoveResult>;
  clean(options?: {
    packages?: boolean;
    repos?: boolean;
    npm?: boolean;
    pypi?: boolean;
    crates?: boolean;
  }): Promise<RemoveResult>;
};

declare const sources: Source[];  // All fetched sources
declare const cwd: string;        // Project directory
```

**Examples:**

```javascript
// List all fetched sources
async () => opensrc.list()

// Fetch npm package (auto-detects version from lockfile)
async () => opensrc.fetch("zod")

// Fetch multiple packages
async () => opensrc.fetch(["zod", "drizzle-orm", "hono"])

// Fetch GitHub repo at specific ref
async () => opensrc.fetch("vercel/ai@v3.0.0")

// Fetch from other registries
async () => opensrc.fetch("pypi:requests")
async () => opensrc.fetch("crates:serde")

// Get directory tree
async () => opensrc.tree("zod", { depth: 2 })

// Find TypeScript files
async () => opensrc.files("zod", "**/*.ts")

// Text search
async () => opensrc.grep("parse", { sources: ["zod"], include: "*.ts" })

// AST search (structural pattern matching)
async () => opensrc.astGrep("zod", "function $NAME($$$ARGS)", { glob: "**/*.ts" })

// Read a specific file
async () => opensrc.read("zod", "src/index.ts")

// Read multiple files (supports globs)
async () => opensrc.readMany("zod", ["src/index.ts", "packages/*/package.json"])

// Remove a source
async () => opensrc.remove(["zod"])

// Clean all npm packages
async () => opensrc.clean({ npm: true })
```

## Package Formats

| Format | Example | Description |
|--------|---------|-------------|
| `<name>` | `zod` | npm (auto-detects version) |
| `<name>@<version>` | `zod@3.22.0` | npm specific version |
| `npm:<name>` | `npm:react` | explicit npm |
| `pypi:<name>` | `pypi:requests` | Python/PyPI |
| `pip:<name>` | `pip:flask` | alias for pypi |
| `crates:<name>` | `crates:serde` | Rust/crates.io |
| `cargo:<name>` | `cargo:tokio` | alias for crates |
| `owner/repo` | `vercel/ai` | GitHub repo |
| `owner/repo@ref` | `vercel/ai@v1.0.0` | GitHub at ref |
| `github:owner/repo` | `github:facebook/react` | explicit GitHub |

## Storage

Sources are stored globally at `~/.local/share/opensrc/` (XDG compliant):

```
~/.local/share/opensrc/
├── sources.json           # Index of fetched sources
├── packages/              # npm/pypi/crates packages
│   └── zod/
│       ├── src/
│       ├── package.json
│       └── ...
└── repos/                 # GitHub repos
    └── github.com/
        └── vercel/
            └── ai/
```

Override with `$OPENSRC_DIR` or `$XDG_DATA_HOME`.

## How It Works

1. Agent calls `execute` tool with JS code: `async () => opensrc.fetch("zod")`
2. Code runs in sandboxed `vm` context with injected `opensrc` API
3. Server fetches package via [opensrc](https://github.com/vercel-labs/opensrc) (handles registry lookup, git clone)
4. Only the result returns to agent context

```
┌─────────────────────────────────────────────────────────────┐
│                      Agent Context                          │
├─────────────────────────────────────────────────────────────┤
│  Tool call: execute({ code: "async () => opensrc.fetch..." })│
│                           ↓                                 │
│  Result: { success: true, source: { name: "zod", ... } }    │
└─────────────────────────────────────────────────────────────┘
                            ↕
┌─────────────────────────────────────────────────────────────┐
│                    opensrc-mcp Server                       │
├─────────────────────────────────────────────────────────────┤
│  Sandbox executes code with injected opensrc API            │
│  Full source tree stays here, never sent to agent           │
└─────────────────────────────────────────────────────────────┘
```

## License

MIT

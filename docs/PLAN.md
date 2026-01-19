# opensrc-mcp: Codemode MCP Server

A codemode-based MCP server for [opensrc](https://github.com/vercel-labs/opensrc) - fetch and query dependency source code for AI agents.

## Problem

opensrc is CLI-only. Agents must shell out, parse stdout, discover file trees via multiple reads. Friction.

**Codemode pattern inverts this:** agent writes JS that executes server-side against registry APIs, git, and cached source trees. Only results return.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      opensrc-mcp                                │
├─────────────────────────────────────────────────────────────────┤
│  search   │  Query sources.json, search file trees, list pkgs   │
│  execute  │  Fetch packages, remove, clean, read source files   │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   npm registry          pypi API           crates.io API
        │                     │                     │
        └──────────┬──────────┴──────────┬──────────┘
                   ▼                     ▼
              git clone           local source tree
                                  (opensrc/repos/)
```

---

## Tool Design

### Tool 1: `search`

Query metadata and source code without consuming context.

**Types exposed to agent:**

```typescript
interface Source {
  type: "npm" | "pypi" | "crates" | "repo";
  name: string;
  version?: string;
  ref?: string;
  path: string;         // relative path in opensrc/repos/
  fetchedAt: string;    // ISO timestamp
  repository: string;   // full repo URL
}

interface FileEntry {
  path: string;
  size: number;
  isDirectory: boolean;
}

declare const sources: Source[];
declare const cwd: string;  // project working directory

declare const opensrc: {
  // List all fetched sources
  list(): Source[];
  
  // Check if package exists (by name, optionally version)
  has(name: string, version?: string): boolean;
  
  // Get source by name
  get(name: string): Source | undefined;
  
  // List files in a fetched source (respects .gitignore)
  files(sourceName: string, glob?: string): Promise<FileEntry[]>;
  
  // Search file contents across fetched sources
  grep(pattern: string, options?: {
    sources?: string[];  // filter to specific sources
    include?: string;    // glob pattern for files
    maxResults?: number;
  }): Promise<Array<{
    source: string;
    file: string;
    line: number;
    content: string;
  }>>;
  
  // Read file from source (returns content)
  read(sourceName: string, filePath: string): Promise<string>;
  
  // Parse package spec (doesn't fetch, just resolves)
  resolve(spec: string): Promise<{
    type: "npm" | "pypi" | "crates" | "repo";
    name: string;
    version?: string;
    ref?: string;
    repoUrl?: string;
  }>;
};
```

**Examples:**

```typescript
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
```

### Tool 2: `execute`

Mutations: fetch, remove, clean, batch operations.

**Types exposed to agent:**

```typescript
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
  // Fetch package(s) or repo(s)
  fetch(specs: string | string[], options?: {
    modify?: boolean;  // allow file modifications (default: false)
  }): Promise<FetchResult[]>;
  
  // Remove specific sources
  remove(names: string[]): Promise<RemoveResult>;
  
  // Clean all or filtered sources
  clean(options?: {
    packages?: boolean;  // only packages
    repos?: boolean;     // only repos
    npm?: boolean;
    pypi?: boolean;
    crates?: boolean;
  }): Promise<RemoveResult>;
  
  // Batch read multiple files (efficient for understanding a package)
  readMany(sourceName: string, paths: string[]): Promise<Record<string, string>>;
};
```

**Examples:**

```typescript
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
async () => opensrc.readMany("zod", ["src/index.ts", "src/types.ts", "src/ZodError.ts"])
```

**Package formats:**

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
| `gitlab:owner/repo` | `gitlab:inkscape/inkscape` | GitLab repo |

---

## Implementation

### Runtime

Node.js with stdio transport (primary). HTTP/SSE optional for remote.

### Sandboxed Execution (Native `vm`)

```typescript
// src/executor.ts
import { createContext, runInContext, Script } from 'node:vm';
import { Source } from './types';
import { createSearchAPI } from './api/search';
import { createExecuteAPI } from './api/execute';

interface ExecutorResult {
  result?: unknown;
  error?: string;
}

export function createExecutor(
  projectDir: string,
  getSources: () => Source[],
  updateSources: (sources: Source[]) => void,
  mode: 'search' | 'execute'
) {
  return async (code: string): Promise<ExecutorResult> => {
    // Build API based on mode
    const api = mode === 'search'
      ? createSearchAPI(projectDir, getSources)
      : createExecuteAPI(projectDir, getSources, updateSources);

    // Freeze API to prevent modification
    const frozenAPI = deepFreeze({
      opensrc: api,
      sources: getSources(),
      cwd: projectDir,
    });

    // Create isolated context
    const context = createContext({
      ...frozenAPI,
      // Minimal safe globals
      console: Object.freeze({ log: () => {}, warn: () => {}, error: () => {} }),
      JSON: Object.freeze({ parse: JSON.parse, stringify: JSON.stringify }),
      Object: Object.freeze({ 
        keys: Object.keys, 
        values: Object.values, 
        entries: Object.entries,
        fromEntries: Object.fromEntries,
      }),
      Array: Object.freeze({ isArray: Array.isArray }),
      Promise: Promise,
      setTimeout: undefined,
      setInterval: undefined,
      setImmediate: undefined,
      fetch: undefined,
      require: undefined,
      process: undefined,
      global: undefined,
      globalThis: undefined,
    });

    try {
      // Compile with timeout
      const script = new Script(`(${code})()`, {
        timeout: 30000,
        filename: 'agent-code.js',
      });

      // Execute and await result
      const resultPromise = script.runInContext(context, {
        timeout: 30000,
        breakOnSigint: true,
      });

      // Handle async results with timeout
      const result = await Promise.race([
        resultPromise,
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Execution timeout (30s)')), 30000)
        ),
      ]);

      return { result };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };
}

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  
  Object.getOwnPropertyNames(obj).forEach(prop => {
    const value = (obj as Record<string, unknown>)[prop];
    if (value && typeof value === 'object') {
      deepFreeze(value);
    }
  });
  
  return Object.freeze(obj);
}
```

### Security Measures

| Measure | Why |
|---------|-----|
| `createContext()` | Isolated global scope, no access to Node globals |
| `deepFreeze()` | Prevent prototype pollution via API objects |
| Explicit undefined for dangerous globals | Block `setTimeout`, `fetch`, `require`, `process` |
| Script timeout | Prevent infinite loops |
| Promise.race timeout | Catch hanging async operations |
| Controlled API surface | Agent only calls our functions |

### Response Truncation

```typescript
// src/truncate.ts
const MAX_TOKENS = 8000;
const CHARS_PER_TOKEN = 4;

export function truncate(content: unknown): string {
  const text = typeof content === 'string' 
    ? content 
    : JSON.stringify(content, null, 2);
  
  const maxChars = MAX_TOKENS * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  
  return `${text.slice(0, maxChars)}

--- TRUNCATED ---
~${Math.ceil(text.length / CHARS_PER_TOKEN)} tokens. Use opensrc.files() to find specific files, then opensrc.read() for targeted content.`;
}
```

---

## File Structure

```
src/
├── index.ts              # MCP server entry, stdio transport
├── server.ts             # Tool registration
├── executor.ts           # Sandboxed code execution
├── truncate.ts           # Response size management
├── types.ts              # Shared types
├── api/
│   ├── search.ts         # Search API implementation
│   ├── execute.ts        # Execute API implementation
│   ├── files.ts          # File tree operations
│   └── grep.ts           # Content search
├── registries/
│   ├── index.ts          # Registry dispatcher
│   ├── parse.ts          # Spec parsing
│   ├── npm.ts            # npm registry + version detection
│   ├── pypi.ts           # PyPI registry
│   └── crates.ts         # crates.io registry
├── git.ts                # Clone, tag resolution
└── sources.ts            # sources.json management

package.json
tsconfig.json
```

---

## API Implementations

### Search API

```typescript
// src/api/search.ts
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import fg from 'fast-glob';
import { Source, FileEntry, GrepResult } from '../types';

export function createSearchAPI(projectDir: string, getSources: () => Source[]) {
  const opensrcDir = join(projectDir, 'opensrc');

  return {
    list: () => getSources(),

    has: (name: string, version?: string) => {
      const sources = getSources();
      return sources.some(s => 
        s.name === name && (!version || s.version === version)
      );
    },

    get: (name: string) => getSources().find(s => s.name === name),

    files: async (sourceName: string, glob = '**/*'): Promise<FileEntry[]> => {
      const source = getSources().find(s => s.name === sourceName);
      if (!source) throw new Error(`Source not found: ${sourceName}`);

      const sourcePath = join(opensrcDir, source.path);
      const entries = await fg(glob, {
        cwd: sourcePath,
        dot: false,
        ignore: ['**/node_modules/**', '**/.git/**'],
        stats: true,
        onlyFiles: false,
      });

      return entries.map(e => ({
        path: typeof e === 'string' ? e : e.path,
        size: typeof e === 'string' ? 0 : (e.stats?.size ?? 0),
        isDirectory: typeof e === 'string' ? false : (e.stats?.isDirectory() ?? false),
      }));
    },

    read: async (sourceName: string, filePath: string): Promise<string> => {
      const source = getSources().find(s => s.name === sourceName);
      if (!source) throw new Error(`Source not found: ${sourceName}`);

      // Prevent path traversal
      const normalizedPath = filePath.replace(/\.\./g, '');
      const fullPath = join(opensrcDir, source.path, normalizedPath);
      
      if (!fullPath.startsWith(join(opensrcDir, source.path))) {
        throw new Error('Path traversal not allowed');
      }

      return readFile(fullPath, 'utf8');
    },

    grep: async (
      pattern: string, 
      options: { sources?: string[]; include?: string; maxResults?: number } = {}
    ): Promise<GrepResult[]> => {
      const { sources: sourceFilter, include, maxResults = 100 } = options;
      const sources = getSources().filter(s => 
        !sourceFilter || sourceFilter.includes(s.name)
      );

      const results: GrepResult[] = [];
      const regex = new RegExp(pattern, 'gi');

      for (const source of sources) {
        if (results.length >= maxResults) break;

        const sourcePath = join(opensrcDir, source.path);
        const files = await fg(include || '**/*', {
          cwd: sourcePath,
          ignore: ['**/node_modules/**', '**/.git/**', '**/*.min.js'],
          onlyFiles: true,
        });

        for (const file of files) {
          if (results.length >= maxResults) break;

          try {
            const content = await readFile(join(sourcePath, file), 'utf8');
            const lines = content.split('\n');
            
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

    resolve: async (spec: string) => {
      const { parseSpec } = await import('../registries/parse');
      return parseSpec(spec);
    },
  };
}
```

### Execute API

```typescript
// src/api/execute.ts
import { Source, FetchResult, RemoveResult } from '../types';
import { fetchPackage } from '../registries';
import { removeSource, cleanSources } from '../sources';
import { createSearchAPI } from './search';

export function createExecuteAPI(
  projectDir: string,
  getSources: () => Source[],
  updateSources: (sources: Source[]) => void
) {
  return {
    fetch: async (
      specs: string | string[], 
      options: { modify?: boolean } = {}
    ): Promise<FetchResult[]> => {
      const specList = Array.isArray(specs) ? specs : [specs];
      const results: FetchResult[] = [];

      for (const spec of specList) {
        try {
          const result = await fetchPackage(spec, projectDir, options);
          if (result.source) {
            const sources = getSources();
            const idx = sources.findIndex(s => s.name === result.source!.name);
            if (idx >= 0) {
              sources[idx] = result.source;
            } else {
              sources.push(result.source);
            }
            updateSources(sources);
          }
          results.push(result);
        } catch (err) {
          results.push({ 
            success: false, 
            error: err instanceof Error ? err.message : String(err) 
          });
        }
      }

      return results;
    },

    remove: async (names: string[]): Promise<RemoveResult> => {
      const removed = await removeSource(projectDir, names);
      const sources = getSources().filter(s => !names.includes(s.name));
      updateSources(sources);
      return { success: true, removed };
    },

    clean: async (options: {
      packages?: boolean;
      repos?: boolean;
      npm?: boolean;
      pypi?: boolean;
      crates?: boolean;
    } = {}): Promise<RemoveResult> => {
      const removed = await cleanSources(projectDir, getSources(), options);
      const sources = getSources().filter(s => !removed.includes(s.name));
      updateSources(sources);
      return { success: true, removed };
    },

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
```

---

## Version Detection (npm)

```typescript
// src/registries/npm.ts
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export async function detectVersion(
  pkgName: string, 
  projectDir: string
): Promise<string | null> {
  // 1. node_modules
  const nmPath = join(projectDir, 'node_modules', pkgName, 'package.json');
  if (existsSync(nmPath)) {
    const pkg = JSON.parse(await readFile(nmPath, 'utf8'));
    return pkg.version;
  }

  // 2. package-lock.json
  const lockPath = join(projectDir, 'package-lock.json');
  if (existsSync(lockPath)) {
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    // npm v7+ format
    if (lock.packages?.[`node_modules/${pkgName}`]?.version) {
      return lock.packages[`node_modules/${pkgName}`].version;
    }
    // npm v6 format
    if (lock.dependencies?.[pkgName]?.version) {
      return lock.dependencies[pkgName].version;
    }
  }

  // 3. pnpm-lock.yaml
  const pnpmPath = join(projectDir, 'pnpm-lock.yaml');
  if (existsSync(pnpmPath)) {
    const content = await readFile(pnpmPath, 'utf8');
    // Simple regex extraction - could use yaml parser
    const match = content.match(new RegExp(`${pkgName}@([\\d.]+):`));
    if (match) return match[1];
  }

  // 4. yarn.lock
  const yarnPath = join(projectDir, 'yarn.lock');
  if (existsSync(yarnPath)) {
    const content = await readFile(yarnPath, 'utf8');
    const match = content.match(new RegExp(`"${pkgName}@[^"]+":\\s+version "([^"]+)"`));
    if (match) return match[1];
  }

  // 5. package.json (strip semver prefixes)
  const pkgJsonPath = join(projectDir, 'package.json');
  if (existsSync(pkgJsonPath)) {
    const pkg = JSON.parse(await readFile(pkgJsonPath, 'utf8'));
    const version = pkg.dependencies?.[pkgName] || pkg.devDependencies?.[pkgName];
    if (version) {
      return version.replace(/^[\^~>=<]+/, '');
    }
  }

  return null;
}
```

---

## Git Operations

```typescript
// src/git.ts
import simpleGit from 'simple-git';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

const git = simpleGit();

export async function resolveTag(repoUrl: string, version: string): Promise<string> {
  const refs = await git.listRemote(['--tags', repoUrl]);
  
  // Try v{version}, then {version}
  const candidates = [`v${version}`, version];
  for (const tag of candidates) {
    if (refs.includes(`refs/tags/${tag}`)) {
      return tag;
    }
  }
  
  // Fallback to default branch
  return 'HEAD';
}

export async function cloneRepo(
  repoUrl: string,
  destPath: string,
  ref?: string
): Promise<void> {
  const cloneOptions = ['--depth', '1'];
  
  if (ref && ref !== 'HEAD') {
    cloneOptions.push('--branch', ref);
  }

  await git.clone(repoUrl, destPath, cloneOptions);
  
  // Remove .git directory
  await rm(join(destPath, '.git'), { recursive: true, force: true });
}

export function normalizeGitUrl(url: string): string {
  return url
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^git@gitlab\.com:/, 'https://gitlab.com/');
}
```

---

## Dependencies

```json
{
  "name": "opensrc-mcp",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "opensrc-mcp": "dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.25.2",
    "fast-glob": "^3.3.2",
    "simple-git": "^3.22.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.8.0"
  }
}
```

---

## Context Efficiency

| Operation | CLI spawn | Codemode MCP |
|-----------|-----------|--------------|
| Check pkg exists | spawn + parse stdout | `opensrc.has("zod")` -> bool |
| List files | spawn + glob + read | `opensrc.files("zod", "*.ts")` -> array |
| Search content | spawn rg + parse | `opensrc.grep(...)` -> results only |
| Fetch package | spawn + wait | `opensrc.fetch("zod")` -> result |
| Read file | spawn cat | `opensrc.read("zod", "src/index.ts")` -> content |
| Batch read | N spawns | `opensrc.readMany(...)` -> single call |

---

## Implementation Phases

### Phase 1: Core Infrastructure
- [ ] MCP server skeleton w/ stdio transport
- [ ] sources.json read/write
- [ ] Sandboxed executor with native vm
- [ ] Response truncation
- [ ] Types

### Phase 2: Search Tool
- [ ] `opensrc.list()`, `has()`, `get()`
- [ ] `opensrc.files()` with fast-glob
- [ ] `opensrc.grep()` with regex
- [ ] `opensrc.read()`
- [ ] `opensrc.resolve()`
- [ ] Tool registration w/ types + examples

### Phase 3: Execute Tool
- [ ] Spec parsing (all formats)
- [ ] npm registry + version detection
- [ ] pypi registry
- [ ] crates.io registry
- [ ] Git clone + tag resolution
- [ ] `opensrc.fetch()` single + batch
- [ ] `opensrc.remove()`
- [ ] `opensrc.clean()`
- [ ] `opensrc.readMany()`
- [ ] Tool registration w/ types + examples

### Phase 4: Polish
- [ ] Monorepo path handling (repository.directory)
- [ ] Error messages with recovery hints
- [ ] Settings persistence (honor existing opensrc/settings.json)
- [ ] HTTP/SSE transport (optional)
- [ ] Tests

---

## Open Questions

1. **Concurrent fetch** - parallel clones or sequential? Risk of rate limiting.
2. **Cache invalidation** - detect lockfile version change since last fetch?
3. **Large file handling** - truncate individual reads? Warn >X bytes?
4. **GitLab support** - include or defer? Lower usage than GitHub.
5. **Settings** - honor `opensrc/settings.json` or separate MCP config?

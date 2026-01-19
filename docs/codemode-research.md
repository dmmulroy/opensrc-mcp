
# Codemode MCP Architecture Guide

A guide for implementing high-performance, context-efficient MCP servers based on the cloudflare-mcp architecture.

---

## The Problem This Architecture Solves

Traditional MCP servers face a fundamental tension:

| Approach | Problem |
|----------|---------|
| One tool per endpoint | Massive tool list bloats context (1000s of tools) |
| Full spec in description | Leaks entire API documentation to agent context |
| Pagination/filtering | Multiple round-trips, agent must understand API structure |

**The cloudflare-mcp solution**: Agents write code that executes server-side against the data. Only results return to the agent.

```
Full OpenAPI spec:     ~2,352,000 tokens
Compressed summaries:     ~43,000 tokens
Typical search result:       ~500 tokens  <-- What actually reaches the agent
```

---

## Core Architecture

### 1. Two-Tool Meta Pattern

Instead of N tools for N endpoints, expose **two meta-tools**:

```
┌─────────────────────────────────────────────────────────────┐
│                         MCP Server                          │
├─────────────────────────────────────────────────────────────┤
│  search     │  Agent writes JS to query spec/schema/data    │
│  execute    │  Agent writes JS to perform actions           │
└─────────────────────────────────────────────────────────────┘
```

**Why this works:**
- Agent learns the pattern once, applies everywhere
- Large data (specs, schemas, docs) stays server-side
- Only query results consume agent context
- Agent has full programmatic power over queries

### 2. Code Execution via Worker Isolation

The server dynamically creates sandboxed workers for each code execution:

```typescript
// executor.ts pattern
export function createCodeExecutor(env: Env) {
  return async (code: string, accountId: string, apiToken: string) => {
    const workerId = `executor-${crypto.randomUUID()}`;
    
    // Dynamic worker with injected context
    const worker = env.LOADER.get(workerId, () => ({
      compatibilityDate: "2026-01-12",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "worker.js",
      modules: {
        "worker.js": `
import { WorkerEntrypoint } from "cloudflare:workers";

// Inject server-side data as constants
const accountId = ${JSON.stringify(accountId)};

export default class CodeExecutor extends WorkerEntrypoint {
  async evaluate(apiToken) {
    // Inject helper functions the agent can use
    const myApi = {
      async request(options) {
        // Implementation hidden from agent
      }
    };
    
    try {
      // Execute agent's code with access to injected context
      const result = await (${code})();
      return { result };
    } catch (err) {
      return { err: err.message };
    }
  }
}
        `,
      },
    }));

    const entrypoint = worker.getEntrypoint();
    return await entrypoint.evaluate(apiToken);
  };
}
```

**Key aspects:**
- Each execution gets a fresh, isolated worker
- Server-side data injected as constants (`accountId`, `spec`, etc.)
- Helper APIs injected but implementation hidden
- Agent code runs in sandboxed environment
- Errors caught and returned cleanly

### 3. Build-Time Data Processing

Pre-process large data at build time to optimize runtime:

```typescript
// scripts/build-spec.ts pattern
function resolveRefs(obj: unknown, spec: Document, seen = new Set()): unknown {
  // Recursively resolve all $ref pointers inline
  if ('$ref' in obj) {
    if (seen.has(obj.$ref)) return { $circular: obj.$ref };
    seen.add(obj.$ref);
    // Resolve and recurse
    return resolveRefs(dereference(obj.$ref, spec), spec, seen);
  }
  // Recurse into objects/arrays
  // ...
}

// Generate optimized spec with refs resolved
const optimizedSpec = {
  paths: Object.fromEntries(
    Object.entries(spec.paths).map(([path, item]) => [
      path,
      {
        summary: item.summary,
        parameters: resolveRefs(item.parameters, spec),
        requestBody: resolveRefs(item.requestBody, spec),
        responses: resolveRefs(item.responses, spec),
      }
    ])
  )
};
```

**Build-time optimizations:**
- Resolve all `$ref` pointers inline (agent doesn't chase references)
- Extract metadata (product lists, categories) for better descriptions
- Generate TypeScript types if needed
- Compress/filter to essential fields only

---

## Context Preservation Techniques

### 1. Response Truncation with Guidance

```typescript
// truncate.ts
const CHARS_PER_TOKEN = 4;
const MAX_TOKENS = 6000;
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN;

export function truncateResponse(content: unknown): string {
  const text = typeof content === "string" 
    ? content 
    : JSON.stringify(content, null, 2);

  if (text.length <= MAX_CHARS) return text;

  const truncated = text.slice(0, MAX_CHARS);
  const estimatedTokens = Math.ceil(text.length / CHARS_PER_TOKEN);

  // Tell agent WHY it was truncated and HOW to fix
  return `${truncated}

--- TRUNCATED ---
Response was ~${estimatedTokens.toLocaleString()} tokens (limit: ${MAX_TOKENS.toLocaleString()}). 
Use more specific queries to reduce response size.`;
}
```

**Key principle:** Don't silently truncate. Tell the agent what happened and how to get better results.

### 2. Type Declarations in Tool Descriptions

Embed TypeScript-like type declarations directly in tool descriptions:

```typescript
const CLOUDFLARE_TYPES = `
interface CloudflareRequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  contentType?: string;
  rawBody?: boolean;
}

interface CloudflareResponse<T = unknown> {
  success: boolean;
  result: T;
  errors: Array<{ code: number; message: string }>;
}

declare const cloudflare: {
  request<T>(options: CloudflareRequestOptions): Promise<CloudflareResponse<T>>;
};

declare const accountId: string;
`;
```

**Why this works:**
- Agent understands available APIs without seeing implementation
- Type information guides correct usage
- Compact representation of capabilities

### 3. Example-Driven Descriptions

Include working code examples in tool descriptions:

```typescript
server.registerTool(
  "search",
  {
    description: `Search the OpenAPI spec. All $refs are pre-resolved inline.

Products: ${PRODUCTS.slice(0, 30).join(", ")}... (${PRODUCTS.length} total)

Types:
${SPEC_TYPES}

Examples:

// Find endpoints by product
async () => {
  const results = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (op.tags?.some(t => t.toLowerCase() === 'workers')) {
        results.push({ method: method.toUpperCase(), path, summary: op.summary });
      }
    }
  }
  return results;
}

// Get endpoint with resolved schemas
async () => {
  const op = spec.paths['/accounts/{account_id}/d1/database']?.post;
  return { summary: op?.summary, requestBody: op?.requestBody };
}`,
    inputSchema: {
      code: z.string().describe("JavaScript async arrow function"),
    },
  },
  handler
);
```

**Pattern:** Types first, then progressively complex examples.

### 4. Parallel Auth Verification

Optimize startup latency with parallel operations:

```typescript
async function verifyToken(token: string) {
  const headers = { Authorization: `Bearer ${token}` };

  // Parallel verification - don't wait for one to complete before starting other
  const [userResponse, accountsResponse] = await Promise.all([
    fetch("https://api.example.com/user/verify", { headers }),
    fetch("https://api.example.com/accounts", { headers }),
  ]);

  const [userData, accountsData] = await Promise.all([
    userResponse.json(),
    accountsResponse.json(),
  ]);

  // Determine token type and extract relevant data
  if (userData.success) {
    return { valid: true };
  }
  
  if (accountsData.success && accountsData.result?.length === 1) {
    return { valid: true, accountId: accountsData.result[0].id };
  }

  return { valid: false, error: "..." };
}
```

---

## File Structure

```
src/
├── index.ts          # Entry point: auth, transport setup
├── server.ts         # Tool registration, descriptions
├── executor.ts       # Sandboxed code execution
├── truncate.ts       # Response size management
└── data/
    ├── spec.json     # Pre-processed API spec (generated)
    └── products.ts   # Extracted metadata (generated)

scripts/
└── build-spec.ts     # Build-time processing

wrangler.jsonc        # Worker config with loader binding
```

---

## Implementation Checklist

### Essential Components

- [ ] **Two meta-tools** (`search` + `execute` or equivalent)
- [ ] **Sandboxed executor** with dynamic worker creation
- [ ] **Type declarations** embedded in tool descriptions
- [ ] **Working examples** in descriptions
- [ ] **Response truncation** with guidance messages
- [ ] **Build-time processing** for large data

### Configuration (Cloudflare Workers)

```jsonc
// wrangler.jsonc
{
  "name": "my-mcp",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-12",
  "compatibility_flags": ["nodejs_compat"],
  "worker_loaders": [{ "binding": "LOADER" }]  // Required for dynamic workers
}
```

### Dependencies

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.25.2",
    "zod": "^4.x"
  }
}
```

---

## Adapting for Other Domains

### Database MCP

```typescript
// search: Query schema metadata
server.registerTool("search", {
  description: `Query database schema.

Types:
${SCHEMA_TYPES}

Examples:
async () => {
  return schema.tables.filter(t => t.name.includes('user'));
}`,
});

// execute: Run queries
server.registerTool("execute", {
  description: `Execute SQL queries.

Available: db.query(sql, params)

Examples:
async () => {
  return await db.query('SELECT * FROM users WHERE id = ?', [userId]);
}`,
});
```

### Documentation MCP

```typescript
// search: Query docs index
server.registerTool("search", {
  description: `Search documentation index.

Available: docs.sections, docs.search(query)

Examples:
async () => {
  return docs.sections.filter(s => s.title.match(/auth/i));
}`,
});

// execute: Fetch specific content
server.registerTool("execute", {
  description: `Fetch documentation content.

Examples:
async () => {
  return await docs.getSection('authentication/oauth');
}`,
});
```

### Git/Code MCP

```typescript
// search: Query repo structure
server.registerTool("search", {
  description: `Query repository structure.

Available: repo.files, repo.commits, repo.branches

Examples:
async () => {
  return repo.files.filter(f => f.path.endsWith('.ts'));
}`,
});

// execute: Perform git operations
server.registerTool("execute", {
  description: `Execute git operations.

Available: git.diff(), git.log(), git.show(ref)

Examples:
async () => {
  return await git.diff('HEAD~5..HEAD');
}`,
});
```

---

## Anti-Patterns to Avoid

### 1. Exposing Raw Large Data

```typescript
// BAD: Leaks entire spec to agent
server.registerTool("getSpec", {
  description: "Get the full API spec",
  handler: () => JSON.stringify(spec)  // 2.3M tokens!
});

// GOOD: Agent queries spec server-side
server.registerTool("search", {
  description: "Query spec with JS code",
  handler: ({ code }) => executeInSandbox(code, { spec })
});
```

### 2. One Tool Per Endpoint

```typescript
// BAD: 1000+ tools
server.registerTool("listWorkers", ...);
server.registerTool("createWorker", ...);
server.registerTool("deleteWorker", ...);
server.registerTool("listKV", ...);
// ... 1000 more

// GOOD: 2 tools
server.registerTool("search", ...);
server.registerTool("execute", ...);
```

### 3. Silent Truncation

```typescript
// BAD: Agent doesn't know data was cut off
return content.slice(0, MAX_CHARS);

// GOOD: Agent understands what happened
return `${content.slice(0, MAX_CHARS)}

--- TRUNCATED ---
Response was ~${tokens} tokens. Use more specific queries.`;
```

### 4. Missing Type Information

```typescript
// BAD: Agent guesses at API shape
description: "Execute code against the API"

// GOOD: Agent knows exactly what's available
description: `Execute code against the API.

Available:
${TYPE_DECLARATIONS}

Examples:
${WORKING_EXAMPLES}`
```

---

## Performance Characteristics

| Metric | Traditional MCP | Codemode MCP |
|--------|-----------------|--------------|
| Tool count | O(n) endpoints | O(1) - just 2 |
| Context per call | Full spec/schema | Query results only |
| Agent round-trips | Multiple for discovery | 1 search + 1 execute |
| Cold start | Fast | Slightly slower (worker init) |
| Flexibility | Fixed operations | Arbitrary queries |

---

## Summary

The codemode pattern inverts the traditional MCP architecture:

1. **Data stays server-side** - Spec, schemas, docs never leave the server
2. **Agent writes queries** - Instead of calling fixed tools, agent writes code
3. **Sandboxed execution** - Code runs in isolated workers with injected context
4. **Minimal context transfer** - Only results return to agent

This enables MCP servers for APIs with thousands of endpoints while keeping agent context usage minimal and predictable.

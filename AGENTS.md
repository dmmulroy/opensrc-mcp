# PROJECT KNOWLEDGE BASE

**Generated:** 2026-01-19
**Commit:** 8127c7d
**Branch:** main

## OVERVIEW

MCP server exposing a "codemode" pattern for fetching/querying dependency source code. Agents write JS that executes server-side; only results return. Built with better-result for type-safe error handling.

## STRUCTURE

```
src/
  index.ts          # Entry point, main(), stdio transport
  server.ts         # MCP server factory, tool registration
  api/opensrc.ts    # Core API (fetch, read, grep)
  executor.ts       # VM sandbox for agent code execution
  errors.ts         # Tagged error types (better-result)
  types.ts          # Core interfaces (Source, FileEntry, etc.)
  sources.ts        # sources.json read/write
  logger.ts         # File logging to ~/.opensrc/logs/
  config.ts         # Global paths (opensrc dir, logs)
  truncate.ts       # Output size limiting
opensrc/            # Runtime data (fetched sources) - gitignored
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add new tool | `server.ts` | Single `execute` tool pattern |
| Modify API | `api/opensrc.ts` | All ops exposed to sandbox |
| Error handling | `errors.ts` | TaggedError pattern |
| Source persistence | `sources.ts` | JSON at ~/.opensrc/sources.json |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `main` | function | `index.ts:15` | Entry, init server |
| `createServer` | function | `server.ts` | MCP server factory |
| `createOpensrcAPI` | function | `api/opensrc.ts` | API factory for sandbox |
| `createExecutor` | function | `executor.ts` | VM sandbox factory |
| `Source` | interface | `types.ts:4` | Fetched package/repo |
| `TaggedError` | class | `better-result` | Discriminated error union base |

## CONVENTIONS

- **Result everywhere**: All fallible ops return `Result<T, E>` from better-result
- **TaggedError**: Errors use `_tag` discriminator for pattern matching
- **ESM only**: Use `.js` extensions in imports
- **No linter**: No eslint/biome configured
- **tsdown bundler**: Beta bundler, outputs `.mjs`

## ANTI-PATTERNS (THIS PROJECT)

- **No `any`**: Strict TypeScript enforced
- **No `!` assertions**: Non-null assertions forbidden
- **No `as Type`**: Type assertions forbidden
- **No test framework**: Ad-hoc `test-*.mjs` scripts only
- **No CI**: No automated testing/linting

## KNOWN ISSUES

| Severity | Issue | Location |
|----------|-------|----------|
| HIGH | Path traversal bypass (`....//`) | `api/opensrc.ts:102-107` |
| MEDIUM | ReDoS via user regex | `api/opensrc.ts:126` |
| MEDIUM | No memory limits in executor | `executor.ts:33-39` |

## COMMANDS

```bash
npm run build     # tsdown → dist/index.mjs
npm run dev       # watch mode
npm start         # run built server
node test-mcp.mjs # integration test (spawns server)
```

## NOTES

- **Global state**: Sources list is module singleton
- **Codemode pattern**: LLMs write JS, server executes, only results return
- **Graceful shutdown**: SIGINT/SIGTERM write sources

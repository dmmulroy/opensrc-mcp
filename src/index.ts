#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { readSources, writeSources, getOpensrcDir } from "./sources.js";
import { initVector, shutdownVector, indexExistingSources } from "./vector/index.js";
import type { Source } from "./types.js";
import { createLogger, getLogPath } from "./logger.js";

const log = createLogger("main");

/**
 * Main entry point for opensrc-mcp server
 */
async function main() {
  // Use global opensrc directory (shared across all projects)
  const opensrcDir = getOpensrcDir();

  // State: sources list
  let sources: Source[] = await readSources();

  const getSources = () => sources;
  const updateSources = (newSources: Source[]) => {
    sources = newSources;
  };

  // Initialize vector search
  log.info("starting", { opensrcDir, logFile: getLogPath() });
  const vectorResult = await initVector(opensrcDir);
  vectorResult.match({
    ok: () => {
      log.info("vector search initialized");
      // Index any existing sources that haven't been indexed yet
      indexExistingSources(sources.map((s) => ({ name: s.name, path: s.path })));
    },
    err: (e) => {
      log.error("failed to initialize vector search", e);
    },
  });

  // Create MCP server (pass cwd for sandbox context)
  const server = createServer(process.cwd(), getSources, updateSources);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Handle graceful shutdown
  const shutdown = async () => {
    await writeSources(sources);
    await shutdownVector();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error("fatal error", err instanceof Error ? err : new Error(String(err)));
  process.exit(1);
});

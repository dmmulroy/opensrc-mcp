#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { readSources, writeSources, getOpensrcDir } from "./sources.js";
import { initVector, shutdownVector } from "./vector/index.js";
import type { Source } from "./types.js";

/**
 * Main entry point for opensrc-mcp server
 */
async function main() {
  // Determine project directory (current working directory)
  const projectDir = process.cwd();
  const opensrcDir = getOpensrcDir(projectDir);

  // State: sources list
  let sources: Source[] = await readSources(projectDir);

  const getSources = () => sources;
  const updateSources = (newSources: Source[]) => {
    sources = newSources;
  };

  // Initialize vector search worker (non-blocking, continues in background)
  initVector(opensrcDir).catch((err) => {
    console.error("Failed to initialize vector search:", err);
  });

  // Create MCP server
  const server = createServer(projectDir, getSources, updateSources);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Handle graceful shutdown
  const shutdown = async () => {
    await writeSources(projectDir, sources);
    await shutdownVector();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

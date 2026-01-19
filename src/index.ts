#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { readSources, writeSources } from "./sources.js";
import type { Source } from "./types.js";

/**
 * Main entry point for opensrc-mcp server
 */
async function main() {
  // Determine project directory (current working directory)
  const projectDir = process.cwd();

  // State: sources list
  let sources: Source[] = await readSources(projectDir);

  const getSources = () => sources;
  const updateSources = (newSources: Source[]) => {
    sources = newSources;
  };

  // Create MCP server
  const server = createServer(projectDir, getSources, updateSources);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    await writeSources(projectDir, sources);
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await writeSources(projectDir, sources);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

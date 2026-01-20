#!/usr/bin/env node
/**
 * MCP Integration Test - communicates with opensrc-mcp via JSON-RPC over stdio
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const server = spawn("node", ["dist/index.mjs"], {
  stdio: ["pipe", "pipe", "inherit"],
  cwd: import.meta.dirname,
});

const rl = createInterface({ input: server.stdout });

let msgId = 0;
const pending = new Map();

// Parse incoming messages
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  } catch {}
});

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    server.stdin.write(msg + "\n");
  });
}

function execute(code) {
  return send("tools/call", { name: "execute", arguments: { code } });
}

async function test(name, fn) {
  process.stdout.write(`\n[TEST] ${name}... `);
  try {
    const result = await fn();
    console.log("✓");
    if (result) console.log("  →", JSON.stringify(result, null, 2).split("\n").join("\n  → "));
    return result;
  } catch (err) {
    console.log("✗", err.message);
  }
}

async function main() {
  console.log("═".repeat(60));
  console.log("opensrc-mcp Integration Test (MCP Protocol)");
  console.log("═".repeat(60));

  // Initialize
  await test("initialize", async () => {
    const res = await send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    });
    await send("notifications/initialized", {});
    return { name: res.result?.serverInfo?.name, version: res.result?.serverInfo?.version };
  });

  // List tools
  await test("list tools", async () => {
    const res = await send("tools/list", {});
    return res.result?.tools?.map(t => t.name);
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n─ Testing opensrc API ─");

  await test("opensrc.list()", async () => {
    const res = await execute(`async () => {
      const sources = opensrc.list();
      return sources.map(s => ({ name: s.name, type: s.type, version: s.version || s.ref }));
    }`);
    const text = res.result?.content?.[0]?.text;
    return text ? JSON.parse(text) : res.result;
  });

  // Check if we need to fetch
  const listRes = await execute(`async () => opensrc.list().length`);
  const sourceCount = parseInt(listRes.result?.content?.[0]?.text || "0");

  if (sourceCount === 0) {
    console.log("\n─ Fetching test package (zod) ─");
    await test("opensrc.fetch('zod')", async () => {
      const res = await execute(`async () => {
        const result = await opensrc.fetch("zod");
        return result.match({
          ok: (f) => ({ fetched: f.map(x => x.source.name) }),
          err: (e) => ({ error: e.message })
        });
      }`);
      return res.result?.content?.[0]?.text;
    });
    console.log("Waiting for indexing...");
    await new Promise(r => setTimeout(r, 5000));
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n─ Testing File Operations ─");

  await test("opensrc.files()", async () => {
    const res = await execute(`async () => {
      const sources = opensrc.list();
      if (sources.length === 0) return "no sources";
      const result = await opensrc.files(sources[0].name, "**/*.ts");
      return result.match({
        ok: (files) => ({ count: files.length, sample: files.slice(0, 3).map(f => f.path) }),
        err: (e) => ({ error: e.message })
      });
    }`);
    return res.result?.content?.[0]?.text;
  });

  await test("opensrc.read()", async () => {
    const res = await execute(`async () => {
      const sources = opensrc.list();
      if (sources.length === 0) return "no sources";
      const result = await opensrc.read(sources[0].name, "package.json");
      return result.match({
        ok: (content) => ({ bytes: content.length, preview: content.slice(0, 100) }),
        err: (e) => ({ error: e.message })
      });
    }`);
    return res.result?.content?.[0]?.text;
  });

  await test("opensrc.grep()", async () => {
    const res = await execute(`async () => {
      const results = await opensrc.grep("export", { include: "*.ts", maxResults: 5 });
      return { count: results.length, sample: results.slice(0, 2) };
    }`);
    return res.result?.content?.[0]?.text;
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n─ Testing Semantic Search (PRIORITY) ─");

  await test("semanticSearch - basic", async () => {
    const res = await execute(`async () => {
      const results = await opensrc.semanticSearch("parse and validate data schema", { topK: 5 });
      if ("error" in results) return results;
      return {
        count: results.length,
        results: results.slice(0, 3).map(r => ({
          source: r.source,
          file: r.file,
          identifier: r.identifier,
          kind: r.kind,
          score: r.score.toFixed(3)
        }))
      };
    }`);
    return res.result?.content?.[0]?.text;
  });

  await test("semanticSearch - error handling", async () => {
    const res = await execute(`async () => {
      const results = await opensrc.semanticSearch("error handling throw catch", { topK: 3 });
      if ("error" in results) return results;
      return {
        count: results.length,
        top: results[0] ? { file: results[0].file, id: results[0].identifier, score: results[0].score.toFixed(3) } : null
      };
    }`);
    return res.result?.content?.[0]?.text;
  });

  await test("semanticSearch - type definitions", async () => {
    const res = await execute(`async () => {
      const results = await opensrc.semanticSearch("type interface definition", { topK: 5 });
      if ("error" in results) return results;
      return {
        count: results.length,
        kinds: [...new Set(results.map(r => r.kind))]
      };
    }`);
    return res.result?.content?.[0]?.text;
  });

  await test("semanticSearch - with source filter", async () => {
    const res = await execute(`async () => {
      const sources = opensrc.list();
      if (sources.length === 0) return "no sources";
      const results = await opensrc.semanticSearch("validation", { sources: [sources[0].name], topK: 3 });
      if ("error" in results) return results;
      return { count: results.length, source: sources[0].name };
    }`);
    return res.result?.content?.[0]?.text;
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n─ Testing resolve() ─");

  await test("resolve npm", async () => {
    const res = await execute(`async () => opensrc.resolve("zod@3.22.0")`);
    return res.result?.content?.[0]?.text;
  });

  await test("resolve github", async () => {
    const res = await execute(`async () => opensrc.resolve("vercel/ai")`);
    return res.result?.content?.[0]?.text;
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n═".repeat(60));
  console.log("Integration tests complete!");
  console.log("═".repeat(60));
  console.log("\nCheck logs: tail -f ~/.local/share/opensrc/logs/opensrc-mcp.log");

  server.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  server.kill();
  process.exit(1);
});

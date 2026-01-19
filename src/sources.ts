import { join } from "node:path";
import { readFile, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Source } from "./types.js";

/**
 * Get path to opensrc directory
 */
export function getOpensrcDir(projectDir: string): string {
  return join(projectDir, "opensrc");
}

/**
 * Ensure opensrc directories exist
 */
export async function ensureOpensrcDirs(projectDir: string): Promise<void> {
  const opensrcDir = getOpensrcDir(projectDir);
  if (!existsSync(opensrcDir)) {
    await mkdir(opensrcDir, { recursive: true });
  }
}

/**
 * Read sources from opensrc's sources.json format
 * opensrc uses: { packages: [...], repos: [...] }
 */
export async function readSources(projectDir: string): Promise<Source[]> {
  const sourcesPath = join(getOpensrcDir(projectDir), "sources.json");

  if (!existsSync(sourcesPath)) {
    return [];
  }

  try {
    const content = await readFile(sourcesPath, "utf8");
    const data = JSON.parse(content);
    const sources: Source[] = [];

    // Convert opensrc package format to our Source format
    for (const pkg of data.packages ?? []) {
      sources.push({
        type: pkg.registry ?? "npm",
        name: pkg.name,
        version: pkg.version,
        path: pkg.path.replace(/^opensrc\//, ""),
        fetchedAt: new Date().toISOString(),
        repository: "",
      });
    }

    // Convert opensrc repo format to our Source format
    for (const repo of data.repos ?? []) {
      sources.push({
        type: "repo",
        name: repo.displayName ?? `${repo.owner}-${repo.repo}`,
        ref: repo.ref,
        path: repo.path.replace(/^opensrc\//, ""),
        fetchedAt: new Date().toISOString(),
        repository: `https://${repo.host}/${repo.owner}/${repo.repo}`,
      });
    }

    return sources;
  } catch {
    return [];
  }
}

/**
 * Write sources - delegates to opensrc's format
 * Note: opensrc manages its own sources.json, this is for compatibility
 */
export async function writeSources(
  projectDir: string,
  sources: Source[]
): Promise<void> {
  // opensrc manages its own sources.json
  // We only need to write if doing manual cleanup
  const sourcesPath = join(getOpensrcDir(projectDir), "sources.json");

  // Read existing to preserve format
  let existing = { packages: [] as unknown[], repos: [] as unknown[] };
  if (existsSync(sourcesPath)) {
    try {
      existing = JSON.parse(await readFile(sourcesPath, "utf8"));
    } catch {
      // use default
    }
  }

  // Filter to only keep sources that still exist
  const sourceNames = new Set(sources.map((s) => s.name));

  existing.packages = (existing.packages ?? []).filter((p) => {
    const pkg = p as { name?: string };
    return sourceNames.has(pkg.name ?? "");
  });
  existing.repos = (existing.repos ?? []).filter((r) => {
    const repo = r as { displayName?: string; owner?: string; repo?: string };
    return sourceNames.has(repo.displayName ?? `${repo.owner}-${repo.repo}`);
  });

  const { writeFile } = await import("node:fs/promises");
  await writeFile(sourcesPath, JSON.stringify(existing, null, 2), "utf8");
}

/**
 * Remove sources by name
 */
export async function removeSourcesByName(
  projectDir: string,
  names: string[],
  currentSources: Source[]
): Promise<string[]> {
  const removed: string[] = [];

  for (const name of names) {
    const source = currentSources.find((s) => s.name === name);
    if (source) {
      const sourcePath = join(getOpensrcDir(projectDir), source.path);
      if (existsSync(sourcePath)) {
        await rm(sourcePath, { recursive: true, force: true });
      }
      removed.push(name);
    }
  }

  return removed;
}

/**
 * Clean sources based on filters
 */
export async function cleanSourcesFiltered(
  projectDir: string,
  currentSources: Source[],
  options: {
    packages?: boolean;
    repos?: boolean;
    npm?: boolean;
    pypi?: boolean;
    crates?: boolean;
  }
): Promise<string[]> {
  const hasFilters = Object.values(options).some(Boolean);

  const toRemove = currentSources.filter((s) => {
    if (!hasFilters) return true; // clean all

    if (options.packages && s.type !== "repo") return true;
    if (options.repos && s.type === "repo") return true;
    if (options.npm && s.type === "npm") return true;
    if (options.pypi && s.type === "pypi") return true;
    if (options.crates && s.type === "crates") return true;

    return false;
  });

  return removeSourcesByName(
    projectDir,
    toRemove.map((s) => s.name),
    currentSources
  );
}

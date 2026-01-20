import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Source } from "./types.js";
import { getGlobalOpensrcDir, getOpensrcCwd } from "./config.js";
import {
  listSources as opensrcListSources,
  removePackageSource,
  removeRepoSource,
} from "opensrc/dist/lib/git.js";
import type { Registry } from "opensrc/dist/types.js";

/**
 * Get path to global opensrc directory
 */
export function getOpensrcDir(): string {
  return getGlobalOpensrcDir();
}

/**
 * Ensure opensrc directories exist
 */
export async function ensureOpensrcDirs(): Promise<void> {
  const opensrcDir = getOpensrcDir();
  if (!existsSync(opensrcDir)) {
    await mkdir(opensrcDir, { recursive: true });
  }
}

/**
 * Read sources using opensrc's listSources and normalize to our Source type
 */
export async function readSources(): Promise<Source[]> {
  const { packages, repos } = await opensrcListSources(getOpensrcCwd());
  const sources: Source[] = [];

  // Convert opensrc package format to our Source format
  for (const pkg of packages) {
    sources.push({
      type: pkg.registry,
      name: pkg.name,
      version: pkg.version,
      path: pkg.path.replace(/^opensrc\//, ""),
      fetchedAt: pkg.fetchedAt,
      repository: "",
    });
  }

  // Convert opensrc repo format to our Source format
  for (const repo of repos) {
    sources.push({
      type: "repo",
      name: repo.name,
      ref: repo.version,
      path: repo.path.replace(/^opensrc\//, ""),
      fetchedAt: repo.fetchedAt,
      repository: repo.name.startsWith("github.com")
        ? `https://${repo.name}`
        : `https://github.com/${repo.name}`,
    });
  }

  return sources;
}

/**
 * Write sources - delegates to opensrc format
 * Note: opensrc manages its own sources.json during fetch/remove operations
 */
export async function writeSources(sources: Source[]): Promise<void> {
  // opensrc manages its own sources.json through its commands
  // We only need to write if doing manual cleanup outside of opensrc
  const sourcesPath = join(getOpensrcDir(), "sources.json");

  // Read existing to preserve format
  let existing = { packages: [] as unknown[], repos: [] as unknown[] };
  if (existsSync(sourcesPath)) {
    try {
      const { readFile } = await import("node:fs/promises");
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
    const repo = r as { name?: string };
    return sourceNames.has(repo.name ?? "");
  });

  // Update timestamp per opensrc format
  const output = {
    ...existing,
    updatedAt: new Date().toISOString(),
  };

  const { writeFile } = await import("node:fs/promises");
  await writeFile(sourcesPath, JSON.stringify(output, null, 2), "utf8");
}

/**
 * Remove sources by name using opensrc's smart removal
 * (monorepo-aware: only removes repo if no other packages use it)
 */
export async function removeSourcesByName(
  names: string[],
  currentSources: Source[]
): Promise<string[]> {
  const removed: string[] = [];
  const cwd = getOpensrcCwd();

  for (const name of names) {
    const source = currentSources.find((s) => s.name === name);
    if (!source) continue;

    if (source.type === "repo") {
      // Use opensrc's removeRepoSource
      const success = await removeRepoSource(name, cwd);
      if (success) {
        removed.push(name);
      }
    } else {
      // Use opensrc's removePackageSource (monorepo-aware)
      const result = await removePackageSource(name, cwd, source.type as Registry);
      if (result.removed) {
        removed.push(name);
      }
    }
  }

  return removed;
}

/**
 * Clean sources based on filters
 */
export async function cleanSourcesFiltered(
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

  return removeSourcesByName(toRemove.map((s) => s.name), currentSources);
}

import { homedir } from "node:os";
import { join, dirname } from "node:path";

/**
 * Get the global opensrc directory path.
 * 
 * Resolution order:
 * 1. $OPENSRC_DIR env var (explicit override)
 * 2. $XDG_DATA_HOME/opensrc (XDG compliance)
 * 3. ~/.local/share/opensrc (XDG default)
 */
export function getGlobalOpensrcDir(): string {
  if (process.env.OPENSRC_DIR) {
    return process.env.OPENSRC_DIR;
  }

  const xdgData = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(xdgData, "opensrc");
}

/**
 * Get the cwd to pass to opensrc CLI.
 * 
 * The opensrc CLI always creates an `opensrc/` subdirectory in cwd,
 * so we return the parent of our desired global directory.
 */
export function getOpensrcCwd(): string {
  if (process.env.OPENSRC_DIR) {
    return dirname(process.env.OPENSRC_DIR);
  }

  return process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
}

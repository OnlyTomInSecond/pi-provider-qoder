import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the user's home directory for Qoder state paths.
 *
 * Prefer the environment over `os.homedir()` so callers (and tests) can
 * relocate `$HOME`; Node reads `os.homedir()` once from the process start
 * environment, so it would otherwise ignore later changes.
 */
export function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

/** Root of DeepSeek Harness state (`$DSH_HOME`, default `~/.dsh`). */
export function getDshHomeDir(): string {
  const configured = process.env.DSH_HOME?.trim();
  if (!configured) return join(getHomeDir(), ".dsh");
  if (configured === "~") return getHomeDir();
  if (configured.startsWith("~/")) return join(getHomeDir(), configured.slice(2));
  return configured;
}

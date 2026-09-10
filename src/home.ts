import { homedir } from "node:os";

/**
 * Resolve the user's home directory for pi/qoder state paths.
 *
 * Prefer the environment over `os.homedir()` so callers (and tests) can
 * relocate `$HOME`; Node reads `os.homedir()` once from the process start
 * environment, so it would otherwise ignore later changes.
 */
export function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

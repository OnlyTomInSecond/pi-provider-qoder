import { homedir } from "node:os";
import { join } from "node:path";

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

export function getPiAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured === "~") return getHomeDir();
  if (configured?.startsWith("~/")) return join(getHomeDir(), configured.slice(2));
  return configured || join(getHomeDir(), ".pi", "agent");
}

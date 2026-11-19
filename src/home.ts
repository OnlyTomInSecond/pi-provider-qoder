import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

/**
 * Absolute path of one of the plugin's state files.
 *
 * They all live in a dedicated `qoder/` subdirectory of the pi agent dir so
 * they no longer mix with pi's own files (`auth.json`, `settings.json`, ...).
 * Older versions wrote them straight into the agent dir; that copy is migrated
 * on first use, best effort, so a read-only home or a concurrent pi process
 * cannot break startup.
 */
export function getQoderStatePath(fileName: string): string {
  const target = join(getPiAgentDir(), "qoder", fileName);
  if (existsSync(target)) return target;
  const legacy = join(getPiAgentDir(), fileName);
  if (!existsSync(legacy)) return target;
  try {
    mkdirSync(dirname(target), { recursive: true });
    renameSync(legacy, target);
  } catch {
    // Another process won the race, or the home is read-only.
  }
  return target;
}

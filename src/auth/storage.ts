import crypto from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { debugLog } from "../debug.js";
import { getPiAgentDir } from "../home.js";

interface HostAuthStorage {
  modify?: (provider: string, update: (current: unknown) => Promise<unknown>) => Promise<unknown>;
  set?: (provider: string, credentials: unknown) => void | Promise<void>;
}

let hostStoragePromise: Promise<{ create?: (path: string) => HostAuthStorage } | undefined> | undefined;

export function getAuthFilePath(): string {
  return join(getPiAgentDir(), "auth.json");
}

/** Always read current disk state: login/refresh/logout may be performed by the host. */
export function readAuthFile(): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(getAuthFilePath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid auth.json: expected an object");
  }
  return value as Record<string, unknown>;
}

/** Only explicit environment login writes credentials; interactive auth is host-owned. */
export async function storeEnvironmentCredentials(provider: string, credentials: OAuthCredentials): Promise<void> {
  hostStoragePromise ??= import("@earendil-works/pi-coding-agent")
    .then((mod) => (mod as unknown as { AuthStorage?: { create?: (path: string) => HostAuthStorage } }).AuthStorage)
    .catch((error) => {
      debugLog("host AuthStorage unavailable", error);
      return undefined;
    });
  const host = await hostStoragePromise;
  const store = host?.create?.(getAuthFilePath());
  const value = { ...credentials, type: "oauth" as const };
  if (store?.modify) {
    await store.modify(provider, async () => value);
    return;
  }
  if (store?.set) {
    await store.set(provider, value);
    return;
  }

  // Legacy hosts without a writable store: use the same lock directory as pi's
  // proper-lockfile backend. Never bypass a held lock or overwrite invalid JSON.
  // Atomic replacement prevents readers from observing a truncated document.
  const path = getAuthFilePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  mkdirSync(lock, { mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const current = readAuthFile();
    current[provider] = value;
    writeFileSync(temporary, JSON.stringify(current, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}

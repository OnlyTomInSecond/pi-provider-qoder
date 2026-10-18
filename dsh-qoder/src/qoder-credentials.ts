/**
 * Qoder credential resolution for the harness.
 *
 * A raw access token from the environment or the DSH credential seam stays
 * authoritative. Otherwise a persisted grant (`llm-qoder/<provider>`) is reused
 * while the PAT it was exchanged from is still the configured one; a changed
 * PAT is exchanged instead of shadowed, and a grant that fails to refresh
 * falls back to exchanging the current PAT. Refreshed credentials are cached in
 * memory and written back to the same DSH record. No other application's
 * credential store is read.
 */
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { credentialsFromPat } from "./qoder/auth/pat.js";
import { decodePatRefresh, isPatRefresh } from "./qoder/auth/refresh.js";
import {
  qoderCredentialNeedsRefresh,
  refreshQoderTokenForMode,
  rememberQoderCredential,
  resolveQoderIdentity,
  type QoderCredentials,
} from "./qoder/auth/oauth.js";
import { debugLog } from "./qoder/debug.js";
import { getQoderRegionConfig, type QoderMode } from "./qoder/region.js";

export class QoderAuthError extends Error {
  readonly code: string;
  readonly failure: { message: string; code: string };

  constructor(message: string, code = "MISSING_CREDENTIAL") {
    super(message);
    this.name = "QoderAuthError";
    this.code = code;
    this.failure = { message, code };
  }
}

interface DshCredentials {
  resolve(ref: string): Promise<{ value: string } | undefined>;
  readRecord(key: string): Promise<{ kind: string; payload?: unknown; key?: string } | undefined>;
  modifyRecord(key: string, mutate: (current: unknown) => Promise<unknown | undefined>): Promise<unknown>;
}

interface PluginContext {
  get?: (name: string) => unknown;
}

function asCredential(value: unknown): QoderCredentials | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  if (typeof entry.access !== "string" || !entry.access) return undefined;
  return {
    access: entry.access,
    refresh: typeof entry.refresh === "string" ? entry.refresh : "",
    expires: typeof entry.expires === "number" ? entry.expires : 0,
    userID: typeof entry.userID === "string" ? entry.userID : "",
    email: typeof entry.email === "string" ? entry.email : "",
    name: typeof entry.name === "string" ? entry.name : "",
    machineID: typeof entry.machineID === "string" ? entry.machineID : "",
  };
}

/** References the configuration UI writes; one per region. */
const ACCESS_TOKEN_REFS: Record<QoderMode, readonly string[]> = {
  global: ["QODER_ACCESS_TOKEN", "QODER_API_KEY"],
  cn: ["QODERCN_ACCESS_TOKEN", "QODER_CN_API_KEY", "QODERCN_API_KEY"],
};

type ResolvedToken = { kind: "pat" | "access"; value: string };

export class QoderCredentialStore {
  private readonly memory = new Map<QoderMode, QoderCredentials>();
  private readonly inflight = new Map<QoderMode, Promise<QoderCredentials>>();

  constructor(
    private readonly ctx: PluginContext,
    private readonly persist: boolean,
  ) {}

  /** Drop the in-memory credential after the user changes its reference. */
  invalidate(mode: QoderMode): void {
    this.memory.delete(mode);
  }

  /** Resolve a usable credential, refreshing it when it is about to expire. */
  async get(mode: QoderMode): Promise<QoderCredentials> {
    const cached = this.memory.get(mode);
    if (cached && !qoderCredentialNeedsRefresh(cached)) return cached;
    const pending = this.inflight.get(mode);
    if (pending) return pending;
    const promise = this.load(mode).finally(() => this.inflight.delete(mode));
    this.inflight.set(mode, promise);
    return promise;
  }

  private async load(mode: QoderMode): Promise<QoderCredentials> {
    const region = getQoderRegionConfig(mode);
    const providerID = region.providerID;

    const token = await this.findToken(mode);
    if (token?.kind === "access") {
      const identity = await resolveQoderIdentity(token.value, providerID, mode).catch(() => undefined);
      const credentials: QoderCredentials = {
        access: token.value,
        // A raw access token has no refresh path; keep it usable until the
        // upstream rejects it so the UI value stays authoritative.
        refresh: "",
        expires: Number.MAX_SAFE_INTEGER,
        userID: identity?.userID || "qoder-user",
        email: identity?.email || region.userEmailFallback,
        name: identity?.name || region.userNameFallback,
        machineID: identity?.machineID || "",
      };
      rememberQoderCredential(providerID, credentials);
      this.memory.set(mode, credentials);
      return credentials;
    }

    const stored = await this.readDshRecord(mode);
    if (stored) {
      const storedPat = isPatRefresh(stored.refresh) ? decodePatRefresh(stored.refresh).pat : undefined;
      // Reuse the persisted job token while the configured PAT is the one it
      // was exchanged from. A changed PAT must win, not be shadowed by the
      // previous account's grant.
      const samePat = token?.kind !== "pat" || storedPat === token.value;
      if (samePat) {
        if (!qoderCredentialNeedsRefresh(stored)) {
          rememberQoderCredential(providerID, stored);
          this.memory.set(mode, stored);
          return stored;
        }
        try {
          const refreshed = (await refreshQoderTokenForMode(stored, mode)) as QoderCredentials;
          rememberQoderCredential(providerID, refreshed);
          this.memory.set(mode, refreshed);
          if (this.persist) await this.writeRecord(mode, refreshed);
          return refreshed;
        } catch (error) {
          if (token?.kind !== "pat") {
            throw new QoderAuthError(
              `Qoder credentials for ${providerID} expired and could not be refreshed: ${error instanceof Error ? error.message : String(error)}`,
              "INVALID_CREDENTIAL",
            );
          }
          // The stored grant could not refresh; exchange the PAT the user
          // configured now instead of failing on the old grant.
          debugLog(`Qoder stored grant refresh failed for ${providerID}`, error);
        }
      }
    }

    if (token?.kind === "pat") {
      let credentials: QoderCredentials;
      try {
        credentials = (await credentialsFromPat(token.value, mode)) as QoderCredentials;
      } catch (error) {
        throw new QoderAuthError(
          `Qoder PAT exchange failed for ${providerID}: ${error instanceof Error ? error.message : String(error)}`,
          "INVALID_CREDENTIAL",
        );
      }
      rememberQoderCredential(providerID, credentials);
      this.memory.set(mode, credentials);
      if (this.persist) await this.writeRecord(mode, credentials);
      return credentials;
    }

    throw new QoderAuthError(
      `No Qoder credentials for ${providerID}. Paste an access token in Settings > Models > Qoder,`
      + ` or set ${region.patEnvNames[0]}.`,
    );
  }

  private service(): DshCredentials | undefined {
    return this.ctx.get?.("credentials") as DshCredentials | undefined;
  }

  private async findToken(mode: QoderMode): Promise<ResolvedToken | undefined> {
    const credentials = this.service();
    const names = [...ACCESS_TOKEN_REFS[mode], ...getQoderRegionConfig(mode).patEnvNames];
    for (const name of names) {
      // A stored reference outranks the launching environment, matching the
      // credential seam's own precedence. The UI writes the stored value.
      const stored = credentials ? (await credentials.resolve(name).catch(() => undefined))?.value?.trim() : "";
      const value = stored || process.env[name]?.trim();
      if (!value) continue;
      return { kind: value.startsWith("pt-") ? "pat" : "access", value };
    }
    return undefined;
  }

  private async readDshRecord(mode: QoderMode): Promise<QoderCredentials | undefined> {
    const credentials = this.service();
    if (!credentials) return undefined;
    try {
      const record = await credentials.readRecord(`llm-qoder/${getQoderRegionConfig(mode).providerID}`);
      if (record?.kind === "grant") return asCredential(record.payload);
      if (record?.kind === "api-key" && typeof record.key === "string" && record.key.trim()) {
        return (await credentialsFromPat(record.key.trim(), mode)) as QoderCredentials;
      }
    } catch (error) {
      debugLog(`failed to read DSH credential record for ${mode}`, error);
    }
    return undefined;
  }

  private async writeRecord(mode: QoderMode, credentials: QoderCredentials): Promise<void> {
    const service = this.service();
    if (!service) return;
    try {
      await service.modifyRecord(`llm-qoder/${getQoderRegionConfig(mode).providerID}`, async () => ({
        kind: "grant",
        payload: credentials,
      }));
    } catch (error) {
      debugLog(`failed to persist DSH credential record for ${mode}`, error);
    }
  }
}

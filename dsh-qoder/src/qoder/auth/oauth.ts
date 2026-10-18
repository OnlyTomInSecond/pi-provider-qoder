import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { updateQoderModelsCache } from "../catalog.js";
import { getMachineId } from "../cosy.js";
import { debugLog } from "../debug.js";
import { fetchQoderJson, type QoderRequestOptions } from "../http.js";
import { LruMap } from "../lru.js";
import { getQoderRefreshURL, getQoderRegionConfig, type QoderMode } from "../region.js";
import { DEFAULT_TOKEN_TTL_MS, resolveTokenExpiry, TOKEN_EXPIRY_SAFETY_MS } from "./expiry.js";
import { credentialsFromPat, fetchUserInfo } from "./pat.js";
import { decodeRefresh, encodeDeviceRefresh } from "./refresh.js";

export interface QoderCredentials extends OAuthCredentials {
  userID: string;
  email: string;
  name: string;
  machineID: string;
}

export type QoderIdentity = Pick<QoderCredentials, "userID" | "email" | "name" | "machineID">;

/** Cap the identity memo so long sessions with many token refreshes stay bounded. */
const MAX_IDENTITY_CACHE = 32;

const identityCache = new LruMap<string, QoderIdentity>(MAX_IDENTITY_CACHE);

function cacheIdentity(key: string, creds: QoderIdentity): void {
  const { userID, email, name, machineID } = creds;
  identityCache.set(key, { userID, email, name, machineID });
}

/**
 * Resolve the Qoder identity (userID/email/name/machineID) for a request.
 * The DSH record's identity is memoized when the credential is loaded; a miss
 * asks the OpenAPI userinfo endpoint, because Qoder CN rejects a placeholder
 * uid.
 */
export async function resolveQoderIdentity(
  accessToken: string,
  providerID: string,
  mode: QoderMode,
  options: QoderRequestOptions = {},
): Promise<QoderIdentity> {
  options.signal?.throwIfAborted();
  const region = getQoderRegionConfig(mode);
  const cacheKey = `${providerID}:${accessToken}`;
  const mem = identityCache.get(cacheKey);
  if (mem?.userID) {
    cacheIdentity(cacheKey, mem);
    return mem;
  }

  const info = await fetchUserInfo(accessToken, mode, options);
  const machineID = getMachineId();
  const creds: QoderIdentity = {
    userID: info.userID || "qoder-user",
    email: info.email || region.userEmailFallback,
    name: info.name || region.userNameFallback,
    machineID,
  };
  if (info.userID) cacheIdentity(cacheKey, creds);
  return creds;
}

/** True when a stored credential should be refreshed before the next request. */
export function qoderCredentialNeedsRefresh(credentials: OAuthCredentials): boolean {
  return typeof credentials.expires === "number" && credentials.expires - TOKEN_EXPIRY_SAFETY_MS <= Date.now();
}

/** Remember a freshly exchanged/refreshed credential for in-process reuse. */
export function rememberQoderCredential(providerID: string, credentials: OAuthCredentials): void {
  const creds = credentials as QoderCredentials;
  if (creds.access && creds.userID) cacheIdentity(`${providerID}:${creds.access}`, creds);
}

/**
 * Refresh one Qoder credential. PAT-backed credentials re-exchange the PAT;
 * device credentials use the stored refresh token.
 */
export async function refreshQoderTokenForMode(
  credentials: OAuthCredentials,
  mode: QoderMode,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  signal?.throwIfAborted();
  let refreshed: QoderCredentials;
  // Refresh failures propagate: extending local expiry cannot make a revoked
  // upstream token valid.
  const stored = decodeRefresh(credentials.refresh);
  if (stored.kind === "pat") {
    if (!stored.pat) throw new Error(`Missing Qoder PAT; set ${getQoderRegionConfig(mode).patEnvNames[0]}`);
    refreshed = (await credentialsFromPat(stored.pat, mode, { signal })) as QoderCredentials;
  } else {
    const previous = credentials as Partial<QoderCredentials>;
    const userID = stored.userID || previous.userID || "";
    const machineID = stored.machineID || previous.machineID || getMachineId();
    if (!stored.refreshToken) {
      throw new Error(`Missing Qoder refresh token; re-authorize ${getQoderRegionConfig(mode).providerID}`);
    }
    const data = await fetchQoderJson<{
      token?: string;
      refresh_token?: string;
      expires_at?: string;
      expires_in?: number;
    }>(
      getQoderRefreshURL(mode),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credentials.access}`,
          Accept: "application/json",
          "User-Agent": "dsh-llm-qoder",
        },
        body: JSON.stringify({ refreshToken: stored.refreshToken }),
      },
      { signal },
    );
    if (!data.token) throw new Error("Qoder refresh returned no access token");
    refreshed = {
      ...credentials,
      refresh: encodeDeviceRefresh(data.refresh_token || stored.refreshToken, userID, machineID),
      access: data.token,
      expires: resolveTokenExpiry(data, DEFAULT_TOKEN_TTL_MS) - TOKEN_EXPIRY_SAFETY_MS,
      userID,
      email: previous.email || "",
      name: previous.name || "",
      machineID,
    };
  }
  signal?.throwIfAborted();
  if (refreshed.userID) {
    cacheIdentity(`${getQoderRegionConfig(mode).providerID}:${refreshed.access}`, refreshed);
  }
  // Best-effort catalog refresh; cancellation-aware.
  updateQoderModelsCache(refreshed.access, refreshed.userID, refreshed.name, refreshed.email, mode, signal).catch(
    (error) => debugLog("model catalog refresh after token refresh failed", error),
  );
  return refreshed;
}



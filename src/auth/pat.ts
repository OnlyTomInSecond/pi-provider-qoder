import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { buildOpenApiHeaders, getMachineId } from "../cosy.js";
import { debugLog } from "../debug.js";
import { fetchQoderJson, type QoderRequestOptions } from "../http.js";
import { getQoderExchangeURL, getQoderRegionConfig, getQoderUserInfoURL, type QoderMode } from "../region.js";
import { resolveTokenExpiry, TOKEN_EXPIRY_SAFETY_MS } from "./expiry.js";
import { encodePatRefresh } from "./refresh.js";

export interface PatExchangeResult {
  /** Short-lived job token (jt-...) used for auth + COSY signatures. */
  jobToken: string;
  /** Job refresh token (jrt-...), if returned. */
  jobRefreshToken: string;
  expiresAt: number;
}

/**
 * Exchange a Qoder Personal Access Token (pt-...) for a short-lived Job Token
 * (jt-...). PATs cannot authenticate API calls directly; they must first be
 * exchanged. This mirrors the official qodercli/qoderclicn flow:
 *   POST /api/v1/jobToken/exchange { personal_token } -> { token, refresh_token, expires_at }
 * The exchange endpoint does not require a COSY signature.
 */
export async function exchangeJobToken(
  pat: string,
  mode: QoderMode,
  options: QoderRequestOptions = {},
): Promise<PatExchangeResult> {
  const data = await fetchQoderJson<{
    token?: string;
    refresh_token?: string;
    expires_at?: string;
    expires_in?: number;
  }>(
    getQoderExchangeURL(mode),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildOpenApiHeaders(),
      },
      body: JSON.stringify({ personal_token: pat }),
    },
    options,
  );

  if (!data.token) {
    throw new Error("Qoder PAT exchange returned no job token");
  }

  // `expires_in` is in milliseconds (see expiry.ts); fall back to 24h.
  const expiresAt = resolveTokenExpiry(data, 24 * 60 * 60 * 1000);

  return {
    jobToken: data.token,
    jobRefreshToken: data.refresh_token || "",
    expiresAt,
  };
}

/** Fetch user profile using a job token (jt-...). Best-effort. */
export async function fetchUserInfo(
  jobToken: string,
  mode: QoderMode,
  options: QoderRequestOptions = {},
): Promise<{ userID: string; email: string; name: string }> {
  let userID = "";
  let email = "";
  let name = "";
  try {
    const info = await fetchQoderJson<{ id?: string; email?: string; name?: string; username?: string }>(
      getQoderUserInfoURL(mode),
      {
        headers: buildOpenApiHeaders(jobToken),
      },
      { attempts: 2, ...options },
    );
    userID = info.id || "";
    email = info.email || "";
    name = info.name || info.username || "";
  } catch (error) {
    options.signal?.throwIfAborted();
    debugLog("failed to fetch Qoder userinfo", error);
  }
  return { userID, email, name };
}

/**
 * Build full Qoder credentials from a Personal Access Token.
 * Exchanges the PAT for a job token, resolves identity, and encodes the PAT
 * into the refresh field so the token can be re-exchanged on expiry.
 */
export async function credentialsFromPat(
  pat: string,
  mode: QoderMode,
  options: QoderRequestOptions = {},
): Promise<OAuthCredentials> {
  const region = getQoderRegionConfig(mode);
  const { jobToken, jobRefreshToken, expiresAt } = await exchangeJobToken(pat, mode, options);
  const { userID, email, name } = await fetchUserInfo(jobToken, mode, options);
  const machineID = getMachineId();

  return {
    refresh: encodePatRefresh(pat, jobRefreshToken, userID, machineID),
    access: jobToken,
    expires: expiresAt - TOKEN_EXPIRY_SAFETY_MS,
    userID,
    email: email || region.userEmailFallback,
    name: name || region.userNameFallback,
    machineID,
  } as OAuthCredentials;
}

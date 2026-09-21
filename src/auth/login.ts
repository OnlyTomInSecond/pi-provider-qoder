import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { getMachineId } from "../cosy.js";
import { QoderHttpError, withAbort, withRequestTimeout } from "../http.js";
import { getQoderDeviceLoginURL, getQoderDevicePollURL, getQoderRegionConfig, type QoderMode } from "../region.js";
import { resolveTokenExpiry } from "./expiry.js";
import { credentialsFromPat, fetchUserInfo } from "./pat.js";

export function generatePKCE() {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

export async function interactiveLogin(callbacks: OAuthLoginCallbacks, mode: QoderMode): Promise<OAuthCredentials> {
  callbacks.signal?.throwIfAborted();
  const region = getQoderRegionConfig(mode);
  // Use the host login dialog callbacks so PAT entry keeps keyboard focus.
  const pat = await callbacks.onPrompt({
    message: !region.supportsBrowserLogin
      ? "Paste a Qoder CN Personal Access Token, or leave empty to cancel"
      : "Paste a Qoder Personal Access Token (pt-...), or leave empty for browser login",
    placeholder: "pt-...",
    allowEmpty: true,
  });
  callbacks.signal?.throwIfAborted();
  if (pat?.trim()) {
    callbacks.onProgress?.("Exchanging access token...");
    const creds = await credentialsFromPat(pat.trim(), mode, { signal: callbacks.signal });
    callbacks.signal?.throwIfAborted();
    callbacks.onProgress?.("Login successful!");
    return creds;
  }
  if (!region.supportsBrowserLogin) {
    throw new Error(
      `Qoder CN browser login is not supported here. Paste a Qoder CN PAT from ${region.patManageUrl} or set QODERCN_PERSONAL_ACCESS_TOKEN.`,
    );
  }
  // Wall-clock deadline includes polling, network stalls and profile resolution.
  return withRequestTimeout((signal) => runDeviceFlow(callbacks, signal), callbacks.signal, 180_000);
}

interface DeviceToken {
  token: string;
  user_id: string;
  refresh_token: string;
  expires_at?: string;
  expires_in?: number;
}

async function runDeviceFlow(callbacks: OAuthLoginCallbacks, signal: AbortSignal): Promise<OAuthCredentials> {
  const { codeVerifier, codeChallenge } = generatePKCE();
  const nonce = crypto.randomUUID();
  const machineID = getMachineId();
  callbacks.onProgress?.("Please complete login in your browser...");
  callbacks.onAuth({
    url: getQoderDeviceLoginURL(codeChallenge, machineID, nonce),
    instructions: "Click to sign in with your Qoder account in the browser.",
  });

  const pollURL = getQoderDevicePollURL(nonce, codeVerifier);
  while (true) {
    await delay(2000, undefined, { signal });
    const token = await withRequestTimeout(async (requestSignal) => {
      const response = await fetch(pollURL, {
        headers: { Accept: "application/json", "User-Agent": "pi-provider-qoder" },
        signal: requestSignal,
      });
      try {
        if (response.status === 202 || response.status === 404) return undefined;
        if (!response.ok) throw new QoderHttpError(response.status);
        return await withAbort(response.json() as Promise<DeviceToken>, requestSignal);
      } finally {
        void response.body?.cancel().catch(() => {});
      }
    }, signal);
    if (!token) continue;
    if (!token.token) throw new Error("Device token poll returned empty access token");
    callbacks.onProgress?.("Fetching user profile...");
    const info = await fetchUserInfo(token.token, "global", { signal });
    signal.throwIfAborted();
    callbacks.onProgress?.("Login successful!");
    return {
      refresh: `${token.refresh_token}|${token.user_id}|${machineID}`,
      access: token.token,
      expires: resolveTokenExpiry(token) - 5 * 60 * 1000,
      userID: token.user_id,
      email: info.email,
      name: info.name,
      machineID,
    } as OAuthCredentials;
  }
}

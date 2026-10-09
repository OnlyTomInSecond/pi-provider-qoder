const DEVICE_REFRESH_PREFIX = "device";

/**
 * Marker prefix for PAT-based credentials. The credential's `refresh` field
 * layout is `pat|<personalToken>|<jobRefreshToken>|<userID>|<machineID>`.
 */
export const PAT_REFRESH_PREFIX = "pat";

/** True when a credential `refresh` field carries a PAT. */
export function isPatRefresh(refresh: string): boolean {
  return refresh.startsWith(`${PAT_REFRESH_PREFIX}|`);
}

/** Encode a PAT credential's refresh field. */
export function encodePatRefresh(pat: string, jobRefreshToken: string, userID: string, machineID: string): string {
  return [PAT_REFRESH_PREFIX, pat, jobRefreshToken, userID, machineID].join("|");
}

/** Decode a PAT credential's refresh field. */
export function decodePatRefresh(refresh: string): {
  pat: string;
  jobRefreshToken: string;
  userID: string;
  machineID: string;
} {
  const parts = refresh.split("|");
  return {
    pat: parts[1] || "",
    jobRefreshToken: parts[2] || "",
    userID: parts[3] || "",
    machineID: parts[4] || "",
  };
}

/**
 * Encode a device-flow credential's refresh field.
 * Layout: `device|<refreshToken>|<userID>|<machineID>`.
 */
export function encodeDeviceRefresh(refreshToken: string, userID: string, machineID: string): string {
  return [DEVICE_REFRESH_PREFIX, refreshToken, userID, machineID].join("|");
}

export type QoderRefresh =
  | {
      kind: "pat";
      /** Personal Access Token to re-exchange for a job token. */
      pat: string;
      jobRefreshToken: string;
      userID: string;
      machineID: string;
    }
  | {
      kind: "device";
      /** OAuth refresh token. */
      refreshToken: string;
      userID: string;
      machineID: string;
    };

/**
 * Decode a credential `refresh` field into one of the two supported shapes.
 *
 * New credentials carry a `pat|` or `device|` tag. Credentials written before
 * the `device|` tag existed store `"<refreshToken>|<userID>|<machineID>"`, which
 * is decoded as a legacy device credential so existing logins keep refreshing.
 */
export function decodeRefresh(refresh: string): QoderRefresh {
  if (isPatRefresh(refresh)) {
    const { pat, jobRefreshToken, userID, machineID } = decodePatRefresh(refresh);
    return { kind: "pat", pat, jobRefreshToken, userID, machineID };
  }

  const parts = refresh.split("|");
  if (parts[0] === DEVICE_REFRESH_PREFIX) {
    return {
      kind: "device",
      refreshToken: parts[1] || "",
      userID: parts[2] || "",
      machineID: parts[3] || "",
    };
  }
  return {
    kind: "device",
    refreshToken: parts[0] || "",
    userID: parts[1] || "",
    machineID: parts[2] || "",
  };
}

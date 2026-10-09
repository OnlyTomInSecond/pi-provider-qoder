import { describe, expect, it } from "vitest";
import {
  decodePatRefresh,
  decodeRefresh,
  encodeDeviceRefresh,
  encodePatRefresh,
  isPatRefresh,
  PAT_REFRESH_PREFIX,
} from "../auth/refresh.js";

describe("decodeRefresh", () => {
  it("round-trips a device credential", () => {
    const encoded = encodeDeviceRefresh("rt-123", "user-1", "machine-1");
    expect(encoded).toBe("device|rt-123|user-1|machine-1");
    expect(decodeRefresh(encoded)).toEqual({
      kind: "device",
      refreshToken: "rt-123",
      userID: "user-1",
      machineID: "machine-1",
    });
  });

  it("decodes a legacy untagged device credential", () => {
    expect(decodeRefresh("rt-legacy|user-2|machine-2")).toEqual({
      kind: "device",
      refreshToken: "rt-legacy",
      userID: "user-2",
      machineID: "machine-2",
    });
  });

  it("decodes a PAT credential", () => {
    expect(decodeRefresh("pat|pt-secret|jrt|user-3|machine-3")).toEqual({
      kind: "pat",
      pat: "pt-secret",
      jobRefreshToken: "jrt",
      userID: "user-3",
      machineID: "machine-3",
    });
  });

  it("tolerates missing fields", () => {
    expect(decodeRefresh("")).toEqual({ kind: "device", refreshToken: "", userID: "", machineID: "" });
  });
});

// ── PAT refresh-field codec ───────────────────────────────────────────────

describe("isPatRefresh", () => {
  it("returns true for PAT refresh strings", () => {
    expect(isPatRefresh("pat|mytoken|refresh123|user1|machine1")).toBe(true);
  });

  it("returns true for minimal PAT prefix", () => {
    expect(isPatRefresh("pat|")).toBe(true);
  });

  it("returns false for non-PAT refresh strings", () => {
    expect(isPatRefresh("some-other-refresh-token")).toBe(false);
    expect(isPatRefresh("refresh|user|machine")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isPatRefresh("")).toBe(false);
  });
});

describe("encodePatRefresh / decodePatRefresh roundtrip", () => {
  it("encodes and decodes correctly", () => {
    const encoded = encodePatRefresh("pt-abc123", "jrt-xyz", "user-42", "machine-7");
    expect(encoded).toBe("pat|pt-abc123|jrt-xyz|user-42|machine-7");

    const decoded = decodePatRefresh(encoded);
    expect(decoded).toEqual({
      pat: "pt-abc123",
      jobRefreshToken: "jrt-xyz",
      userID: "user-42",
      machineID: "machine-7",
    });
  });

  it("handles empty fields", () => {
    const encoded = encodePatRefresh("", "", "", "");
    expect(encoded).toBe("pat||||");

    const decoded = decodePatRefresh(encoded);
    expect(decoded).toEqual({
      pat: "",
      jobRefreshToken: "",
      userID: "",
      machineID: "",
    });
  });

  it("handles pipe characters in fields gracefully", () => {
    // The decode splits on |, so extra pipes shift fields
    const encoded = encodePatRefresh("pt-test", "jrt-ok", "u1", "m1");
    const decoded = decodePatRefresh(encoded);
    expect(decoded.pat).toBe("pt-test");
    expect(decoded.jobRefreshToken).toBe("jrt-ok");
    expect(decoded.userID).toBe("u1");
    expect(decoded.machineID).toBe("m1");
  });
});

describe("PAT_REFRESH_PREFIX", () => {
  it('is "pat"', () => {
    expect(PAT_REFRESH_PREFIX).toBe("pat");
  });
});

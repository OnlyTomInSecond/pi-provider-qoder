import { describe, expect, it } from "vitest";
import { decodeRefresh, encodeDeviceRefresh } from "../auth/refresh.js";

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

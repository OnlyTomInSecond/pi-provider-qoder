import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearQoderAuthMemCache, getCachedCredentials, resolveQoderIdentity } from "../auth/oauth.js";
import { getAuthFilePath } from "../auth/storage.js";

const credential = {
  type: "oauth",
  access: "old",
  refresh: "valid-refresh",
  expires: 123456789,
  userID: "user",
  email: "test@example.com",
  name: "Test",
  machineID: "machine",
};

afterEach(() => {
  clearQoderAuthMemCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("@earendil-works/pi-coding-agent");
  vi.resetModules();
  rmSync(getAuthFilePath(), { force: true });
});

describe("credential ownership", () => {
  it("sees host refreshes and logout without clearing a plugin file cache", () => {
    writeFileSync(getAuthFilePath(), JSON.stringify({ qoder: credential }));
    expect(getCachedCredentials("old")?.refresh).toBe("valid-refresh");
    writeFileSync(getAuthFilePath(), JSON.stringify({ qoder: { ...credential, access: "new" } }));
    expect(getCachedCredentials("new")?.refresh).toBe("valid-refresh");
    expect(getCachedCredentials("old")).toBeNull();
    rmSync(getAuthFilePath());
    expect(getCachedCredentials()).toBeNull();
  });

  it("never overwrites refresh tokens or other providers when resolving identity", async () => {
    writeFileSync(getAuthFilePath(), JSON.stringify({ qoder: credential }));
    getCachedCredentials("old");
    const current = JSON.stringify({
      qoder: { ...credential, access: "new", userID: "" },
      other: { type: "api_key", key: "other" },
    });
    writeFileSync(getAuthFilePath(), current);
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "new-user" })));
    vi.stubGlobal("fetch", fetch);
    expect((await resolveQoderIdentity("new", "qoder", "global")).userID).toBe("new-user");
    await resolveQoderIdentity("new", "qoder", "global");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(readFileSync(getAuthFilePath(), "utf8")).toBe(current);
  });

  it("does not persist or memoize failed identity lookups", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("", { status: 401 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: "recovered" }))),
    );
    expect((await resolveQoderIdentity("token", "qoder", "global")).userID).toBe("qoder-user");
    expect((await resolveQoderIdentity("token", "qoder", "global")).userID).toBe("recovered");
    expect(existsSync(getAuthFilePath())).toBe(false);
  });

  it("honors PI_CODING_AGENT_DIR", () => {
    const dir = join(process.env.HOME as string, "custom-agent");
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ qoder: credential }));
    expect(getCachedCredentials()?.access).toBe("old");
  });
});

describe("environment credential writes", () => {
  it("uses modern host modify instead of the removed set API", async () => {
    const modify = vi.fn().mockImplementation(async (_id, fn) => fn(undefined));
    const create = vi.fn(() => ({ modify }));
    vi.doMock("@earendil-works/pi-coding-agent", () => ({ AuthStorage: { create } }));
    const { storeEnvironmentCredentials } = await import("../auth/storage.js");
    await storeEnvironmentCredentials("qoder", credential);
    expect(create).toHaveBeenCalledWith(getAuthFilePath());
    expect(modify).toHaveBeenCalledTimes(1);
  });

  it("does not bypass host write failures", async () => {
    vi.doMock("@earendil-works/pi-coding-agent", () => ({
      AuthStorage: {
        create: () => ({
          modify: async () => {
            throw new Error("locked");
          },
        }),
      },
    }));
    const { storeEnvironmentCredentials } = await import("../auth/storage.js");
    await expect(storeEnvironmentCredentials("qoder", credential)).rejects.toThrow("locked");
    expect(existsSync(getAuthFilePath())).toBe(false);
  });

  it("preserves other providers and refuses malformed files in the legacy fallback", async () => {
    vi.doMock("@earendil-works/pi-coding-agent", () => ({}));
    const { storeEnvironmentCredentials } = await import("../auth/storage.js");
    writeFileSync(getAuthFilePath(), JSON.stringify({ other: { key: "other" } }));
    await storeEnvironmentCredentials("qoder", credential);
    expect(JSON.parse(readFileSync(getAuthFilePath(), "utf8")).other).toEqual({ key: "other" });
    writeFileSync(getAuthFilePath(), "{broken");
    await expect(storeEnvironmentCredentials("qoder", credential)).rejects.toThrow();
    expect(readFileSync(getAuthFilePath(), "utf8")).toBe("{broken");
    expect(existsSync(`${getAuthFilePath()}.lock`)).toBe(false);
  });
});

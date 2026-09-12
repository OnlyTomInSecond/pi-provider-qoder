import { afterEach, describe, expect, it } from "vitest";
import {
  cacheQoderIdentityForTest,
  clearQoderAuthMemCache,
  getQoderIdentityCacheSizeForTest,
  hasQoderIdentityForTest,
  MAX_IDENTITY_CACHE_FOR_TEST,
  type QoderCredentials,
} from "../auth/oauth.js";

function fakeIdentity(access: string): QoderCredentials {
  return {
    access,
    refresh: "",
    expires: 0,
    userID: `user-${access}`,
    email: "",
    name: "",
    machineID: "",
  };
}

afterEach(() => {
  clearQoderAuthMemCache();
});

describe("identity memo bound", () => {
  it("never exceeds the cap and evicts the oldest entry", () => {
    const total = MAX_IDENTITY_CACHE_FOR_TEST + 5;
    for (let i = 0; i < total; i++) {
      cacheQoderIdentityForTest(`qoder:token-${i}`, fakeIdentity(`token-${i}`));
    }
    expect(getQoderIdentityCacheSizeForTest()).toBe(MAX_IDENTITY_CACHE_FOR_TEST);
  });

  it("keeps a re-inserted key (LRU recency)", () => {
    for (let i = 0; i < MAX_IDENTITY_CACHE_FOR_TEST; i++) {
      cacheQoderIdentityForTest(`qoder:token-${i}`, fakeIdentity(`token-${i}`));
    }
    // Refresh the oldest key, then overflow by one: token-0 must survive and
    // token-1 becomes the eviction candidate.
    cacheQoderIdentityForTest("qoder:token-0", fakeIdentity("token-0"));
    cacheQoderIdentityForTest("qoder:new", fakeIdentity("new"));
    expect(getQoderIdentityCacheSizeForTest()).toBe(MAX_IDENTITY_CACHE_FOR_TEST);
    expect(hasQoderIdentityForTest("qoder:token-0")).toBe(true);
    expect(hasQoderIdentityForTest("qoder:token-1")).toBe(false);
  });
});

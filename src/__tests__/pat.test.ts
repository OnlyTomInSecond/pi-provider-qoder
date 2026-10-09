import { afterEach, describe, expect, it, vi } from "vitest";
import { exchangeJobToken, fetchUserInfo } from "../auth/pat.js";
import { loadLiveFixture, responseFromFixture } from "./live-fixture.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recorded-format PAT protocol fixtures", () => {
  const fixture = loadLiveFixture("global");

  it("replays PAT exchange response shape", async () => {
    const interaction = fixture.interactions.patExchange;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseFromFixture(interaction)));

    const result = await exchangeJobToken("test-pat", "global");

    expect(result.jobToken).toBe("<redacted:job-token>");
    expect(result.jobRefreshToken).toBe("<redacted:refresh-token>");
    // Fixture ships expires_in: 86400000, which the API reports in
    // milliseconds (24h). Guard against the old seconds interpretation.
    expect(result.expiresAt).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    expect(result.expiresAt).toBeLessThan(Date.now() + 25 * 60 * 60 * 1000);
    expect(fetch).toHaveBeenCalledWith(
      interaction.request.url,
      expect.objectContaining({
        method: interaction.request.method,
        headers: expect.objectContaining({
          "Cosy-Version": interaction.request.headers["cosy-version"],
        }),
      }),
    );
  });

  it("replays userinfo response shape", async () => {
    const interaction = fixture.interactions.userinfo;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseFromFixture(interaction)));
    const body = interaction.response.body as { id: string; email: string; name: string };

    await expect(fetchUserInfo("test-job-token", "global")).resolves.toEqual({
      userID: body.id,
      email: body.email,
      name: body.name,
    });
  });
});

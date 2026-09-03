import { describe, expect, it } from "vitest";
import qoderPlugin, { createQoderAuthHooks } from "../opencode-auth.js";
import qoderCnPlugin from "../opencode-auth-cn.js";

async function getHooks(
  plugin: typeof qoderPlugin,
  options?: Record<string, unknown>,
): Promise<{ auth: NonNullable<Awaited<ReturnType<typeof plugin>>["auth"]> }> {
  return plugin({}, options);
}

describe("OpenCode auth plugin", () => {
  it("registers the global Qoder API-key login method", async () => {
    const hooks = await getHooks(qoderPlugin);

    expect(hooks.auth.provider).toBe("qoder");
    expect(hooks.auth.methods).toEqual([{ type: "api", label: "Qoder Personal Access Token" }]);
    expect(await hooks.auth.loader(async () => ({ type: "api", key: "  pt-global  " }))).toEqual({
      apiKey: "pt-global",
    });
  });

  it("selects the CN provider through plugin options", async () => {
    const hooks = await getHooks(qoderPlugin, { region: "cn" });

    expect(hooks.auth.provider).toBe("qoder-cn");
    expect(hooks.auth.methods[0]?.label).toBe("Qoder CN Personal Access Token");
  });

  it("exports a dedicated CN hook factory", async () => {
    const hooks = createQoderAuthHooks("cn");
    expect(hooks.auth.provider).toBe("qoder-cn");
    expect(await hooks.auth.loader(async () => undefined)).toEqual({});
  });

  it("keeps non-API credentials out of native provider options", async () => {
    const hooks = createQoderAuthHooks("global");
    expect(
      await hooks.auth.loader(async () => ({
        type: "oauth",
        access: "access",
        refresh: "refresh",
        expires: Date.now() + 60_000,
      })),
    ).toEqual({});
  });

  it("can be imported as the CN entrypoint", async () => {
    const hooks = await qoderCnPlugin({}, {});
    expect(hooks.auth.provider).toBe("qoder-cn");
  });
});

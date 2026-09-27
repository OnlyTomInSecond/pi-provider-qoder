import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const patEnvNames = [
  "QODER_API_KEY",
  "QODER_PERSONAL_ACCESS_TOKEN",
  "QODER_PAT",
  "QODERCN_API_KEY",
  "QODERCN_PERSONAL_ACCESS_TOKEN",
  "QODERCN_PAT",
] as const;
const originalPats = Object.fromEntries(patEnvNames.map((name) => [name, process.env[name]]));

function fakePi(calls: { unregistered: string[]; registered: string[]; commands: string[] }) {
  return {
    registerProvider: vi.fn((providerID: string) => {
      calls.registered.push(providerID);
    }),
    unregisterProvider: vi.fn((providerID: string) => {
      calls.unregistered.push(providerID);
    }),
    registerCommand: vi.fn((name: string) => {
      calls.commands.push(name);
    }),
    on: vi.fn(),
  };
}

function plantLegacyPackage(home: string, patched: boolean) {
  const dir = join(home, ".pi", "agent", "npm", "node_modules", "pi-provider-qoder", "dist");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "..", "package.json"),
    JSON.stringify({ name: "pi-provider-qoder", version: "0.4.5" }),
    "utf8",
  );
  if (patched) writeFileSync(join(dir, "index.js.orig-0.4.5"), "// pristine backup", "utf8");
}

afterEach(() => {
  rmSync(join(process.env.HOME as string, ".pi", "agent", "npm"), { recursive: true, force: true });
  for (const name of patEnvNames) {
    const value = originalPats[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("startup migration (F1 packaging)", () => {
  it("evicts the old package's registration and warns when it is on disk", async () => {
    for (const name of patEnvNames) delete process.env[name];
    plantLegacyPackage(process.env.HOME as string, true);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = { unregistered: [] as string[], registered: [] as string[], commands: [] as string[] };
    const pi = fakePi(calls);

    const { default: registerProviders } = await import("../index.js");
    await registerProviders(pi as never);

    expect(calls.unregistered).toContain("qoder");
    expect(calls.unregistered).toContain("qoder-cn");
    expect(calls.registered).toEqual(["qoder", "qoder-cn"]);
    expect(calls.commands).toContain("qoder-quota");
    const warning = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(warning).toContain("pi remove npm:pi-provider-qoder");
    expect(warning).toContain("index.js.orig-0.4.5");
  });

  it("does not evict anything when the old package is absent", async () => {
    for (const name of patEnvNames) delete process.env[name];
    const calls = { unregistered: [] as string[], registered: [] as string[], commands: [] as string[] };
    const pi = fakePi(calls);

    const { default: registerProviders } = await import("../index.js");
    await registerProviders(pi as never);

    expect(calls.unregistered).toEqual([]);
    expect(calls.registered).toEqual(["qoder", "qoder-cn"]);
    expect(calls.commands).toContain("qoder-quota");
  });
});

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getQoderStatePath } from "../home.js";

const agentDir = join(process.env.HOME as string, ".pi", "agent");
const legacy = join(agentDir, "qoder-state.json");
const current = join(agentDir, "qoder", "qoder-state.json");

afterEach(() => {
  rmSync(legacy, { force: true });
  rmSync(join(agentDir, "qoder"), { recursive: true, force: true });
  mkdirSync(join(agentDir, "qoder"), { recursive: true });
});

describe("qoder state path", () => {
  it("resolves files inside the dedicated qoder subdirectory", () => {
    expect(getQoderStatePath("qoder-models-cache.json")).toBe(join(agentDir, "qoder", "qoder-models-cache.json"));
  });

  it("migrates a file left in the agent dir by older versions", () => {
    writeFileSync(legacy, "legacy", "utf8");
    expect(getQoderStatePath("qoder-state.json")).toBe(current);
    expect(readFileSync(current, "utf8")).toBe("legacy");
    expect(existsSync(legacy)).toBe(false);
  });

  it("keeps the current file when both locations exist", () => {
    mkdirSync(join(agentDir, "qoder"), { recursive: true });
    writeFileSync(legacy, "legacy", "utf8");
    writeFileSync(current, "current", "utf8");
    expect(readFileSync(getQoderStatePath("qoder-state.json"), "utf8")).toBe("current");
  });
});

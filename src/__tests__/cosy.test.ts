import { describe, expect, it } from "vitest";
import {
  getQoderBaseUrl,
  getQoderCenterUrl,
  getQoderChatURL,
  getQoderCNDirectModel,
  getQoderCNFriendlyModelInfo,
  getQoderExchangeURL,
  getQoderManageUrl,
  getQoderMode,
  getQoderModelListURL,
  getQoderOpenApiUrl,
  getQoderRefreshURL,
  getQoderUsageURL,
  getQoderUserEmailFallback,
  getQoderUserInfoURL,
  isQoderCNMode,
  toQoderCNFriendlyModel,
} from "../cosy.js";

// ── getQoderMode ──────────────────────────────────────────────────────────

describe("getQoderMode", () => {
  it('returns "cn" for explicit CN variants', () => {
    expect(getQoderMode("cn")).toBe("cn");
    expect(getQoderMode("china")).toBe("cn");
    expect(getQoderMode("qodercn")).toBe("cn");
    expect(getQoderMode("qoder-cn")).toBe("cn");
    expect(getQoderMode("CN")).toBe("cn");
    expect(getQoderMode("China")).toBe("cn");
  });

  it('returns "global" for explicit global variants', () => {
    expect(getQoderMode("global")).toBe("global");
    expect(getQoderMode("intl")).toBe("global");
    expect(getQoderMode("international")).toBe("global");
    expect(getQoderMode("qoder")).toBe("global");
  });

  it("falls back to global for unknown strings", () => {
    expect(getQoderMode("unknown")).toBe("global");
    expect(getQoderMode("")).toBe("global");
  });
});

// ── isQoderCNMode ─────────────────────────────────────────────────────────

describe("isQoderCNMode", () => {
  it("returns true for CN modes", () => {
    expect(isQoderCNMode("cn")).toBe(true);
    expect(isQoderCNMode("china")).toBe(true);
  });

  it("returns false for global modes", () => {
    expect(isQoderCNMode("global")).toBe(false);
    expect(isQoderCNMode("intl")).toBe(false);
  });
});

// ── URL builders ──────────────────────────────────────────────────────────

describe("getQoderBaseUrl", () => {
  it("returns CN URL for cn mode", () => {
    expect(getQoderBaseUrl("cn")).toBe("https://gateway.qoder.com.cn/");
  });

  it("returns global URL for global mode", () => {
    expect(getQoderBaseUrl("global")).toBe("https://api3.qoder.sh/");
  });
});

describe("getQoderOpenApiUrl", () => {
  it("returns CN URL for cn mode", () => {
    expect(getQoderOpenApiUrl("cn")).toBe("https://openapi.qoder.com.cn");
  });

  it("returns global URL for global mode", () => {
    expect(getQoderOpenApiUrl("global")).toBe("https://openapi.qoder.sh");
  });
});

describe("getQoderCenterUrl", () => {
  it("returns CN URL for cn mode", () => {
    expect(getQoderCenterUrl("cn")).toBe("https://gateway.qoder.com.cn");
  });

  it("returns global URL for global mode", () => {
    expect(getQoderCenterUrl("global")).toBe("https://center.qoder.sh");
  });
});

describe("getQoderModelListURL", () => {
  it("constructs correct CN URL", () => {
    expect(getQoderModelListURL("cn")).toBe("https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1");
  });

  it("constructs correct global URL", () => {
    expect(getQoderModelListURL("global")).toBe("https://api3.qoder.sh/algo/api/v2/model/list?Encode=1");
  });
});

describe("getQoderChatURL", () => {
  it("contains base URL and chat path", () => {
    const url = getQoderChatURL("global");
    expect(url).toContain("https://api3.qoder.sh/");
    expect(url).toContain("algo/api/v2/service/pro/sse/agent_chat_generation");
    expect(url).toContain("Encode=1");
  });
});

describe("getQoderExchangeURL", () => {
  it("constructs correct CN URL", () => {
    expect(getQoderExchangeURL("cn")).toBe("https://openapi.qoder.com.cn/api/v1/jobToken/exchange");
  });

  it("constructs correct global URL", () => {
    expect(getQoderExchangeURL("global")).toBe("https://openapi.qoder.sh/api/v1/jobToken/exchange");
  });
});

describe("getQoderUserInfoURL", () => {
  it("constructs correct URL", () => {
    expect(getQoderUserInfoURL("global")).toBe("https://openapi.qoder.sh/api/v1/userinfo");
  });
});

describe("getQoderUsageURL", () => {
  it("constructs correct URL", () => {
    expect(getQoderUsageURL("global")).toBe("https://openapi.qoder.sh/api/v2/quota/usage");
  });
});

describe("getQoderRefreshURL", () => {
  it("constructs correct CN URL", () => {
    expect(getQoderRefreshURL("cn")).toBe("https://gateway.qoder.com.cn/algo/api/v3/user/refresh_token");
  });

  it("constructs correct global URL", () => {
    expect(getQoderRefreshURL("global")).toBe("https://center.qoder.sh/algo/api/v3/user/refresh_token");
  });
});

describe("getQoderManageUrl", () => {
  it("returns CN URL", () => {
    expect(getQoderManageUrl("cn")).toBe("https://qoder.com.cn");
  });

  it("returns global URL", () => {
    expect(getQoderManageUrl("global")).toBe("https://qoder.com");
  });
});

describe("getQoderUserEmailFallback", () => {
  it("returns CN email", () => {
    expect(getQoderUserEmailFallback("cn")).toBe("user@qoder.com.cn");
  });

  it("returns global email", () => {
    expect(getQoderUserEmailFallback("global")).toBe("user@qoder.com");
  });
});

// ── getQoderCNDirectModel ─────────────────────────────────────────────────

describe("getQoderCNDirectModel", () => {
  it("maps known model IDs to internal keys", () => {
    expect(getQoderCNDirectModel("qoder-cn")).toBe("auto");
    expect(getQoderCNDirectModel("qwen3.7-max")).toBe("qmodel_latest");
    expect(getQoderCNDirectModel("qwen3.7-plus")).toBe("qmodel");
    expect(getQoderCNDirectModel("qwen3.6-plus")).toBe("qmodel");
    expect(getQoderCNDirectModel("qwen3.6-flash")).toBe("q36fmodel");
    expect(getQoderCNDirectModel("deepseek-v4-pro")).toBe("dmodel");
    expect(getQoderCNDirectModel("deepseek-v4-flash")).toBe("dfmodel");
    expect(getQoderCNDirectModel("glm-5.2")).toBe("gm51model");
    expect(getQoderCNDirectModel("glm-5.1")).toBe("gm51model");
    expect(getQoderCNDirectModel("kimi-k2.6")).toBe("kmodel");
    expect(getQoderCNDirectModel("minimax-m2.7")).toBe("mmodel");
    expect(getQoderCNDirectModel("minimax-m3")).toBe("mmodel");
  });

  it("returns the input ID for unknown models", () => {
    expect(getQoderCNDirectModel("custom-model")).toBe("custom-model");
  });

  it('defaults to "auto" when no input', () => {
    expect(getQoderCNDirectModel()).toBe("auto");
    expect(getQoderCNDirectModel("")).toBe("auto");
  });
});

// ── getQoderCNFriendlyModelInfo ───────────────────────────────────────────

describe("getQoderCNFriendlyModelInfo", () => {
  it("returns known friendly info for mapped keys", () => {
    const info = getQoderCNFriendlyModelInfo("qmodel_latest");
    expect(info.id).toBe("qwen3.7-max");
    expect(info.name).toBe("Qwen 3.7 Max · Qoder CN");
  });

  it("returns auto mapping", () => {
    const info = getQoderCNFriendlyModelInfo("auto");
    expect(info.id).toBe("auto");
    expect(info.name).toBe("Auto · Qoder CN");
  });

  it("generates friendly name for unknown keys", () => {
    const info = getQoderCNFriendlyModelInfo("my-custom-model", "My Custom Model");
    expect(info.id).toBe("my-custom-model");
    expect(info.name).toContain("Qoder CN");
  });

  it("prettifies model names with version numbers", () => {
    const info = getQoderCNFriendlyModelInfo("some-model", "Qwen3.7-New");
    expect(info.name).toContain("Qwen 3.7");
    expect(info.name).toContain("Qoder CN");
  });
});

// ── toQoderCNFriendlyModel ────────────────────────────────────────────────

describe("toQoderCNFriendlyModel", () => {
  it("maps known model ID to friendly version", () => {
    const result = toQoderCNFriendlyModel({ id: "qmodel_latest", name: "Original Name" });
    expect(result.id).toBe("qwen3.7-max");
    expect(result.name).toBe("Qwen 3.7 Max · Qoder CN");
  });

  it("preserves extra fields", () => {
    const result = toQoderCNFriendlyModel({ id: "auto", name: "Auto", extra: "field" } as {
      id: string;
      name: string;
      extra: string;
    });
    expect(result.extra).toBe("field");
  });

  it("handles unknown models by prettifying display name", () => {
    const result = toQoderCNFriendlyModel({ id: "custom", name: "CustomModel V2-Pro" });
    expect(result.id).toBe("custom");
    expect(result.name).toContain("Qoder CN");
  });
});

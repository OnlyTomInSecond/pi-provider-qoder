# @local/dsh-llm-qoder

让 DeepSeek Harness 直接使用 **Qoder** 的模型与额度。协议层（PAT/刷新令牌、COSY 签名、模型目录、SSE 网关、thinking/DSML 工具调用处理）复用 `pi-provider-qoder` 的已验证实现，本包只保留 DSH 适配层。

## 安装

已通过 DSH 插件管理器（`plugin_manager` 的 `install_bundle`）安装到当前 `web` profile；包内 `cordis.patch.yml` 会插入 `llm-qoder` 行，并同时注册 `qoder`（国际区）和 `qoder-cn`（中国区）两条路由。未在 Models 页添加的区域不会出现在模型选择器里。

修改代码后运行 `node build.mjs` 重新生成 `index.js`，再对同一目录执行一次 `remove_bundle` + `install_bundle`，让 Harness 加载新的模块代。

## 凭据

只使用 DSH 自己的凭据体系，不读取 `~/.pi/` 或任何其他 Agent 的登录状态。

推荐方式：**Settings → Models → Add provider**，在供应商列表里选择 `Qoder` 或 `Qoder CN`，按官方 DeepSeek 同样的卡片填写访问令牌并 Apply。令牌写入 DSH 凭据存储的 `QODER_API_KEY`（CN 为 `QODER_CN_API_KEY`）引用，不进入配置文件；保存后下一次请求立即生效。已添加的 Qoder 行可以直接 Edit 修改令牌，或用官方 Remove 删除（同时删除凭据引用）。

也支持：

1. 环境变量：`QODER_API_KEY` / `QODER_PERSONAL_ACCESS_TOKEN` / `QODER_PAT`（CN 用 `QODERCN_*`）
2. DSH 凭据记录 `llm-qoder/qoder`（PAT 换取的 job token 及刷新后的令牌会写回这里）

输入值以 `pt-` 开头时按 PAT 换取短时 job token；否则按 `jt-` 访问令牌直接使用。模型目录缓存同样只落在 `$DSH_HOME/qoder/`。

## 使用

Host 侧安装后立即生效。**Settings → Models → Add provider** 中会列出 `Qoder` 和 `Qoder CN`；添加后模型选择器出现对应模型（以 Qoder 实时目录为准）。Models 页对任何「profile 只有 `apiKeyEnv` 一个字段」的供应商复用同一张 key-only 卡片，不需要供应商专属 UI。

该卡片复用 DSH 官方 API-key 输入与 Apply/Remove 流程；DSH checkout 的 `packages/client/ui-settings-models/src/client/ProviderEditor.tsx` 只增加了按 schema 形状识别的 `key-only` 布局。已用 `pnpm --filter @deepseek-ai/dsh-client-ui-settings-models bundle` 重建 `lib/client.js`；刷新页面加载新 Models UI。

想把 Qoder 设为默认模型，在 profile patch 中覆盖：

```yaml
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: qoder
    model: Qwen3.8-Flash
```

## 配置

```yaml
- id: llm-qoder
  name: '@local/dsh-llm-qoder'
  config:
    persistCredentials: true   # 刷新后的凭据写入 DSH 凭据记录
    streamIdleTimeoutMs: 120000
```

## 两个区域

| | `qoder`（国际） | `qoder-cn`（中国） |
|---|---|---|
| 网关 | `api3.qoder.sh` | `gateway.qoder.com.cn` |
| 凭据引用 | `QODER_API_KEY` | `QODER_CN_API_KEY` |
| 环境变量 | `QODER_*` | `QODERCN_*` |
| 模型目录缓存 | `$DSH_HOME/qoder/qoder-models-cache.json` | `$DSH_HOME/qoder/qoder-cn-models-cache.json` |

两者是**独立账号、独立额度、独立模型目录**，因此必须作为两条 provider 路由存在；这与 pi 插件的做法一致。区别只在区域配置和凭据，适配层与协议实现完全共用。两条路由始终注册，是否使用由 Models 页是否添加（以及是否有对应凭据）决定。

## 实现结构

| 文件 | 作用 |
|---|---|
| `src/index.ts` | DSH provider 路由、模型元数据、流式调用入口 |
| `src/qoder-credentials.ts` | DSH 凭据引用 / DSH 记录 / 环境变量的解析与刷新 |
| `src/pi-context.ts` | DSH 消息与工具 → pi transcript |
| `src/stream-bridge.ts` | pi 事件 → DSH `StreamChunk` |
| `src/qoder/` | 从 `pi-provider-qoder` 移植的 Qoder 协议实现 |

## 验证

```bash
node build.mjs
node scripts/smoke.mjs                              # 实时目录
QODER_API_KEY=... QODER_SMOKE_STREAM=1 node scripts/smoke.mjs  # 真实流式
```

模型目录、真实流式和 DSH `headless` 端到端均已验证。`headless` profile 默认不挂载 settings/credentials，因此流式冒烟需要显式传 `QODER_API_KEY`/`QODER_ACCESS_TOKEN`；这是 DSH 启动环境变量，不涉及 pi 配置。

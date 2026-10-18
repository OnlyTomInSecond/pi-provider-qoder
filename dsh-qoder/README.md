# @local/dsh-llm-qoder

让 DeepSeek Harness 直接使用 **Qoder** 的模型与额度。协议层（PAT/刷新令牌、COSY 签名、模型目录、SSE 网关、thinking/DSML 工具调用处理）复用 `pi-provider-qoder` 的已验证实现，本包只保留 DSH 适配层。

## 从源码安装

### 0. 准备

- Node.js 22+ 与 `pnpm`（DSH 自身需要）
- 可运行的 DSH：源码 checkout，或已安装的 `dsh` CLI
- Git

插件本身没有运行时依赖，Qoder 协议层会打进 `index.js`；构建期依赖只有 `esbuild` 与 `@deepseek-ai/schemastery`。

### 1. 下载并构建

```bash
git clone https://github.com/simonsmh/pi-provider-qoder.git
cd pi-provider-qoder/dsh-qoder
npm install
npm run build
```

`npm install` 安装构建期依赖，`npm run build` 生成 `index.js`。有 lockfile 时也可以用 `npm ci`。

### 2. 安装到 DSH profile

下面以 Web UI 使用的 `web` profile 为例；其他 profile 换成对应名字。**必须使用绝对路径**：`installBundle` 最终执行 `pnpm add <spec>`，工作目录是 profile 目录，只有 `./`、`../` 会相对调用方解析，裸相对路径会落到 `~/.dsh/profiles/<profile>/` 下。

**方式 A：Agent 工具（推荐）**

```
plugin_manager(action="install_bundle", target="/绝对路径/pi-provider-qoder/dsh-qoder")
```

**方式 B：DSH CLI**

```bash
dsh plugin --profile web add /绝对路径/pi-provider-qoder/dsh-qoder
```

如果 DSH 是源码 checkout、没有全局 `dsh`：

```bash
cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add /绝对路径/pi-provider-qoder/dsh-qoder
```

**方式 C：Web UI**

侧边栏 **Plugins → Add plugin**，填入同一个绝对路径，确认安装。

安装后：

- profile 的 `package.json` 增加 `"@local/dsh-llm-qoder": "link:/.../dsh-qoder"`
- `dsh.profile.bundles` 末尾加入 `@local/dsh-llm-qoder`
- 包内 `cordis.patch.yml` 插入 `llm-qoder` 行，同时注册 `qoder` 与 `qoder-cn` 两条路由

### 3. Models 页的 key-only 布局

Qoder 的 provider profile 只有一个 `apiKeyEnv` 字段。DSH 官方的 Models 页只内置了 `llm-deepseek` 和 `llm-pi-ai` 两种布局；未打补丁时，Add provider 对未知命名空间只显示提示，无法输入 key。

- 如果 DSH 源码已经包含 `key-only` 布局（`packages/client/ui-settings-models/src/client/ProviderEditor.tsx` 里的 `isKeyOnlyProfile`），跳过本节。
- 否则在 DSH checkout 应用补丁并重建 client bundle：

```bash
cd /path/to/deepseek-harness
git apply /绝对路径/pi-provider-qoder/dsh-qoder/patches/dsh-models-key-only.patch
pnpm --filter @deepseek-ai/dsh-client-ui-settings-models bundle
```

补丁只做一件事：任何 profile 只有 `apiKeyEnv` 的 provider，都复用官方 API-key 卡片，没有任何 Qoder 专属代码。补丁基于 DSH `0.2.1-rc.2`；版本不同导致上下文不匹配时，按 `isKeyOnlyProfile` 与 `layoutOf` 的几行手动合并即可。

- 如果使用**已安装的发行版**、无法给 DSH 打补丁，改用「无 UI 配置」：在 profile patch 写入 provider profile，并用环境变量提供 token：

```yaml
- id: llm-qoder
  name: '@local/dsh-llm-qoder'
  config:
    providers:
      qoder:
        apiKeyEnv: QODER_API_KEY
```

```bash
QODER_API_KEY=pt-... dsh web   # 或该安装的启动命令
```

CN 区把 `qoder` / `QODER_API_KEY` 换成 `qoder-cn` / `QODER_CN_API_KEY`。

### 4. 验证

- 重启或刷新后，**Settings → Models → Add provider** 应出现 `Qoder` / `Qoder CN`。
- 添加 token 后，模型选择器出现对应模型。
- 命令行检查 composed config：`dsh --profile web --dump-config | grep -A3 llm-qoder`
- `~/.dsh/qoder/` 出现目录缓存，说明后台实时目录刷新成功（首次使用可能先显示内置静态模型）。

### 5. 更新

```bash
cd pi-provider-qoder/dsh-qoder
npm run build
```

然后对同一目录再执行一次 remove + install，让 Harness 导入新的模块代：

```
plugin_manager(action="remove_bundle", target="@local/dsh-llm-qoder")
plugin_manager(action="install_bundle", target="/绝对路径/pi-provider-qoder/dsh-qoder")
```

如果改动了 DSH 的 client bundle（例如 `ProviderEditor.tsx`），重新执行 `pnpm --filter @deepseek-ai/dsh-client-ui-settings-models bundle`，并硬刷新页面。

### 6. 卸载

- Agent：`plugin_manager(action="remove_bundle", target="@local/dsh-llm-qoder")`
- Web：**Plugins** 页找到该 bundle，点 **Remove**

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

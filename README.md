# pi-provider-qoder

A [pi](https://shittycodingagent.ai/) extension that connects pi to Qoder.

```bash
pi install npm:pi-provider-qoder
```

```bash
pi --provider qoder --model Lite
pi --provider qoder-cn --model Qwen3.7-Plus
```

Inside pi:

```text
/login qoder
/model Qwen3.8-Max
```

## OpenCode

OpenCode cannot use Qoder through the generic OpenAI-compatible provider: Qoder requires COSY authentication headers, encoded request bodies, and an envelope-wrapped SSE response. This package therefore also publishes a native OpenCode provider at `pi-provider-qoder/opencode`.

Add the provider and models explicitly to `opencode.json` (OpenCode's current V2 provider format):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "qoder/Lite",
  "providers": {
    "qoder": {
      "name": "Qoder (global)",
      "env": ["QODER_API_KEY", "QODER_PERSONAL_ACCESS_TOKEN", "QODER_PAT"],
      "package": "pi-provider-qoder/opencode",
      "settings": { "region": "global" },
      "models": {
        "Lite": {
          "name": "Qoder Lite",
          "capabilities": {
            "tools": true,
            "input": ["text"],
            "output": ["text"]
          },
          "limit": { "context": 1000000, "output": 131072 }
        },
        "Qwen3.8-Max": {
          "name": "Qwen3.8 Max",
          "capabilities": {
            "tools": true,
            "input": ["text", "image"],
            "output": ["text"]
          },
          "limit": { "context": 1000000, "output": 131072 }
        }
      }
    },
    "qoder-cn": {
      "name": "Qoder CN",
      "env": ["QODERCN_API_KEY", "QODERCN_PERSONAL_ACCESS_TOKEN", "QODERCN_PAT"],
      "package": "pi-provider-qoder/opencode",
      "settings": { "region": "cn" },
      "models": {
        "Qwen3.7-Plus": {
          "name": "Qwen3.7 Plus",
          "capabilities": { "tools": true, "input": ["text"], "output": ["text"] },
          "limit": { "context": 1000000, "output": 131072 }
        }
      }
    }
  }
}
```

Use either a Qoder PAT (`pt-...`) or an already exchanged job token. OpenCode resolves credentials from the configured `env` variables or `/connect`; the adapter exchanges PATs automatically. For local development, replace the package value with `file:///home/you/src/pi-provider-qoder/dist/opencode.js` after running `npm run build`.

The OpenCode adapter supports Qoder text/image input, reasoning output, native and DSML tool calls, usage metadata, global/CN endpoints, and both environment/API-key authentication. Model discovery is intentionally explicit in `opencode.json`; Qoder's private model-list endpoint requires the same COSY identity exchange and is not queried by OpenCode automatically.

### OpenCode stable auth plugin

The native provider package alone cannot register a custom provider in OpenCode's `/connect` picker. Stable OpenCode also supports a server plugin auth hook. This package publishes one for Qoder PAT login:

```jsonc
{
  "plugin": [
    "pi-provider-qoder/opencode-auth",
    "pi-provider-qoder/opencode-auth-cn"
  ]
}
```

For local development, use absolute file URLs instead:

```jsonc
{
  "plugin": [
    "file:///home/you/src/pi-provider-qoder/dist/opencode-auth.js",
    "file:///home/you/src/pi-provider-qoder/dist/opencode-auth-cn.js"
  ]
}
```

The first entry registers `qoder`; the second registers `qoder-cn`. After `npm run build`, run either `/connect` in the TUI or:

```bash
opencode auth login --provider qoder
opencode auth login --provider qoder-cn
```

OpenCode stores the PAT in its global auth store and passes it to the native package as `settings.apiKey`. The provider exchanges `pt-...` PATs for short-lived job tokens when the first request is made. This auth hook targets stable `opencode`; the separate `opencode2` V2 plugin API currently cannot add a new integration that is absent from Models.dev.

## Providers

Both providers register together.

### `qoder` (global)

- `https://api3.qoder.sh/`
- Login: `/login qoder` (browser OAuth or PAT)
- PAT page: https://qoder.com/account/integrations
- Env (first match): `QODER_API_KEY`, `QODER_PERSONAL_ACCESS_TOKEN`, `QODER_PAT`

### `qoder-cn` (China)

- `https://gateway.qoder.com.cn/`
- Login: `/login qoder-cn` (PAT only)
- PAT page: https://qoder.com.cn/account/integrations
- Env (first match): `QODERCN_API_KEY`, `QODERCN_PERSONAL_ACCESS_TOKEN`, `QODERCN_PAT`

A PAT (`pt-...`) is exchanged for a job token. Setting any of those env vars logs the provider in at startup.

## Models

Model IDs are the catalog `display_name` with whitespace stripped. After login, `/model` lists what that region offers.

Examples: `Lite`, `Qwen3.8-Max`, `Qwen3.7-Plus`, `Qwen3.8-Flash`.

Context uses the largest live catalog option (often 1M). Output is 128K.

## Endpoints

| | Global (`qoder`) | China (`qoder-cn`) |
| --- | --- | --- |
| PAT exchange | `https://openapi.qoder.sh/api/v1/jobToken/exchange` | `https://openapi.qoder.com.cn/api/v1/jobToken/exchange` |
| User info | `https://openapi.qoder.sh/api/v1/userinfo` | `https://openapi.qoder.com.cn/api/v1/userinfo` |
| Usage | `https://openapi.qoder.sh/api/v2/quota/usage` | `https://openapi.qoder.com.cn/api/v2/quota/usage` |
| Chat gateway | `https://api3.qoder.sh/` | `https://gateway.qoder.com.cn/` |

## License

MIT

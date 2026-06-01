# 使用第三方模型（OpenAI / DeepSeek / 本地模型）

本项目基于 Anthropic 协议与 LLM 通信。通过协议转换代理，可以使用 OpenAI、DeepSeek、Ollama 等任意模型。

## 原理

```
claude-code-haha ──Anthropic协议──▶ LiteLLM Proxy ──OpenAI协议──▶ 目标模型 API
                                      (协议转换)
```

本项目发出 Anthropic Messages API 请求，LiteLLM 代理将其自动转换为 OpenAI Chat Completions API 格式并转发给目标模型。

---

## 方式一：LiteLLM 代理（推荐）

[LiteLLM](https://github.com/BerriAI/litellm) 是一个支持 100+ LLM 的统一代理网关（41k+ GitHub Stars），原生支持接收 Anthropic 协议请求。

### 1. 安装 LiteLLM

```bash
pip install 'litellm[proxy]'
```

### 2. 创建配置文件

新建 `litellm_config.yaml`：

#### 使用 OpenAI 模型

```yaml
model_list:
  - model_name: gpt-4o
    litellm_params:
      model: openai/gpt-4o
      api_key: os.environ/OPENAI_API_KEY

litellm_settings:
  drop_params: true  # 丢弃 Anthropic 专有参数（thinking 等）
```

#### 使用 DeepSeek 模型

```yaml
model_list:
  - model_name: deepseek-chat
    litellm_params:
      model: deepseek/deepseek-chat
      api_key: os.environ/DEEPSEEK_API_KEY
      api_base: https://api.deepseek.com

litellm_settings:
  drop_params: true
```

#### 使用 Ollama 本地模型

```yaml
model_list:
  - model_name: llama3
    litellm_params:
      model: ollama/llama3
      api_base: http://localhost:11434

litellm_settings:
  drop_params: true
```

#### 使用多个模型（可在启动后切换）

```yaml
model_list:
  - model_name: gpt-4o
    litellm_params:
      model: openai/gpt-4o
      api_key: os.environ/OPENAI_API_KEY

  - model_name: deepseek-chat
    litellm_params:
      model: deepseek/deepseek-chat
      api_key: os.environ/DEEPSEEK_API_KEY
      api_base: https://api.deepseek.com

  - model_name: llama3
    litellm_params:
      model: ollama/llama3
      api_base: http://localhost:11434

litellm_settings:
  drop_params: true
```

### 3. 启动代理

```bash
# 设置目标模型的 API Key
export OPENAI_API_KEY=sk-xxx
# 或
export DEEPSEEK_API_KEY=sk-xxx

# 启动代理
litellm --config litellm_config.yaml --port 4000
```

代理启动后会在 `http://localhost:4000` 监听，并暴露 Anthropic 兼容的 `/v1/messages` 端点。

### 4. 配置本项目

有两种配置方式，任选其一：

#### 方式 A：通过 `.env` 文件

```bash
ANTHROPIC_AUTH_TOKEN=sk-anything
ANTHROPIC_BASE_URL=http://localhost:4000
ANTHROPIC_MODEL=gpt-4o
ANTHROPIC_DEFAULT_SONNET_MODEL=gpt-4o
ANTHROPIC_DEFAULT_HAIKU_MODEL=gpt-4o
ANTHROPIC_DEFAULT_OPUS_MODEL=gpt-4o
API_TIMEOUT_MS=3000000
DISABLE_TELEMETRY=1
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

#### 方式 B：通过 `~/.claude/settings.json`

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-anything",
    "ANTHROPIC_BASE_URL": "http://localhost:4000",
    "ANTHROPIC_MODEL": "gpt-4o",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-4o",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-4o",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "gpt-4o",
    "API_TIMEOUT_MS": "3000000",
    "DISABLE_TELEMETRY": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

> **说明**：`ANTHROPIC_AUTH_TOKEN` 的值在使用 LiteLLM 代理时可以是任意字符串（LiteLLM 会用自己配置的 key 转发），除非你在 LiteLLM 端设置了 `master_key` 校验。

### 5. 启动并验证

```bash
./bin/claude-haha
```

如果一切正常，你应该能看到正常的对话界面，实际调用的是你配置的目标模型。

---

## 方式二：直连兼容 Anthropic 协议的第三方服务

部分第三方服务直接兼容 Anthropic Messages API，无需额外代理：

### OpenRouter

```bash
ANTHROPIC_AUTH_TOKEN=sk-or-v1-xxx
ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1
ANTHROPIC_MODEL=openai/gpt-4o
ANTHROPIC_DEFAULT_SONNET_MODEL=openai/gpt-4o
ANTHROPIC_DEFAULT_HAIKU_MODEL=openai/gpt-4o-mini
ANTHROPIC_DEFAULT_OPUS_MODEL=openai/gpt-4o
DISABLE_TELEMETRY=1
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

### MiniMax（已在 .env.example 中配置）

MiniMax 提供 Anthropic 兼容接口，支持直接接入，无需代理。可用模型：

| 模型 | 说明 |
|------|------|
| `MiniMax-M3` | 默认推荐，最新一代综合性能优秀 |
| `MiniMax-M2.7` | 上一代稳定版本 |
| `MiniMax-M2.7-highspeed` | 响应更快，适合对速度有要求的场景 |

```bash
ANTHROPIC_AUTH_TOKEN=your_minimax_api_key_here
# 海外用户使用 api.minimax.io，国内用户可改为 api.minimaxi.com
ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic
ANTHROPIC_MODEL=MiniMax-M3
ANTHROPIC_DEFAULT_SONNET_MODEL=MiniMax-M3
ANTHROPIC_DEFAULT_HAIKU_MODEL=MiniMax-M2.7-highspeed
ANTHROPIC_DEFAULT_OPUS_MODEL=MiniMax-M3
API_TIMEOUT_MS=3000000
DISABLE_TELEMETRY=1
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

> **获取 API Key**：访问 [MiniMax 开放平台](https://platform.minimax.io) 注册并获取 API Key。

---

## 方式三：其他代理工具

社区还有一些专门为 Claude Code 做的代理工具：

| 工具 | 说明 | 链接 |
|------|------|------|
| **a2o** | Anthropic → OpenAI 单二进制文件，零依赖 | [Twitter](https://x.com/mantou543/status/2018846154855940200) |
| **Empero Proxy** | 完整的 Anthropic Messages API 转 OpenAI 代理 | [Twitter](https://x.com/EmperoAI/status/2036840854065762551) |
| **Alma** | 内置 OpenAI → Anthropic 转换代理的客户端 | [Twitter](https://x.com/yetone/status/2003508782127833332) |
| **Chutes** | Docker 容器，支持 60+ 开源模型 | [Twitter](https://x.com/chutes_ai/status/2027039742915662232) |

---

## 注意事项与已知限制

### 1. `drop_params: true` 很重要

本项目会发送 Anthropic 专有参数（如 `thinking`、`cache_control`），这些参数在 OpenAI API 中不存在。LiteLLM 配置中必须设置 `drop_params: true`，否则请求会报错。

### 2. Extended Thinking 不可用

Anthropic 的 Extended Thinking 功能是专有特性，其他模型不支持。使用第三方模型时此功能自动失效。

### 3. Prompt Caching 不可用

`cache_control` 是 Anthropic 专有功能。使用第三方模型时，prompt caching 不会生效（但不会导致报错，会被 `drop_params` 忽略）。

### 4. 工具调用兼容性

本项目大量使用工具调用（tool_use），LiteLLM 会自动转换 Anthropic tool_use 格式到 OpenAI function_calling 格式。大部分情况下可以正常工作，但某些复杂工具调用可能存在兼容性问题。如遇问题，建议使用能力较强的模型（如 GPT-4o）。

### 5. 遥测和非必要网络请求

建议配置以下环境变量以避免不必要的网络请求：
```
DISABLE_TELEMETRY=1
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

---

## FAQ

### Q: LiteLLM 代理报错 `/v1/responses` 找不到？

部分 OpenAI 兼容服务只支持 `/v1/chat/completions`。在 LiteLLM 配置中添加：

```yaml
litellm_settings:
  use_chat_completions_url_for_anthropic_messages: true
```

### Q: `ANTHROPIC_API_KEY` 和 `ANTHROPIC_AUTH_TOKEN` 有什么区别？

- `ANTHROPIC_API_KEY` → 通过 `x-api-key` 请求头发送
- `ANTHROPIC_AUTH_TOKEN` → 通过 `Authorization: Bearer` 请求头发送

LiteLLM 代理默认接受 Bearer Token 格式，建议使用 `ANTHROPIC_AUTH_TOKEN`。

### Q: 可以同时配置多个模型吗？

可以。在 `litellm_config.yaml` 中配置多个 `model_name`，然后通过修改 `ANTHROPIC_MODEL` 切换。

### Q: 本地 Ollama 模型效果不好怎么办？

本项目的系统提示和工具调用对模型能力要求较高。建议使用参数量较大的模型（如 Llama 3 70B+, Qwen 72B+），小模型可能无法正确处理工具调用。

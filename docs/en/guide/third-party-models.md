# Using Third-Party Models (OpenAI / DeepSeek / Local Models)

This project communicates with LLMs via the Anthropic protocol. By using a protocol translation proxy, you can use any model including OpenAI, DeepSeek, Ollama, etc.

## How It Works

```
claude-code-haha ──Anthropic protocol──▶ LiteLLM Proxy ──OpenAI protocol──▶ Target Model API
                                          (translation)
```

This project sends Anthropic Messages API requests. The LiteLLM proxy automatically translates them to OpenAI Chat Completions API format and forwards them to the target model.

---

## Option 1: LiteLLM Proxy (Recommended)

[LiteLLM](https://github.com/BerriAI/litellm) is a unified proxy gateway supporting 100+ LLMs (41k+ GitHub Stars), with native support for receiving Anthropic protocol requests.

### 1. Install LiteLLM

```bash
pip install 'litellm[proxy]'
```

### 2. Create Configuration File

Create `litellm_config.yaml`:

#### Using OpenAI Models

```yaml
model_list:
  - model_name: gpt-4o
    litellm_params:
      model: openai/gpt-4o
      api_key: os.environ/OPENAI_API_KEY

litellm_settings:
  drop_params: true  # Drop Anthropic-specific params (thinking, etc.)
```

#### Using DeepSeek Models

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

#### Using Ollama Local Models

```yaml
model_list:
  - model_name: llama3
    litellm_params:
      model: ollama/llama3
      api_base: http://localhost:11434

litellm_settings:
  drop_params: true
```

#### Using Multiple Models (switchable after startup)

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

### 3. Start the Proxy

```bash
# Set your target model's API key
export OPENAI_API_KEY=sk-xxx
# or
export DEEPSEEK_API_KEY=sk-xxx

# Start the proxy
litellm --config litellm_config.yaml --port 4000
```

The proxy will listen on `http://localhost:4000` and expose an Anthropic-compatible `/v1/messages` endpoint.

### 4. Configure This Project

Choose one of two configuration methods:

#### Method A: Via `.env` File

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

#### Method B: Via `~/.claude/settings.json`

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

> **Note**: The `ANTHROPIC_AUTH_TOKEN` value can be any string when using the LiteLLM proxy (LiteLLM uses its own configured key for forwarding), unless you've set a `master_key` on the LiteLLM side.

### 5. Start and Verify

```bash
./bin/claude-haha
```

If everything is configured correctly, you should see the normal chat interface, with your configured target model handling the requests.

---

## Option 2: Direct Connection to Anthropic-Compatible Services

Some third-party services directly support the Anthropic Messages API, no proxy needed:

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

### MiniMax (pre-configured in .env.example)

MiniMax provides an Anthropic-compatible API endpoint and can be connected directly without any proxy. Available models:

| Model | Description |
|-------|-------------|
| `MiniMax-M3` | Default recommended, latest generation with excellent overall performance |
| `MiniMax-M2.7` | Previous stable release |
| `MiniMax-M2.7-highspeed` | Faster responses, suitable for latency-sensitive use cases |

```bash
ANTHROPIC_AUTH_TOKEN=your_minimax_api_key_here
# International users: api.minimax.io; China users may use api.minimaxi.com
ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic
ANTHROPIC_MODEL=MiniMax-M3
ANTHROPIC_DEFAULT_SONNET_MODEL=MiniMax-M3
ANTHROPIC_DEFAULT_HAIKU_MODEL=MiniMax-M2.7-highspeed
ANTHROPIC_DEFAULT_OPUS_MODEL=MiniMax-M3
API_TIMEOUT_MS=3000000
DISABLE_TELEMETRY=1
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

> **Get API Key**: Visit [MiniMax Open Platform](https://platform.minimax.io) to register and obtain an API key.

---

## Option 3: Other Proxy Tools

The community has built several proxy tools specifically for Claude Code:

| Tool | Description | Link |
|------|-------------|------|
| **a2o** | Anthropic → OpenAI single binary, zero dependencies | [Twitter](https://x.com/mantou543/status/2018846154855940200) |
| **Empero Proxy** | Full Anthropic Messages API to OpenAI translation | [Twitter](https://x.com/EmperoAI/status/2036840854065762551) |
| **Alma** | Client with built-in OpenAI → Anthropic proxy | [Twitter](https://x.com/yetone/status/2003508782127833332) |
| **Chutes** | Docker container supporting 60+ open-source models | [Twitter](https://x.com/chutes_ai/status/2027039742915662232) |

---

## Known Limitations

### 1. `drop_params: true` Is Essential

This project sends Anthropic-specific parameters (e.g., `thinking`, `cache_control`) that don't exist in the OpenAI API. You must set `drop_params: true` in the LiteLLM config, otherwise requests will fail.

### 2. Extended Thinking Unavailable

Anthropic's Extended Thinking is a proprietary feature not supported by other models. It is automatically disabled when using third-party models.

### 3. Prompt Caching Unavailable

`cache_control` is an Anthropic-specific feature. Prompt caching won't work with third-party models (but won't cause errors — it's silently ignored by `drop_params`).

### 4. Tool Calling Compatibility

This project heavily uses tool calling (tool_use). LiteLLM automatically translates Anthropic's tool_use format to OpenAI's function_calling format. This works in most cases, but some complex tool calls may have compatibility issues. If you encounter problems, try using a more capable model (e.g., GPT-4o).

### 5. Telemetry and Non-Essential Requests

Configure these environment variables to avoid unnecessary network requests:
```
DISABLE_TELEMETRY=1
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

---

## FAQ

### Q: LiteLLM proxy returns `/v1/responses` not found?

Some OpenAI-compatible services only support `/v1/chat/completions`. Add this to your LiteLLM config:

```yaml
litellm_settings:
  use_chat_completions_url_for_anthropic_messages: true
```

### Q: What's the difference between `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`?

- `ANTHROPIC_API_KEY` → Sent via `x-api-key` header
- `ANTHROPIC_AUTH_TOKEN` → Sent via `Authorization: Bearer` header

LiteLLM proxy accepts Bearer Token format by default, so `ANTHROPIC_AUTH_TOKEN` is recommended.

### Q: Can I configure multiple models?

Yes. Define multiple `model_name` entries in `litellm_config.yaml`, then switch by changing the `ANTHROPIC_MODEL` value.

### Q: Local Ollama models don't work well?

This project's system prompts and tool calls require strong model capabilities. Use larger models (e.g., Llama 3 70B+, Qwen 72B+). Smaller models may fail to handle tool calling correctly.

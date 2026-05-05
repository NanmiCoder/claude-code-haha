# IM Gateway 方案设计 `[历史设计稿]`

> 像 OpenClaw 一样，让 Claude Code 快速接入任意 IM 平台
>
> 状态更新：当前实际可用的接入方式请看 [`docs/im/`](../im/)。
> 本文保留为方案演进记录，不再作为接入说明。

<p align="center">
<a href="#一背景与动机">背景</a> ·
<a href="#二openclaw-参考分析">OpenClaw</a> ·
<a href="#三方案设计">方案</a> ·
<a href="#四消息协议">协议</a> ·
<a href="#五消息流详解">消息流</a> ·
<a href="#六adapter-实现">Adapter</a> ·
<a href="#七文件清单">文件清单</a> ·
<a href="#八验证方案">验证</a> ·
<a href="#九与-openclaw-对比">对比</a> ·
<a href="#十开放问题">开放问题</a>
</p>

---

## 一、背景与动机

### 现状

Claude Code 源码中已有完整的 **Channel 系统**（详见 [01-channel-system.md](./01-channel-system.md)），支持通过 MCP 协议接入 IM 平台。但该系统被六层访问控制锁死：

1. **编译时门控** — `feature('KAIROS')` / `feature('KAIROS_CHANNELS')` 编译标志
2. **运行时门控** — GrowthBook `tengu_harbor`（默认 false）
3. **OAuth 门控** — 需要 claude.ai OAuth 登录
4. **组织策略门控** — Team/Enterprise 必须显式启用 `channelsEnabled: true`
5. **会话白名单** — 需要 `--channels` CLI 参数指定
6. **插件市场审批** — 插件必须通过 Anthropic 市场审批

这些限制使得在我们自托管的本地运行时中无法直接使用 Channel 功能。

### 目标

参考 [OpenClaw](https://github.com/openclaw/openclaw) 的 IM Gateway 架构，在现有本地服务器基础上，以**最小改动量**实现 IM 平台接入，让用户可以从 Telegram、飞书、Slack、Discord 等 IM 直接与 Claude 对话并审批权限请求。

### 核心策略

**不拆解 MCP Channel 的门控**，而是在服务端新增 `/im/` WebSocket 入口，直接复用 `conversationService`（CLI 子进程管理），绕过整个 MCP 层。

---

## 二、OpenClaw 参考分析

[OpenClaw](https://github.com/openclaw/openclaw) 是 GitHub 上 351k+ star 的开源 AI 助手项目，其最大特色是 IM 集成。

### 支持的 IM 平台（23+）

WhatsApp、Telegram、Slack、Discord、Google Chat、Signal、iMessage、IRC、Microsoft Teams、Matrix、飞书（Feishu）、LINE、Mattermost、Nextcloud Talk、Nostr、Synology Chat、Tlon、Twitch、Zalo、微信（WeChat）、WebChat 等。

### 架构模式

```
IM 平台 (Telegram / WeChat / Slack / ...)
               |
               v
     ┌─────────────────────┐
     │       Gateway        │
     │   (WebSocket 控制面)  │
     │  ws://127.0.0.1:18789│
     └──────────┬──────────┘
               |
               ├── AI Agent (RPC) — 模型调用
               ├── CLI
               ├── WebChat UI
               └── 移动端 App
```

### 关键设计

- **Gateway 是控制面**：所有 IM 消息通过 Gateway 路由到 AI Agent
- **Adapter 模式**：每个 IM 平台一个独立 Adapter，连接到 Gateway
- **多用户隔离**：不同用户/聊天对应不同 Agent 会话
- **安全机制**：DM 配对码验证未知发送者

### 中国 IM 生态

社区插件仓库 `openclaw-china` 额外支持：飞书、钉钉、QQ、企业微信。

---

## 三、方案设计

### 架构总览

```
Telegram / 飞书 / Slack / Discord / 微信 ...
         |
         | (各平台 SDK)
         v
  IM Adapter（独立进程）  ← 每个平台一个
         |
         | ws://localhost:3456/im/<adapterId>
         v
  ┌──────────────────────┐
  │     IM Gateway       │  ← 新增模块 src/server/im/
  │  (WebSocket handler) │
  └──────────┬───────────┘
             |
             | 复用 conversationService
             v
  ┌──────────────────────┐
  │   CLI 子进程 (Claude) │  ← 已有基础设施，零改动
  └──────────────────────┘
```

### 设计决策

#### 为什么不直接解锁 MCP Channel 门控？

MCP Channel 系统设计用于 CLI 交互模式（React/Ink 渲染），需要修改编译标志、GrowthBook 配置、OAuth 逻辑等 6 层代码。而本地服务器有独立的架构（REST + WS + CLI 子进程），直接在服务端接入更简洁。

#### 为什么 Adapter 独立进程？

- IM SDK 很重（telegraf ~50 deps，wechaty 更多），不应污染服务端
- 可以独立重启/更新，不影响服务器
- 自然隔离，一个 Adapter 崩溃不影响其他
- 与 OpenClaw 架构模式一致

#### 为什么用 WebSocket？

双向实时通信是核心需求（流式回复、权限请求/回复），服务器已有 WebSocket 基础设施，HTTP 轮询会增加延迟和复杂度。

### 复用清单

以下已有代码可直接复用，**无需修改**：

| 函数 / 模块 | 文件位置 | 用途 |
|-------------|---------|------|
| `conversationService.*` | `src/server/services/conversationService.ts` | CLI 子进程管理全套 API |
| `shortRequestId()` | `src/services/mcp/channelPermissions.ts:140` | 生成 IM 友好的 5 字母权限 ID |
| `truncateForPreview()` | `src/services/mcp/channelPermissions.ts:160` | 工具输入截断为手机预览大小 |
| `PERMISSION_REPLY_RE` | `src/services/mcp/channelPermissions.ts:75` | 权限回复格式正则匹配 |
| `translateCliMessage()` | `src/server/ws/handler.ts:277` | CLI 消息翻译逻辑（作为参考） |
| `sessionService` | `src/server/services/sessionService.ts` | 会话文件管理 |

---

## 四、消息协议

### Adapter -> Gateway

```typescript
// 注册
{ type: 'register'; platform: string; adapterId: string; secret?: string }

// IM 消息
{ type: 'im_message'; chatId: string; userId: string; userName?: string; content: string; meta?: Record<string, string> }

// 权限回复
{ type: 'permission_reply'; sessionId: string; requestId: string; allowed: boolean }

// 停止生成
{ type: 'stop'; chatId: string }

// 新建会话（用户 /new 命令）
{ type: 'new_session'; chatId: string }
```

### Gateway -> Adapter

```typescript
// 注册确认
{ type: 'registered'; adapterId: string }

// 文本回复（流式）
{ type: 'text'; chatId: string; content: string; isComplete: boolean }

// 思考过程
{ type: 'thinking'; chatId: string; content: string }

// 工具调用
{ type: 'tool_use'; chatId: string; toolName: string; toolUseId: string; input: any }

// 工具结果
{ type: 'tool_result'; chatId: string; toolUseId: string; content: any; isError: boolean }

// 权限请求
{
  type: 'permission_request';
  chatId: string;
  sessionId: string;
  requestId: string;
  shortId: string;        // 5 字母 ID，如 "tbxkq"
  toolName: string;
  description?: string;
  inputPreview: string;   // 截断后的工具输入
}

// 状态变更
{ type: 'status'; chatId: string; state: 'thinking' | 'streaming' | 'tool_executing' | 'idle' }

// 错误
{ type: 'error'; chatId: string; message: string; code?: string }

// 完成
{ type: 'complete'; chatId: string; usage: { input_tokens: number; output_tokens: number } }
```

---

## 五、消息流详解

### 正常对话流

```
用户在 Telegram 发送 "检查 main.ts 有没有 bug"
  → Telegram Bot 收到消息
  → Adapter 通过 WebSocket 发送:
    { type: "im_message", chatId: "12345", userId: "alice", content: "检查 main.ts" }
  → Gateway 收到
  → 查找 chatId->sessionId 映射（不存在则创建新 session）
  → conversationService.startSession(sessionId, workDir, sdkUrl)
  → conversationService.sendMessage(sessionId, content)
  → CLI 子进程启动，调用 Claude API
  → CLI 输出 stream_event
  → conversationService.onOutput() 回调触发
  → Gateway 翻译为 GatewayMessage
  → WebSocket 发送: { type: "text", chatId: "12345", content: "让我看看...", isComplete: false }
  → Adapter 调用 ctx.reply("让我看看...")
  → 用户在 Telegram 看到回复
```

### 权限审批流

```
CLI 发送 control_request:
  { subtype: "can_use_tool", tool_name: "Bash", input: { command: "npm test" } }
  → Gateway 收到
  → 生成 shortId = shortRequestId(toolUseId) → "tbxkq"
  → WebSocket 发送:
    { type: "permission_request", chatId: "12345", shortId: "tbxkq",
      toolName: "Bash", inputPreview: '{"command":"npm test"}' }
  → Adapter 在 Telegram 发送:
    "需要权限确认
     工具: Bash
     内容: npm test
     [允许] [拒绝]"
  → 用户点击 [允许]
  → Adapter 发送: { type: "permission_reply", requestId: "tbxkq", allowed: true }
  → Gateway 调用 conversationService.respondToPermission(sessionId, requestId, true)
  → CLI 继续执行
```

---

## 六、Adapter 实现

### 目录结构

```
adapters/
  telegram/
    index.ts        — Telegram Bot Adapter（基于 telegraf）
    package.json    — 依赖声明
  feishu/
    index.ts        — 飞书 Adapter（基于 @larksuiteoapi/node-sdk）
    package.json
  slack/
    index.ts        — Slack Adapter（基于 Bolt）
    package.json
  discord/
    index.ts        — Discord Adapter（基于 discord.js）
    package.json
  wechat/
    index.ts        — 微信 Adapter（基于 wechaty）
    package.json
```

### Telegram Adapter 示例

```typescript
// 伪代码 — 核心逻辑
import { Telegraf } from 'telegraf'
import WebSocket from 'ws'

const bot = new Telegraf(process.env.BOT_TOKEN)
const ws = new WebSocket('ws://localhost:3456/im/telegram-001')

// IM -> Gateway
bot.on('text', (ctx) => {
  ws.send(JSON.stringify({
    type: 'im_message',
    chatId: String(ctx.chat.id),
    userId: String(ctx.from.id),
    userName: ctx.from.first_name,
    content: ctx.message.text,
  }))
})

// Gateway -> IM
ws.on('message', (data) => {
  const msg = JSON.parse(data)
  switch (msg.type) {
    case 'text':
      bot.telegram.sendMessage(msg.chatId, msg.content, { parse_mode: 'Markdown' })
      break
    case 'permission_request':
      bot.telegram.sendMessage(msg.chatId,
        `需要权限: ${msg.toolName}\n${msg.inputPreview}`,
        { reply_markup: {
          inline_keyboard: [[
            { text: '允许', callback_data: `permit:${msg.requestId}:yes` },
            { text: '拒绝', callback_data: `permit:${msg.requestId}:no` },
          ]]
        }}
      )
      break
  }
})

// 处理按钮回调
bot.on('callback_query', (ctx) => {
  const [, requestId, decision] = ctx.callbackQuery.data.split(':')
  ws.send(JSON.stringify({
    type: 'permission_reply',
    requestId,
    allowed: decision === 'yes',
  }))
})
```

### 飞书 Adapter 要点

- 使用飞书事件订阅（HTTP 回调模式）接收消息
- 权限请求使用**交互式卡片**（Message Card），按钮体验更好
- 支持富文本回复

### 各平台消息限制

| 平台 | 消息长度限制 | 处理方式 |
|------|------------|---------|
| Telegram | 4096 字符 | 自动分段发送 |
| 飞书 | 无硬限制（建议 < 30KB） | 长消息可折叠 |
| Slack | 40000 字符 | 分 Block 发送 |
| Discord | 2000 字符 | 分段 + Embed |
| 微信 | 2048 字符 | 分段发送 |

---

## 七、文件清单

### 需要修改的现有文件（约 35 行改动）

| 文件 | 改动量 | 内容 |
|------|--------|------|
| `src/server/index.ts` | ~20 行 | 新增 `/im/` WebSocket 升级路径 |
| `src/server/ws/handler.ts` | ~15 行 | WebSocketData 类型扩展为 `'client' \| 'sdk' \| 'im'`，open/message/close 中委托 IM 消息给 gateway |

### 需要新建的文件

| 文件 | 说明 |
|------|------|
| `src/server/im/types.ts` | IM 消息协议类型定义 |
| `src/server/im/gateway.ts` | Gateway 核心 — Adapter 连接管理、chatId->session 路由、消息翻译 |
| `src/server/im/sessionMap.ts` | chatId-sessionId 映射管理、可选持久化 |
| `src/server/im/config.ts` | `~/.claude/im-gateway.json` 配置读取 |
| `adapters/telegram/index.ts` | Telegram Bot Adapter |
| `adapters/telegram/package.json` | 依赖 telegraf + ws |
| `adapters/feishu/index.ts` | 飞书 Adapter |
| `adapters/feishu/package.json` | 依赖 @larksuiteoapi/node-sdk + ws |

### 配置文件

`~/.claude/im-gateway.json`：

```json
{
  "enabled": true,
  "defaultWorkDir": "/path/to/default/project",
  "defaultPermissionMode": "default",
  "adapters": {
    "telegram": {
      "secret": "optional-shared-secret",
      "allowedUsers": ["123456789"],
      "workDir": "/path/to/project"
    },
    "feishu": {
      "secret": "optional-shared-secret",
      "allowedUsers": ["ou_xxx"],
      "workDir": "/path/to/another/project"
    }
  }
}
```

---

## 八、验证方案

### 1. WebSocket 连通性测试

```bash
# 启动服务器
bun run server

# 用 wscat 模拟 Adapter
wscat -c ws://localhost:3456/im/test-adapter
> {"type":"register","platform":"test","adapterId":"test-001"}
# 期望收到: {"type":"registered","adapterId":"test-001"}

> {"type":"im_message","chatId":"chat-1","userId":"user-1","content":"hello"}
# 期望收到: 一系列 text/thinking/status/complete 消息
```

### 2. Telegram 端到端测试

1. 创建 Telegram Bot（@BotFather）
2. 配置 Bot Token 到 Adapter
3. 启动服务器 + Telegram Adapter
4. 在 Telegram 发送 "hello"
5. 验证收到 Claude 回复
6. 发送 "读取 package.json" 触发工具调用
7. 验证权限请求按钮出现
8. 点击允许，验证工具执行和结果返回

### 3. 多会话隔离测试

- 从不同 Telegram 聊天发消息，验证会话独立
- 发送 `/new` 命令，验证新会话创建
- 验证旧会话不受影响

### 4. 异常场景测试

- Adapter 断开重连，验证会话恢复
- CLI 进程崩溃，验证错误消息发送到 IM
- 权限请求超时，验证优雅处理

---

## 九、与 OpenClaw 对比

| 特性 | OpenClaw | 我们的方案 |
|------|----------|-----------|
| 架构 | Gateway + Agent (RPC) | Gateway + CLI 子进程 (SDK WS) |
| IM 平台 | 23+ 内置 | Adapter 模式，按需添加 |
| 权限审批 | 无（直接执行） | 5 字母 ID 审批（复用已有系统） |
| 多用户 | 全局单 Agent | 每 chatId 独立 session |
| AI 模型 | OpenAI / Claude / Gemini 等 | Claude（通过现有 API key） |
| 工具能力 | 浏览器控制、语音等 | 完整 Claude Code 工具集（文件读写、终端、搜索等） |
| 部署方式 | 单体 + 插件 | 服务端 + 独立 Adapter 进程 |
| 改动量 | 全新项目 | 现有服务端 ~35 行改动 + 3 个新模块 |

### 我们的优势

- **Claude Code 原生工具链**：Adapter 连接的不是普通聊天机器人，而是完整的 Claude Code Agent，具备文件读写、代码搜索、Git 操作、终端执行等全部能力
- **权限安全**：内置权限审批机制，从 IM 端可以审批敏感操作
- **改动量极小**：核心只改 2 个文件 ~35 行，新增 3 个模块

### OpenClaw 的优势

- **IM 平台覆盖**：23+ 平台开箱即用
- **社区生态**：5400+ 社区 Skills
- **语音交互**：支持语音唤醒和对话
- **多模型**：支持 OpenAI、Gemini 等多种模型

---

## 十、开放问题

> 以下问题在实现前需要进一步思考和决策。

### 10.1 安全性

- Adapter 连接到 Gateway 时是否需要认证？（shared secret / API key）
- 如何防止未授权的 IM 用户与 Claude 对话？（allowedUsers 白名单是否足够？）
- 是否需要 IP 白名单或 Tailscale 等网络层隔离？

### 10.2 多用户 / 多项目

- 一个 IM 用户是否能切换不同项目目录？（如 `/project /path/to/repo`）
- 是否支持多个用户同时使用同一个 Bot？
- 会话上限和资源管理（同时运行多少个 CLI 子进程？）

### 10.3 消息体验

- 长回复如何处理？逐段发送 vs 等待完成后发送？
- 用户快速连发多条消息，是否需要聚合？
- 代码块在 IM 中的渲染质量（Telegram Markdown vs 飞书富文本 vs 微信纯文本）

### 10.4 运维

- Adapter 进程管理（systemd / pm2 / Docker？）
- 日志和监控
- 服务器重启后 session 恢复

### 10.5 功能边界

- 是否支持文件/图片上传？（用户在 IM 中发送截图给 Claude）
- 是否支持 Claude 返回的图片/文件？（如截图、生成的文件）
- 是否支持 slash commands（`/help`、`/status`、`/new`）？

---

## 参考资料

- [OpenClaw GitHub](https://github.com/openclaw/openclaw) — 351k star 开源 AI 助手
- [OpenClaw China](https://github.com/BytePioneer-AI/openclaw-china) — 中国 IM 社区插件
- [Channel 系统架构解析](./01-channel-system.md) — 源码 Channel 系统文档
- [Telegraf](https://github.com/telegraf/telegraf) — Telegram Bot Framework
- [@larksuiteoapi/node-sdk](https://github.com/larksuite/oapi-sdk-nodejs) — 飞书 SDK

# Telegram 接入

> Telegram Adapter 的接入教程。找 BotFather 拿 Token，写入本地配置后配对即可。

## 适用场景

Telegram 方案适合个人私聊远程使用。当前实现只处理 `private chat`，不处理群聊。

实现入口：`adapters/telegram/index.ts`

## 1. 创建 Telegram 机器人

在 Telegram 里搜索官方账号 **@BotFather**：

![搜索 BotFather](../images/im/telegram/01-search-botfather.png)

给它发送 `/newbot`：

![发送 /newbot](../images/im/telegram/02-newbot-command.png)

按提示走完三步：

- **取一个机器人名称**，例如 `ClaudeCodeHaha机器人`
- **取一个机器人用户名**，要求全英文字母，且必须以 `_bot` 结尾，例如 `jiang_cc_hah_bot`
- 创建成功后，复制 BotFather 返回的 **Bot Token**

![复制 Bot Token](../images/im/telegram/03-bot-token.png)

## 2. 写入本地配置

### 2.1 填写 Bot Token

编辑 `~/.claude/adapters.json`，把上一步的 Bot Token 填进去：

![填写 Bot Token](../images/im/telegram/04-fill-bot-token.png)

### 2.2 生成配对码

生成 6 位配对码并写入 `pairing.code / expiresAt / createdAt`：

![生成配对码](../images/im/telegram/05-generate-pairing-code.png)

## 3. 机器人配对

随便给刚才创建的机器人发送一条消息，按提示输入配对码。看到下面的配对成功提示，就可以从手机 Telegram 远程驱动 Claude Code Haha 了：

![配对成功](../images/im/telegram/06-pair-success.png)

## 支持的命令

- `/start` — 显示帮助和可用命令
- `/projects` — 切换项目，重新显示最近项目列表
- `/status` — 查看当前会话的项目、模型、运行状态和任务摘要
- `/clear` — 清空当前会话上下文，保留项目绑定
- `/new` — 清空当前 chat 绑定的 session，并重新选择项目
- `/help` — 显示当前可用命令
- `/stop` — 向当前 session 发送 `stop_generation`

## 权限审批

当 Claude 请求敏感权限时，Telegram adapter 会发带按钮的消息：

- `✅ 允许`
- `❌ 拒绝`

点击后 adapter 会把结果通过 `permission_response` 回传给本地 server。

## 返回消息的表现

Telegram 侧有一层流式缓冲：

- thinking 时先发占位消息
- text delta 逐步累积
- 完成时按 4000 字分片发送

对应公共模块：

- `adapters/common/message-buffer.ts`
- `adapters/common/format.ts`
- `adapters/common/ws-bridge.ts`

## 启动 adapter

当前需要手动启动 adapter：

```bash
cd adapters
bun install
bun run telegram
```

## 环境变量覆盖（可选）

```bash
export TELEGRAM_BOT_TOKEN="123456:ABC-DEF..."
export ADAPTER_SERVER_URL="ws://127.0.0.1:3456"
```

## 常见问题

### bot 启动时报缺少 token

说明 `TELEGRAM_BOT_TOKEN` 和 `~/.claude/adapters.json` 里的 `telegram.botToken` 都没有生效。

### 配置好了但 bot 不工作

确认已经在 `adapters/` 目录运行 `bun run telegram`。

### 发消息提示未授权

- 是否已经在 `~/.claude/adapters.json` 写入配对码
- 配对码是否在 60 分钟有效期内
- 是否把码发到了正确的 bot 私聊
- 连续输错会有速率限制，等几分钟再试

### 每次重启后会话丢失

检查 `~/.claude/adapter-sessions.json` 是否能正常写入，以及本地 server 的 session 是否仍存在。

## 源码入口

- `adapters/telegram/index.ts`
- `adapters/common/pairing.ts`
- `adapters/common/session-store.ts`
- `adapters/common/ws-bridge.ts`
- `adapters/common/http-client.ts`

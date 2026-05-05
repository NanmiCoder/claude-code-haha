# IM 接入

> 当前可用的 IM 接入方案总览。  
> 如果你只是想把 Telegram 或飞书接进来，从这篇开始。

## 当前方案是什么

当前仓库里的 IM 接入，已经不是早期文档里设想的 “IM Gateway / MCP Channel 插件” 主路径。

现在真实在跑的是一条更轻的链路：

```mermaid
flowchart TD
    A["编辑 ~/.claude/adapters.json"] --> E["平台配置"]

    E --> F["Telegram / 飞书 Adapter 进程"]
    F --> G["加载平台配置"]
    F --> H["校验配对与授权"]
    F --> I["读取 / 写入会话映射"]
    I --> J["~/.claude/adapter-sessions.json"]

    F --> K{"当前 chatId<br/>是否已有 session?"}
    K -->|有历史映射| L["复用已有 sessionId"]
    K -->|无历史映射| M{"是否配置<br/>defaultProjectDir?"}
    M -->|是| N["POST /api/sessions<br/>创建新 session"]
    M -->|否| O["GET /api/sessions/recent-projects<br/>让用户选择项目"]
    O --> P["用户回复编号"]
    P --> N

    N --> Q["获得 sessionId"]
    L --> R["连接 /ws/:sessionId"]
    Q --> R

    R --> S["adapters/common/ws-bridge.ts"]
    S --> T["本地 Server"]
    T --> U["Claude Code session / CLI 子进程"]

    U --> V["流式消息 / 权限请求 / 状态事件"]
    V --> S
    S --> F
    F --> W["Telegram / 飞书用户"]
```

可以把这条链路理解成四层：

- 配置层：手动编辑 `~/.claude/adapters.json`，填写平台凭据、默认项目和配对码
- 存储层：配置和会话映射保存在本机 `~/.claude/`
- 适配层：Telegram / 飞书 adapter 进程负责接 IM 平台、做授权检查、恢复或创建会话
- 会话层：adapter 通过 HTTP 创建 session，再通过 WebSocket 把 IM 消息桥接到 Claude Code 会话

## 用户怎么用

### 1. 写入本地配置

创建或更新 `~/.claude/adapters.json`，填写：

- `serverUrl`
- `defaultProjectDir`
- Telegram 或飞书各自的凭据
- 可选 `allowedUsers`

### 2. 生成配对码

在配置文件里写入一次性配对码：

- 生成 6 位码并写入 `pairing.code / expiresAt / createdAt`
- 码有效期 60 分钟
- 配对成功后立即失效

配对码是平台无关的，同一个码可以在 Telegram 或飞书私聊里使用一次。

### 3. 启动对应 Adapter 进程

当前需要手动启动 bot 进程：

```bash
cd adapters
bun install
bun run telegram
# 或
bun run feishu
```

### 4. 在 IM 里私聊 Bot

- 未配对用户：先把配对码发给 bot
- 已配对用户：直接发送自然语言消息
- 没有默认项目时：bot 会先让你从最近项目里选一个
- 后续消息会复用同一个 Claude session

## 配置和状态分别存哪

### `~/.claude/adapters.json`

保存平台配置和授权状态，包括：

- `serverUrl`
- `defaultProjectDir`
- `pairing`
- `telegram`
- `feishu`

其中：

- 敏感字段会在 API 返回时被脱敏
- 配对码也会被 `/api/adapters` 返回值掩码为 `******`

### `~/.claude/adapter-sessions.json`

保存 IM chat 到 Claude session 的映射：

- `chatId`
- `sessionId`
- `workDir`
- `updatedAt`

这让 bot 重启后仍然能接回原来的会话。

## 当前安全模型

授权规则是：

- `allowedUsers` 和 `pairedUsers` 取并集
- 两者都为空时，默认拒绝访问
- 配对码为 6 位安全字符集
- 配对码一次性使用
- 同一用户 5 分钟内最多失败 5 次

这和旧 README 里“`allowedUsers` 为空就允许所有人”的说法已经不同，旧说法已过时。

## 会话行为

Adapter 不是直接把消息丢给一个全局 Claude 进程，而是：

1. 先用 `POST /api/sessions` 创建 session
2. 再用 `ws://.../ws/:sessionId` 建立桥接
3. 把 IM 消息转成：
   - `user_message`
   - `permission_response`
   - `stop_generation`
4. 把服务端流式消息再格式化回 IM

如果没有 `defaultProjectDir`，Adapter 会调用 `GET /api/sessions/recent-projects` 让用户先选项目。

## 平台差异

- Telegram：`grammy`，按钮审批，纯私聊模式
- 飞书：`@larksuiteoapi/node-sdk`，长连接事件订阅，交互卡片审批，当前只处理 `p2p`

分别看：

- [Telegram 接入](./telegram.md)
- [飞书接入](./feishu.md)

## 和 `docs/channel/` 的关系

`docs/channel/` 主要是 Claude Code 原生 Channel/MCP 体系的源码研究资料，不是这个仓库当前推荐的 IM 接入方式。

如果你是要“把 bot 真跑起来”，看本目录。  
如果你是要研究 Claude Code 原始 Channel 设计，再去看 `docs/channel/`。

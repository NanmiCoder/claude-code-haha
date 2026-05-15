# Remote Control Bridge 设计说明

## 1. 这一层解决什么问题

bridge 子系统解决的是：

“如何把本地 Claude Code 会话或本地机器暴露给远端客户端，同时仍然保持本地执行、权限控制、消息同步和会话恢复能力。”

它支撑的典型场景包括：

- 在 claude.ai 或移动端继续本地会话
- 独立运行 `claude remote-control` 作为远程承载端
- 远端发起权限请求，再由本地执行器真正落地

## 2. 先分清两条轴

理解 bridge 的第一步，是不要把不同维度混在一起。

### 2.1 调度层维度

| 方案 | 核心文件 | 特点 |
| --- | --- | --- |
| env-based bridge | [src/bridge/replBridge.ts](../src/bridge/replBridge.ts) | 有 Environments API，注册环境、poll work、ack、heartbeat |
| env-less bridge | [src/bridge/remoteBridgeCore.ts](../src/bridge/remoteBridgeCore.ts) | 直接走 code session + `/bridge`，不再经过环境分发层 |

### 2.2 传输层维度

| 方案 | 核心文件 | 特点 |
| --- | --- | --- |
| v1 transport | `HybridTransport` 适配于 [src/bridge/replBridgeTransport.ts](../src/bridge/replBridgeTransport.ts) | WebSocket 读 + Session-Ingress 写 |
| v2 transport | `SSETransport + CCRClient` 适配于 [src/bridge/replBridgeTransport.ts](../src/bridge/replBridgeTransport.ts) | SSE 读 + CCR v2 `/worker/*` 写 |

一个很重要的结论是：

`v2 transport` 不等于 `env-less bridge`。

它们是两个不同维度。

## 3. bridge 的两种使用方式

### 3.1 独立远控模式

用户运行 `claude remote-control` 时，入口直接走 [src/bridge/bridgeMain.ts](../src/bridge/bridgeMain.ts)。

这个模式更像一台“远程工作承载机”：

- 可以注册环境
- 接受远端下发 session work
- 在本地 spawn Claude 子进程执行
- 支持 single-session / same-dir / worktree 等模式

### 3.2 REPL 内桥接模式

用户在已有会话里启用 `/remote-control` 时，会通过 [src/bridge/initReplBridge.ts](../src/bridge/initReplBridge.ts) 建立桥接。

这个模式的特点是：

- 当前本地 REPL 仍然存在
- bridge 只是附加一层远程同步与控制
- 本地消息会被同步到远端
- 远端消息/控制请求会回流到本地

## 4. 核心数据结构

bridge 子系统最重要的类型定义在 [src/bridge/types.ts](../src/bridge/types.ts)。

### 4.1 BridgeConfig

描述一个 bridge 实例的运行上下文，例如：

- 目录
- 机器名
- 分支
- git remote
- spawn mode
- 最大 session 数
- API base URL
- session ingress URL

### 4.2 WorkSecret

`poll work` 返回的 secret 解码后会得到 `WorkSecret`，其中包含：

- `session_ingress_token`
- `api_base_url`
- auth/source 信息
- 可选的 mcp 配置或环境变量
- 是否使用 code sessions

这相当于服务端下发给本地执行器的一份“工作凭证包”。

### 4.3 BridgeApiClient

[src/bridge/bridgeApi.ts](../src/bridge/bridgeApi.ts) 暴露了桥接所需的 HTTP API，包括：

- 注册环境
- poll work
- acknowledge work
- stop work
- deregister environment
- reconnect session
- heartbeat work
- 发送权限响应事件

## 5. env-based bridge 的主流程

### 5.1 初始化阶段

在 [src/bridge/replBridge.ts](../src/bridge/replBridge.ts) 中，env-based REPL bridge 的典型流程是：

1. 构造 `BridgeConfig`
2. 调用 `registerBridgeEnvironment`
3. 创建或恢复 session
4. 写入 bridge pointer
5. 启动 poll loop 等待 work

### 5.2 work 到来后发生什么

poll 到 work 之后，大致会发生：

1. 解码 `WorkSecret`
2. `acknowledgeWork`
3. 用 secret 中的 ingress token 建立 transport
4. 把本地消息 flush 到远端
5. 持续桥接双向消息

### 5.3 为什么需要 heartbeat

env-based path 有明确的 work lease 生命周期。如果本地桥接端不续约，服务端会认为 work 失效。

所以 `heartbeatWork` 的作用是：

- 延长当前 work lease
- 在 token 过期、环境失效时触发恢复逻辑

## 6. env-less bridge 的主流程

[src/bridge/remoteBridgeCore.ts](../src/bridge/remoteBridgeCore.ts) 描述的是另一条路径：

1. `POST /v1/code/sessions`
2. `POST /v1/code/sessions/{id}/bridge`
3. 获取 worker JWT 与 worker epoch
4. 建立 v2 transport
5. 通过 token refresh / transport rebuild 保持会话存活

这条路径不再有“环境注册、poll work、ack work”这层分发语义，更直接。

## 7. bridgeMain 的职责

[src/bridge/bridgeMain.ts](../src/bridge/bridgeMain.ts) 是独立远控模式的总编排器。

它负责：

- 参数解析
- 会话恢复与 pointer 处理
- spawn mode 选择
- trust 与登录校验
- 创建 API client / logger / session spawner
- 启动 `runBridgeLoop()`

### 7.1 runBridgeLoop 做什么

`runBridgeLoop()` 管理的是独立桥接服务器的一整条生命周期：

- active sessions 集合
- work -> session spawn
- session 心跳与 timeout watchdog
- worktree 清理
- token refresh
- backoff 与重连
- shutdown 时的 stop/archive/deregister

如果你想看“远控服务器是怎么调度多个 session 的”，就从这里开始。

## 8. transport 抽象为什么重要

[src/bridge/replBridgeTransport.ts](../src/bridge/replBridgeTransport.ts) 的意义在于：

- 上层逻辑不用关心底层究竟是 v1 还是 v2
- 可以统一 `write / writeBatch / connect / close / flush / reportState`
- 支持在 transport swap 时保留 sequence number

这让 bridge 核心可以更专注于“会话语义”，而不是散落一堆 if/else 处理不同 transport。

## 9. 双向消息与 control request

### 9.1 普通消息桥接

[src/bridge/bridgeMessaging.ts](../src/bridge/bridgeMessaging.ts) 负责：

- 解析 ingress message
- 过滤 echo 与重复消息
- 只转发需要同步的消息类型
- 提取可用作标题的用户消息文本

### 9.2 control request

bridge 不只是转发普通 user/assistant 消息。远端还会下发控制请求，例如：

- `initialize`
- `set_model`
- `set_permission_mode`
- `can_use_tool`

这些请求会通过 `control_request` / `control_response` 在远端与本地之间往返。

### 9.3 权限回调

[src/bridge/bridgePermissionCallbacks.ts](../src/bridge/bridgePermissionCallbacks.ts) 是 bridge 权限交互的重要适配层。

它让“远端用户批准/拒绝工具调用”能够回流到本地执行器，最终影响 `canUseTool` 的结果。

## 10. 标题、状态与可观测性

bridge 不是纯粹的 transport，还是一个“远程会话外观同步器”。

系统会同步和维护：

- session title
- connected/reconnecting/failed 状态
- session count / spawn mode
- 当前 activity
- debug log 路径

这部分由 [src/bridge/bridgeUI.ts](../src/bridge/bridgeUI.ts)、`BridgeLogger` 接口以及相关状态更新代码共同完成。

## 11. 重连与恢复

bridge 子系统在恢复方面投入很多，因为远控天然容易受到以下问题影响：

- 网络抖动
- JWT 过期
- SSE/WS 连接中断
- 环境失效或 session 过期
- 本地 CLI 异常退出

### 11.1 pointer 恢复

REPL bridge 和 standalone bridge 都会维护 pointer，供之后：

- `--continue`
- `--session-id`
- crash recovery

### 11.2 token refresh

桥接会主动调度 token refresh，而不只是等 401 发生后被动修复。

### 11.3 reconnect session

当 work 或 token 状态异常时，bridge 会尝试使用 `reconnectSession` 让服务端重新分发 work。

## 12. 安全模型

bridge 子系统的安全边界主要包括：

### 12.1 OAuth 与订阅校验

Remote Control 需要 claude.ai OAuth 身份以及相应 gate/policy 允许。

### 12.2 Trusted Device

[src/bridge/trustedDevice.ts](../src/bridge/trustedDevice.ts) 负责受信设备 token 读取和注册，服务于更高安全等级的会话。

### 12.3 ID 校验

[src/bridge/bridgeApi.ts](../src/bridge/bridgeApi.ts) 中会校验 `environmentId`、`workId`、`sessionId` 等服务端返回 ID 的格式，避免路径注入类问题。

### 12.4 workspace trust

独立 bridge 模式不会弹出完整 TUI trust dialog，因此会显式检查当前目录是否已经被信任。

## 13. 读 bridge 代码时的最佳顺序

推荐顺序如下：

1. [src/bridge/types.ts](../src/bridge/types.ts)
2. [src/bridge/initReplBridge.ts](../src/bridge/initReplBridge.ts)
3. [src/bridge/replBridge.ts](../src/bridge/replBridge.ts)
4. [src/bridge/remoteBridgeCore.ts](../src/bridge/remoteBridgeCore.ts)
5. [src/bridge/bridgeApi.ts](../src/bridge/bridgeApi.ts)
6. [src/bridge/replBridgeTransport.ts](../src/bridge/replBridgeTransport.ts)
7. [src/bridge/bridgeMessaging.ts](../src/bridge/bridgeMessaging.ts)
8. [src/bridge/bridgeMain.ts](../src/bridge/bridgeMain.ts)

## 14. 最容易误解的点

### 14.1 bridge 不是简单 websocket 同步

它同时处理：

- session 生命周期
- work lease
- transport 重建
- 权限交互
- 会话恢复

### 14.2 standalone bridge 与 REPL bridge 不是一回事

两者共享很多概念，但一个更像“远程会话宿主机”，另一个更像“当前本地会话的附加远程镜像与控制通道”。

### 14.3 env-less 不等于没有 bridge

它只是省掉了 Environments API 分发层，并不意味着没有 transport、没有 token refresh、没有远程控制协议。

## 15. 下一步建议

如果你已经理解 bridge，可以继续读 [state-and-data-flow.md](./state-and-data-flow.md)。理解 bridge 之后再看状态流，会更容易明白为什么系统需要这么多不同层级的状态与持久化结构。
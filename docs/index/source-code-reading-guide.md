# 源码阅读指南

## 1. 先说结论

这个仓库文件很多，但如果你的目标是“快速掌握系统”，不应该按目录顺序从头读。

最有效的方式是按问题来读：

- 它怎么启动？
- 一轮请求怎么执行？
- 工具/任务怎么扩展？
- 远控 bridge 怎么工作？

## 2. 15 分钟阅读路径

如果你只有 15 分钟，优先读这 6 个文件：

1. [src/entrypoints/cli.tsx](../src/entrypoints/cli.tsx)
2. [src/main.tsx](../src/main.tsx)
3. [src/screens/REPL.tsx](../src/screens/REPL.tsx)
4. [src/query.ts](../src/query.ts)
5. [src/tools.ts](../src/tools.ts)
6. [src/commands.ts](../src/commands.ts)

读完后你至少会知道：

- 入口在哪
- REPL 怎么接 query
- 工具和命令从哪里注册

## 3. 1 小时阅读路径

如果你有 1 小时，建议按下面顺序：

### 3.1 启动链路

1. [src/entrypoints/cli.tsx](../src/entrypoints/cli.tsx)
2. [src/main.tsx](../src/main.tsx)
3. [src/entrypoints/init.ts](../src/entrypoints/init.ts)
4. [src/setup.ts](../src/setup.ts)

要回答的问题：

- 什么时候走 fast path
- init 和 setup 的边界是什么
- 哪些模块是延迟加载的

### 3.2 请求链路

1. [src/screens/REPL.tsx](../src/screens/REPL.tsx)
2. [src/query.ts](../src/query.ts)
3. [src/services/api/claude.ts](../src/services/api/claude.ts)
4. [src/services/tools/toolExecution.ts](../src/services/tools/toolExecution.ts)

要回答的问题：

- 用户输入在哪里转成 query
- query loop 如何继续/结束
- tool_use 如何执行

### 3.3 扩展点

1. [src/commands.ts](../src/commands.ts)
2. [src/tools.ts](../src/tools.ts)
3. [src/Tool.ts](../src/Tool.ts)
4. [src/Task.ts](../src/Task.ts)

要回答的问题：

- 新命令加在哪里
- 新工具加在哪里
- 长耗时能力怎么变成任务

## 4. 按主题阅读的最佳路径

## 4.1 我想理解 TUI

优先看：

- [src/main.tsx](../src/main.tsx)
- [src/screens/REPL.tsx](../src/screens/REPL.tsx)
- [src/state/AppStateStore.ts](../src/state/AppStateStore.ts)
- [src/components](../src/components)

不要一开始就深挖所有 Ink 组件。先抓住 REPL 如何把 query 事件映射到 UI。

## 4.2 我想理解一次模型请求

优先看：

- [src/query.ts](../src/query.ts)
- [src/services/api/claude.ts](../src/services/api/claude.ts)
- [src/services/tools/toolExecution.ts](../src/services/tools/toolExecution.ts)
- [src/services/compact](../src/services/compact)

## 4.3 我想扩展能力

优先看：

- [src/commands.ts](../src/commands.ts)
- [src/tools.ts](../src/tools.ts)
- [src/tools/AgentTool/AgentTool.tsx](../src/tools/AgentTool/AgentTool.tsx)
- [src/tools/SkillTool/SkillTool.ts](../src/tools/SkillTool/SkillTool.ts)
- [src/services/mcp/client.ts](../src/services/mcp/client.ts)

## 4.4 我想理解后台任务

优先看：

- [src/Task.ts](../src/Task.ts)
- [src/tasks/types.ts](../src/tasks/types.ts)
- [src/tasks/LocalShellTask/LocalShellTask.tsx](../src/tasks/LocalShellTask/LocalShellTask.tsx)
- [src/tasks/LocalAgentTask/LocalAgentTask.tsx](../src/tasks/LocalAgentTask/LocalAgentTask.tsx)
- [src/tasks/RemoteAgentTask/RemoteAgentTask.tsx](../src/tasks/RemoteAgentTask/RemoteAgentTask.tsx)

## 4.5 我想理解 Remote Control

优先看：

- [src/bridge/initReplBridge.ts](../src/bridge/initReplBridge.ts)
- [src/bridge/replBridge.ts](../src/bridge/replBridge.ts)
- [src/bridge/remoteBridgeCore.ts](../src/bridge/remoteBridgeCore.ts)
- [src/bridge/bridgeApi.ts](../src/bridge/bridgeApi.ts)
- [src/bridge/bridgeMain.ts](../src/bridge/bridgeMain.ts)

## 5. 真正值得反复读的 12 个文件

| 文件 | 为什么值得反复读 |
| --- | --- |
| [src/main.tsx](../src/main.tsx) | 系统总入口与模式分发中心 |
| [src/entrypoints/init.ts](../src/entrypoints/init.ts) | 进程级初始化核心 |
| [src/setup.ts](../src/setup.ts) | 会话级初始化核心 |
| [src/screens/REPL.tsx](../src/screens/REPL.tsx) | UI 与 query 的连接点 |
| [src/query.ts](../src/query.ts) | 请求执行热路径 |
| [src/QueryEngine.ts](../src/QueryEngine.ts) | 无头会话控制器 |
| [src/Tool.ts](../src/Tool.ts) | 工具与执行上下文核心抽象 |
| [src/services/tools/toolExecution.ts](../src/services/tools/toolExecution.ts) | 单次工具执行全流程 |
| [src/tools.ts](../src/tools.ts) | 全局工具池入口 |
| [src/commands.ts](../src/commands.ts) | 全局命令池入口 |
| [src/Task.ts](../src/Task.ts) | 任务抽象入口 |
| [src/state/AppStateStore.ts](../src/state/AppStateStore.ts) | 会话状态总结构 |

## 6. 最有价值的搜索关键词

如果你要在全仓里搜，下面这些关键词命中率很高：

- `query(`
- `submitMessage`
- `runTools`
- `toolUseContext`
- `registerTask`
- `background`
- `initReplBridge`
- `reconnectSession`
- `MCP`
- `compact`

## 7. 调试时建议的断点模板

### 7.1 启动问题

- `cli.tsx` 的 `main()`
- `main.tsx` 的 `preAction`
- `setup.ts` 的 `setup()`

### 7.2 请求问题

- REPL 的提交点
- `query.ts` 进入循环处
- `services/api/claude.ts` 发请求前
- `services/tools/toolExecution.ts` 的 `tool.call()` 前后

### 7.3 任务问题

- `registerTask`
- `updateTaskState`
- 具体任务的 `kill/complete/fail` 路径

### 7.4 bridge 问题

- `initReplBridge`
- `registerBridgeEnvironment`
- poll loop
- `createV2ReplTransport`
- `handleIngressMessage`

## 8. 不建议的阅读方式

### 8.1 不要从 components 开始

UI 组件很多，但它们大多不是架构主线。

### 8.2 不要先啃完整个 REPL.tsx

这个文件很大，直接顺序读很容易被 UI 细节淹没。先定位它调用 `query()` 的位置，再倒着回看上下文更有效。

### 8.3 不要把 services 当成一个统一抽象层

services 目录是很多子系统的集合，不是一个单一模式的 service 层。

## 9. 如果你要做改动，该先读什么

| 改动类型 | 建议先读 |
| --- | --- |
| 增加新 slash 命令 | [src/commands.ts](../src/commands.ts) 与对应 `src/commands/*` |
| 增加新工具 | [src/Tool.ts](../src/Tool.ts), [src/tools.ts](../src/tools.ts), 某个已有工具实现 |
| 改权限逻辑 | `toolExecution.ts`、`toolHooks.ts`、`structuredIO.ts`、相关 permission utils |
| 改后台任务 | [src/Task.ts](../src/Task.ts), `src/tasks/*`, `utils/task/*` |
| 改 MCP 接入 | `services/mcp/*` |
| 改远控/bridge | `src/bridge/*` |
| 改启动性能或配置加载 | `cli.tsx`, `main.tsx`, `init.ts`, `setup.ts` |

## 10. 最后的建议

当你能把以下四条链在脑子里串起来时，基本就算掌握这个系统了：

1. bin -> cli.tsx -> main.tsx -> REPL/print/bridge
2. 输入 -> query -> API -> tool execution -> tool result -> 下一轮
3. Tool -> Task -> output file -> notification -> 主会话
4. Remote Control -> bridge -> transport -> permission/control response

如果你需要文字版总览，再回到 [README.md](./README.md)；如果你要真正开始改代码，从本指南列出的关键文件直接下手就够了。
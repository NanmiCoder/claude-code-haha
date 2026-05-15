# 状态与数据流

## 1. 这一章解决什么问题

这个项目最容易让人迷惑的点之一，是状态分散在多个地方：

- 有些在 bootstrap state
- 有些在 AppState
- 有些在 ToolUseContext
- 有些直接落到磁盘

如果不先建立状态分层模型，后面几乎所有 bug 都会看得很痛苦。

## 2. 四个主要状态面

| 状态面 | 主要位置 | 生命周期 | 典型内容 |
| --- | --- | --- | --- |
| 进程级运行时状态 | [src/bootstrap/state.ts](../src/bootstrap/state.ts) | 进程级 | cwd、sessionId、turn metrics、模型/模式开关、某些全局缓存引用 |
| 会话/UI 状态 | [src/state/AppStateStore.ts](../src/state/AppStateStore.ts) | 当前会话 | tasks、mcp、plugins、permission context、bridge UI 状态、notifications |
| 执行上下文 | [src/Tool.ts](../src/Tool.ts) 的 `ToolUseContext` | 一次 query / tool call | tools、commands、mcpClients、messages、AppState 读写接口、readFileState |
| 持久化状态 | `utils/sessionStorage*`、`utils/task/*`、bridge pointer 等 | 跨进程/跨恢复 | transcript、task output、remote task metadata、bridge pointer |

## 3. bootstrap state

### 3.1 它是什么

[src/bootstrap/state.ts](../src/bootstrap/state.ts) 更像“进程作用域的全局运行状态中心”，而不是 React store。

它通常保存：

- 会话标识与 cwd/projectRoot
- 当前模型、渠道、一些 feature latch
- turn 级统计数据
- schedule/cron 等会话态信息
- 一些需要跨模块共享但不适合放 UI store 的状态

### 3.2 它为什么存在

因为很多热路径不在 React 组件树里运行，例如：

- query loop
- task execution
- bridge
- headless 模式

这些逻辑如果都强行依赖 React store，会非常别扭。

## 4. AppState

### 4.1 它是什么

[src/state/AppStateStore.ts](../src/state/AppStateStore.ts) 描述的是当前会话的业务与 UI 状态。

它不是单纯“渲染状态”，很多业务信息也会放在这里，例如任务与 MCP 状态。

### 4.2 最重要的几个 slice

| slice | 作用 |
| --- | --- |
| `toolPermissionContext` | 当前会话的权限模式与 allow/deny/ask 规则 |
| `tasks` | 所有后台任务与长耗时执行状态 |
| `mcp` | MCP clients、tools、commands、resources |
| `plugins` | 插件启用状态、命令、错误 |
| `agentDefinitions` | 当前会话可用 agent 定义 |
| `fileHistory` | 文件历史与 rewind 相关状态 |
| `attribution` | commit attribution 等统计信息 |
| `notifications` / `elicitation` | UI 消息与交互请求队列 |
| `replBridge*` | bridge UI 与连接状态 |

### 4.3 AppState 不一定只服务 TUI

虽然 AppState 最常见于 REPL，但 headless/SDK 也会复用同样的数据结构来保存：

- tasks
- permission context
- mcp state
- agent state

所以它更准确的说法是“会话级业务状态”，而不是纯 UI 状态。

## 5. ToolUseContext

### 5.1 它是什么

[src/Tool.ts](../src/Tool.ts) 中的 `ToolUseContext` 是 query 和 tool execution 的临时执行上下文。

### 5.2 它和 AppState 的区别

AppState 解决“当前会话处于什么状态”，ToolUseContext 解决“当前这次工具执行有哪些依赖和能力”。

ToolUseContext 典型字段包括：

- `options.tools`
- `options.commands`
- `options.mcpClients`
- `getAppState` / `setAppState`
- `readFileState`
- `messages`
- `handleElicitation`
- `appendSystemMessage`
- `setToolJSX`

### 5.3 为什么不直接让工具去读全局单例

因为工具可能运行在：

- 主线程 REPL
- headless QueryEngine
- 子代理
- 背景 agent
- bridge / SDK 场景

显式上下文对象能避免工具层和全局单例绑死。

## 6. 消息数据流

### 6.1 消息并不只是一种类型

系统中常见的消息类型包括：

- user
- assistant
- system
- attachment
- progress
- tombstone
- compact boundary

这些消息并不都给用户直接看，有些是：

- 用于 query 内部控制
- 用于 transcript 恢复
- 用于 SDK 兼容
- 用于 compact / snip / hook 传递语义

### 6.2 一条消息通常会流经多个层次

以用户消息为例，可能经历：

1. 输入层接收
2. REPL/print 适配
3. query 归一化
4. transcript 记录
5. bridge 同步
6. title 提取 / analytics / compact 边界判断

所以“消息对象”本身就是多层共享的数据载体。

## 7. Task 数据流

### 7.1 Task 既在内存里，也在磁盘上

以本地 Bash 任务为例：

1. 工具创建 shell command
2. 注册到 `AppState.tasks`
3. 输出写入 task output 文件
4. TaskOutputTool 或 UI 可以读取输出文件
5. 完成后产生通知消息

这意味着 task 的完整状态并不只在 `AppState.tasks` 里，输出正文通常在磁盘上。

### 7.2 本地 agent task 多了一层 sidechain transcript

后台 agent 不只是“有个输出文件”，还可能维护单独 transcript，供：

- 任务输出查看
- resume / restore
- 后台消息继续注入

### 7.3 remote task 的数据源更不一样

remote task 的状态来自：

- 本地 `AppState.tasks`
- 轮询远端 session
- 远端 log 聚合
- 本地 task output 文件
- remote task metadata sidecar

所以 remote task 是“本地镜像态”，而不是本地真执行态。

## 8. 持久化模型

### 8.1 transcript

transcript 是会话恢复的核心数据源，主要由 `utils/sessionStorage` 一系负责。

它会记录：

- 关键消息
- compact 边界
- 某些工具/附件结果
- 任务关联数据

### 8.2 task output

任务输出文件的作用是：

- 把长输出从内存中剥离
- 支持后台查看
- 让大输出不会直接污染主消息流

### 8.3 sidecar / metadata

还有一些不适合塞进 transcript 本体的数据，会以 sidecar 形式存在，例如：

- remote agent metadata
- bridge pointer
- worktree state

## 9. Bridge 状态流

bridge 自己也有两层状态：

- bootstrap / pointer / token / transport 级状态
- AppState 里的 `replBridge*` UI 展示状态

这意味着桥接问题往往要同时看：

- 真正 transport 是否在线
- AppState 里的状态是否只是显示滞后

## 10. 一个典型的数据流案例：Bash 后台化

以 `BashTool` 执行长命令为例：

1. 模型调用 BashTool
2. BashTool 决定前台还是后台
3. 若后台，注册 `local_bash` task
4. shell 输出持续写入 task output 文件
5. `AppState.tasks` 维护运行状态与少量元信息
6. 完成时注入 task_notification
7. 主 query 下一轮看到通知并继续响应

这个案例很好地体现了系统的设计原则：

- 长正文放磁盘
- 控制状态放 AppState
- 模型看到的是消息与通知，而不是内部对象引用

## 11. 一个典型的数据流案例：子代理后台化

1. AgentTool 创建 `local_agent` task
2. task 写 sidechain transcript
3. agent 运行时不断更新 `AppState.tasks[taskId].progress`
4. 若 UI retain，则消息追加到内存 `messages`
5. 完成时生成任务通知与结果摘要

这套设计让子代理既能成为系统内部执行单元，也能成为用户可观察对象。

## 12. 调试状态问题时的建议顺序

### 12.1 先判断问题属于哪一层

| 问题类型 | 优先看哪里 |
| --- | --- |
| 当前 sessionId/cwd 不对 | bootstrap state |
| UI 没刷新 / 任务列表不对 | AppState |
| 工具执行读到错误上下文 | ToolUseContext |
| resume 后缺消息 / 输出丢失 | transcript / task output / sidecar |

### 12.2 最有价值的文件

- [src/bootstrap/state.ts](../src/bootstrap/state.ts)
- [src/state/AppStateStore.ts](../src/state/AppStateStore.ts)
- [src/Tool.ts](../src/Tool.ts)
- [src/utils/task/framework.ts](../src/utils/task/framework.ts)
- `utils/sessionStorage*`
- `utils/task/*`

## 13. 常见误区

### 13.1 误区：AppState 就是全部状态

不对。很多真正决定执行结果的状态根本不在 AppState 里。

### 13.2 误区：任务输出在 task 对象里

不对。task 对象大多只存元信息，详细输出通常写磁盘。

### 13.3 误区：ToolUseContext 是只读配置

不对。它在 query 过程中会被持续更新，例如消息列表、权限上下文、决策缓存等。

## 14. 下一步建议

状态层看完后，建议读 [services-layer.md](./services-layer.md)。那一章会从 services 目录出发，把 API、MCP、压缩、analytics、plugins 等能力模块的边界讲清楚。
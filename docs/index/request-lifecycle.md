# 请求生命周期

## 1. 为什么这一章最关键

理解这个仓库，最重要的不是先背目录，而是看清“一次请求从哪里进入、怎么构造上下文、何时调用模型、工具如何执行、任务如何创建、结果又怎么回流”。

这一章描述的，就是这个主链路。

## 2. 入口有三类，但内核尽量统一

一次请求可能从三类入口进入：

- REPL 输入框
- `--print` / SDK 流式输入
- bridge 远程注入的用户消息

虽然入口不同，但核心执行最终都会落到：

- [src/query.ts](../src/query.ts)，或
- [src/QueryEngine.ts](../src/QueryEngine.ts) 对 `query()` 的封装

## 3. 一次 turn 的主流程

可以把一次 turn 简化为下面 11 步：

1. 接收输入
2. 预处理用户输入与 slash 命令
3. 构造 system prompt / user context / system context
4. 构造可用工具池与权限上下文
5. 对历史消息做压缩/裁剪/折叠处理
6. 调用模型 API 并流式接收 assistant 输出
7. 收集 tool_use block
8. 执行工具、触发 hooks、做权限判断
9. 把 tool_result 与新消息回写进消息流
10. 若模型还需继续，则进入下一轮 query iteration
11. 最终把 transcript、任务状态、UI/SDK 输出收尾落盘

## 4. REPL 路径

在交互模式中，最关键的调用点位于 [src/screens/REPL.tsx](../src/screens/REPL.tsx)。

REPL 的职责主要是：

- 维护 UI 输入状态
- 展示消息、任务、提示、权限对话框
- 在用户提交后调用 `query()`
- 逐条消费 query 产生的事件并更新 UI

REPL 并不直接实现工具执行或模型调用，它只是 query 的事件消费者。

## 5. Headless / SDK 路径

在无头模式中，核心文件是 [src/cli/print.ts](../src/cli/print.ts) 和 [src/QueryEngine.ts](../src/QueryEngine.ts)。

### 5.1 QueryEngine 做什么

QueryEngine 相当于无头会话的“控制器”，负责：

- 保存会话级 `mutableMessages`
- 为每次提交构造 system prompt 与上下文
- 包装 `canUseTool`，记录 permission denial
- 调用 `query()`
- 把内部消息规范化为 SDK 可消费事件
- 维护 usage、transcript、replay 等 headless 需求

### 5.2 为什么 REPL 没用 QueryEngine

因为 REPL 侧更关心逐帧 UI 状态和本地交互，而 headless 更关心：

- 多次 `submitMessage()` 的连续会话语义
- SDK 事件协议
- structured output / permission prompt / replay 语义

两者共享同一套 query 内核，但外层封装不同。

## 6. 预处理阶段

### 6.1 用户输入不一定直接变成模型 prompt

输入进入 query 之前，系统会做不少前置处理，例如：

- slash command 解析
- 文件引用解析
- 历史展开
- memory / attachment 注入
- system prompt 追加
- agent / skill 相关上下文增强

这就是为什么很多“看似只是发一条 prompt”的路径，最终会带上大量附加上下文。

### 6.2 ToolUseContext 在这里开始成形

[src/Tool.ts](../src/Tool.ts) 的 `ToolUseContext` 会被逐步填充，其中包含：

- commands
- tools
- mcpClients
- AppState 访问能力
- readFileState
- notifications / JSX / stream 状态接口
- 当前消息列表

这个上下文随后会贯穿整个工具执行阶段。

## 7. query() 里真正发生了什么

[src/query.ts](../src/query.ts) 是系统热路径之一。它不是“调用一次模型然后返回”，而是一个多轮循环。

### 7.1 query loop 的基本结构

query loop 大致做这些事：

- 取当前消息状态
- 预取 memory / skill discovery
- 处理 tool result budget
- 做 snip / microcompact / context collapse / autocompact
- 生成用于 API 的最终消息窗口
- 调用模型 API
- 处理 streaming 输出
- 执行工具
- 决定是继续还是结束

### 7.2 上下文管理是 query 的核心复杂度来源

系统并不简单保留全部消息，而是会根据上下文大小与策略做不同层次的收缩：

- snip
- microcompact
- context collapse
- autocompact

这些机制存在的意义是：

- 控制 token 成本
- 保持长会话可持续运行
- 让历史在必要时被摘要，而不是无限增长

因此如果你在调试“为什么某段历史不见了”，第一站通常就是 query 里的 compact 相关逻辑。

## 8. 模型调用阶段

模型调用最终由 [src/services/api/claude.ts](../src/services/api/claude.ts) 负责。

这一层会根据当前上下文组装：

- model
- messages
- system prompt
- tool schemas
- thinking config
- beta headers
- output config / task budget

这也是 prompt cache、effort、fast mode、context management 等参数最终汇聚的地方。

## 9. assistant 流式输出阶段

在流式阶段，系统会持续收到 assistant message delta，并从中识别：

- 普通文本输出
- thinking / redacted thinking
- tool_use block
- stop reason
- usage 信息

一旦出现 tool_use，query 就不会立刻结束，而是进入工具执行阶段。

## 10. 工具执行阶段

工具执行的核心在：

- [src/services/tools/toolOrchestration.ts](../src/services/tools/toolOrchestration.ts)
- [src/services/tools/StreamingToolExecutor.ts](../src/services/tools/StreamingToolExecutor.ts)
- [src/services/tools/toolExecution.ts](../src/services/tools/toolExecution.ts)

### 10.1 两种调度方式

系统支持两种主要执行方式：

- 串行执行
- 对只读/并发安全工具进行并行执行

并发安全的判断来自工具自身的 `isConcurrencySafe()` 和 `isReadOnly()` 等定义。

### 10.2 单个工具调用的真实流程

单次工具调用不是直接 `tool.call()`，而是会经过：

1. 输入校验
2. pre-tool hooks
3. hook permission decision 与规则判断
4. `canUseTool` 权限判断
5. 真正执行 `tool.call()`
6. post-tool hooks / failure hooks
7. 将结果转换为 `tool_result` message

这也是为什么“工具执行异常慢”不一定是工具本身慢，也可能是 hook、permission、post-processing 在耗时。

## 11. 权限判断阶段

权限判断不是一个点，而是一条链：

- 工具自身的 `checkPermissions`
- 规则匹配（always allow / deny / ask）
- hooks 产生的 allow/deny/ask 决策
- 交互式权限对话框或 SDK permission prompt

在无头模式下，权限请求由 [src/cli/structuredIO.ts](../src/cli/structuredIO.ts) 适配成 SDK request/response。

在 bridge 场景下，权限还会跨远端客户端回传。

## 12. Task 是如何卷进来的

有些工具执行是立即返回结果的，例如 Read、Edit。

但下列能力往往会创建 Task：

- BashTool 长命令或后台命令
- AgentTool 后台子代理
- 主会话后台化
- remote agent / ultraplan / ultrareview
- in-process teammate

Task 创建后，会写入 `AppState.tasks`，同时通常还会有：

- 输出文件
- 通知消息
- 完成/失败/停止状态流转

所以“工具执行”与“任务系统”不是两套并列逻辑，而是经常上下游衔接。

## 13. 结果回流与继续执行

工具执行完成后，query 会把生成的：

- user message（包含 tool_result）
- attachment message
- progress message
- compact boundary / tombstone 等控制消息

重新拼回消息流，然后决定：

- 继续下一轮调用模型，还是
- 正常结束当前 turn

这就是 query loop 之所以是“循环”而不是“一次函数调用”的原因。

## 14. transcript 与状态落盘

会话过程中，系统会不断把消息与状态写入磁盘，例如：

- transcript
- compact boundary
- sidechain transcript
- task output 文件
- remote task metadata

这部分对以下能力非常关键：

- `--resume`
- 背景任务查看
- 会话恢复
- 远程任务轮询

## 15. REPL 与 print 的差异点

虽然两者共用 query 内核，但仍有一些重要差异：

| 方面 | REPL | print / SDK |
| --- | --- | --- |
| 事件消费方式 | UI 逐条渲染 | structured IO 输出 |
| 权限交互 | 本地终端 UI | SDK callback / request-response |
| 会话封装 | 组件状态 + query | QueryEngine + stream protocol |
| 任务反馈 | 任务面板、提示、消息列表 | stream-json 事件、task_notification |

## 16. 调试一轮请求时建议的断点

如果你想跟一轮请求，最有效的断点顺序通常是：

1. [src/screens/REPL.tsx](../src/screens/REPL.tsx) 或 [src/cli/print.ts](../src/cli/print.ts)
2. [src/query.ts](../src/query.ts)
3. [src/services/api/claude.ts](../src/services/api/claude.ts)
4. [src/services/tools/toolExecution.ts](../src/services/tools/toolExecution.ts)
5. 具体工具实现，例如 [src/tools/BashTool/BashTool.tsx](../src/tools/BashTool/BashTool.tsx)
6. 任务实现，例如 [src/tasks/LocalShellTask/LocalShellTask.tsx](../src/tasks/LocalShellTask/LocalShellTask.tsx)

## 17. 这一章之后应该读什么

如果你已经理解一轮请求怎么跑，下一步最适合读 [command-tool-task-system.md](./command-tool-task-system.md)。它会把命令、工具、任务、技能、Agent、MCP 之间的关系解释清楚。
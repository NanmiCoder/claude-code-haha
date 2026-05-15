# 命令、工具与任务系统

## 1. 这三者分别解决什么问题

在这个项目里，很多人一开始会把 command、tool、task 混在一起。实际上它们解决的是三种不同问题：

| 概念 | 回答的问题 | 典型例子 |
| --- | --- | --- |
| Command | 用户显式输入什么？ | `/review`、`/model`、`/mcp` |
| Tool | 模型可以调用什么能力？ | Bash、Read、Edit、Agent、MCPTool |
| Task | 长耗时工作如何继续运行、展示与回收？ | 后台 Bash、后台 Agent、远程任务 |

理解这三者的边界，是理解整个仓库扩展机制的前提。

## 2. Command 系统

### 2.1 命令注册入口

命令的统一注册入口是 [src/commands.ts](../src/commands.ts)。

它并不是单纯导出一个常量数组，而是把多种来源合并在一起：

- 内建 slash 命令
- skills 目录下的 prompt 型命令
- 插件命令
- workflow 命令
- MCP 注入的 skills/commands

### 2.2 命令的真实来源

`getCommands(cwd)` 最终会组合：

- `getSkills(cwd)`
- `getPluginCommands()`
- `getWorkflowCommands(cwd)`
- 内建 `COMMANDS()`

所以当你问“某个命令为什么会出现在命令列表里”，不要只看 `src/commands/*`，还要考虑技能、插件和 MCP。

### 2.3 命令类型

从系统设计角度，命令大致有三类：

- `local`：本地执行逻辑，通常直接改状态或输出文本
- `local-jsx`：会渲染 Ink UI 的本地命令
- `prompt`：本质上是 prompt/skill，通常会扩展为文本或由 SkillTool 调用

这是 bridge safe command、模型可调用性等逻辑的重要基础。

## 3. Tool 系统

### 3.1 Tool 是模型的能力接口

[src/Tool.ts](../src/Tool.ts) 定义了 Tool 抽象与 `ToolUseContext`。每个工具至少需要描述：

- 名称
- 输入 schema
- 输出 schema
- prompt / description
- 权限检查
- 调用逻辑 `call()`
- 结果如何映射成 `tool_result`

### 3.2 工具注册入口

统一注册入口是 [src/tools.ts](../src/tools.ts)。

这里会把所有可能的基础工具汇总起来，再根据：

- 环境变量
- feature gate
- 当前模式
- 权限策略

过滤出本次会话可见的工具集。

### 3.3 工具类别

从能力性质看，工具可以分为：

| 类别 | 代表实现 | 作用 |
| --- | --- | --- |
| 文件类 | `FileReadTool`、`FileEditTool`、`FileWriteTool` | 读写文件、Notebook |
| Shell 类 | `BashTool`、`PowerShellTool` | 执行命令、后台 shell |
| Web 类 | `WebFetchTool`、`WebSearchTool`、`WebBrowserTool` | 访问网络与页面 |
| 协作类 | `AgentTool`、`SendMessageTool`、`TeamCreateTool` | 子代理与团队协作 |
| 计划/任务类 | `EnterPlanModeTool`、`Task*Tool`、`TodoWriteTool` | 计划模式与任务系统 |
| MCP 类 | `MCPTool`、`McpAuthTool`、resource tools | 外部系统接入 |
| 辅助类 | `ToolSearchTool`、`TaskOutputTool`、`TaskStopTool` | 查找能力、读取输出、终止任务 |

### 3.4 ToolUseContext 是工具执行基座

绝大多数工具都依赖 `ToolUseContext` 提供的能力，例如：

- 当前可用命令与工具
- AppState 读写
- mcpClients
- file cache
- notifications / JSX
- 消息历史
- permission context

这意味着工具不是“纯函数”，而是运行在一个受控执行环境里。

### 3.5 并发安全工具

工具可以声明自己是否并发安全，例如只读工具通常可以并发执行。

这会被 [src/services/tools/toolOrchestration.ts](../src/services/tools/toolOrchestration.ts) 和 [src/services/tools/StreamingToolExecutor.ts](../src/services/tools/StreamingToolExecutor.ts) 用来决定：

- 串行跑
- 只读批并行跑

## 4. Skill 系统

### 4.1 Skill 本质是 prompt 型命令

[src/tools/SkillTool/SkillTool.ts](../src/tools/SkillTool/SkillTool.ts) 暴露的是一个“模型可调用的技能入口”。

它会把：

- 本地 skills
- MCP skills
- 某些 prompt 型命令

统一包装成模型可以触发的能力。

### 4.2 Skill 既可 inline，也可 fork 成子代理

SkillTool 不总是简单拼接 prompt。某些 skill 会通过 forked agent 执行，隔离上下文与 token 预算。

这也是为什么 skill 和 agent 在这个系统里有天然联系。

## 5. Agent 系统

### 5.1 AgentTool 是子代理启动器

[src/tools/AgentTool/AgentTool.tsx](../src/tools/AgentTool/AgentTool.tsx) 负责启动新 agent。它支持：

- 前台同步子代理
- 后台异步子代理
- 队友/团队协作
- worktree 隔离
- MCP 能力附加

### 5.2 Agent 定义从哪里来

Agent 定义通常由 [src/tools/AgentTool/loadAgentsDir.ts](../src/tools/AgentTool/loadAgentsDir.ts) 加载，可能来自：

- 内建 agent
- 用户自定义 agent
- 插件或技能前置定义

Agent 本身可以指定：

- tools 白名单/黑名单
- system prompt
- hooks
- mcpServers
- memory 行为

### 5.3 AgentTool 往往会创建 Task

同步 agent 在前台跑，但可以被 background。

异步 agent 会直接注册为 `local_agent` task，并将输出写入 sidechain transcript/任务输出文件，再通过通知回流给主会话。

## 6. Task 系统

### 6.1 Task 的统一抽象

[src/Task.ts](../src/Task.ts) 定义了统一 Task 抽象。`TaskStateBase` 则提供所有任务共享的基础字段，例如：

- `id`
- `type`
- `status`
- `description`
- `outputFile`
- `notified`

### 6.2 当前有哪些任务类型

`src/tasks/types.ts` 目前列出的核心任务类型包括：

- `local_bash`
- `local_agent`
- `remote_agent`
- `in_process_teammate`
- `local_workflow`
- `monitor_mcp`
- `dream`

### 6.3 任务系统解决哪些共性问题

任务系统统一解决：

- 注册到 `AppState.tasks`
- 后台状态跟踪
- 进度更新
- 结果通知
- output 文件落盘
- 终止与清理
- resume / restore

### 6.4 本地 shell 任务

[src/tasks/LocalShellTask/LocalShellTask.tsx](../src/tasks/LocalShellTask/LocalShellTask.tsx) 负责 Bash/PowerShell 这类 shell 任务。

它支持：

- 前台运行再后台化
- 直接后台 spawn
- 输出写入 TaskOutput
- 通知完成/失败/停止

### 6.5 本地 agent 任务

[src/tasks/LocalAgentTask/LocalAgentTask.tsx](../src/tasks/LocalAgentTask/LocalAgentTask.tsx) 负责后台子代理。

它额外处理：

- sidechain transcript
- agent progress summary
- pending message 注入
- retain / diskLoaded / evictAfter 这类 UI 展示语义

### 6.6 主会话后台任务

[src/tasks/LocalMainSessionTask.ts](../src/tasks/LocalMainSessionTask.ts) 解决的是“把当前主线程会话整体后台化”。

这不是普通 agent task，而是把当前 query 独立继续跑，并用单独 transcript 持久化。

### 6.7 远程任务

[src/tasks/RemoteAgentTask/RemoteAgentTask.tsx](../src/tasks/RemoteAgentTask/RemoteAgentTask.tsx) 负责轮询远端 session，如：

- remote agent
- ultrareview
- ultraplan
- autofix-pr

它的核心不在本地执行，而在：

- poll 远端状态
- 同步 log
- 提取 review/plan 等结构化结果
- 结束时注入 task_notification

### 6.8 In-process teammate

[src/tasks/InProcessTeammateTask](../src/tasks/InProcessTeammateTask) 代表同进程队友。它与普通后台 agent 的最大不同是：

- 不一定是独立进程
- 支持 mailbox 与待处理用户消息
- 有 team identity 和 plan approval 流程

## 7. 命令、工具、任务是如何串起来的

最常见的几条链路如下：

### 7.1 Slash 命令链路

用户输入 `/xxx` -> command 解析 -> 本地执行或转成 prompt -> 可能继续进入 query

### 7.2 工具链路

模型生成 `tool_use` -> tool execution -> 立即返回 `tool_result` 或创建 Task -> query 继续

### 7.3 后台链路

工具/命令触发后台执行 -> 注册 Task -> Task 输出写盘 -> 通知消息回到主会话

## 8. 什么时候该扩 Command，什么时候该扩 Tool

一个实用判断表：

| 需求 | 更适合的扩展点 | 原因 |
| --- | --- | --- |
| 用户显式输入一个 slash 命令 | Command | 这是显式用户入口 |
| 希望模型主动调用一个能力 | Tool | Tool 才是模型可调用协议 |
| 希望复用一段 prompt 逻辑 | Skill | Skill 更适合 prompt 级复用 |
| 需要长时间运行并可查看进度 | Task | Task 提供后台与通知语义 |
| 想接入外部系统工具集 | MCP server | 可统一注入 tools/commands/resources |
| 想定义一类可复用子代理人格/能力边界 | Agent | Agent 有系统提示词与工具范围 |

## 9. 这个系统最有特色的地方

### 9.1 Agent 不是简单的递归调用

在这里，AgentTool 不只是“再调一次模型”，而是会附带：

- agent context
- tool filtering
- MCP 继承/追加
- task 管理
- progress summary
- worktree cleanup

### 9.2 TaskOutputTool 与 TaskStopTool 是任务系统的模型接口

这意味着任务系统不是“只有 UI 能看见”，模型自己也能：

- 读取后台任务输出
- 主动停止后台任务

### 9.3 MCP 被深度融合进命令与工具系统

MCP 在这个仓库里不是外挂。它能直接参与：

- tool pool
- command pool
- skill pool
- resource 读取
- OAuth 授权

## 10. 扩展时最值得先读的文件

如果你要改扩展系统，建议先读：

- [src/commands.ts](../src/commands.ts)
- [src/tools.ts](../src/tools.ts)
- [src/Tool.ts](../src/Tool.ts)
- [src/Task.ts](../src/Task.ts)
- [src/services/tools/toolExecution.ts](../src/services/tools/toolExecution.ts)
- [src/tools/AgentTool/AgentTool.tsx](../src/tools/AgentTool/AgentTool.tsx)
- [src/tools/SkillTool/SkillTool.ts](../src/tools/SkillTool/SkillTool.ts)
- [src/tasks/LocalShellTask/LocalShellTask.tsx](../src/tasks/LocalShellTask/LocalShellTask.tsx)
- [src/tasks/LocalAgentTask/LocalAgentTask.tsx](../src/tasks/LocalAgentTask/LocalAgentTask.tsx)

## 11. 下一步建议

如果你已经理解 command / tool / task 之间的分工，接下来建议读 [bridge-remote-control.md](./bridge-remote-control.md) 或 [state-and-data-flow.md](./state-and-data-flow.md)，根据你更关心远控还是状态问题来选择。
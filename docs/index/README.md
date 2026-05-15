# Claude Code Haha 文档索引

这套文档的目标不是逐文件罗列，而是帮助你尽快建立“这个系统是怎么跑起来的、一次请求怎么流动、扩展点在哪里”的整体模型。

如果你第一次接触这个仓库，建议先把这句话记住：

这个项目本质上是一个“多运行模式的 Claude Code 执行框架”，同时支持本地 TUI、无头 SDK/print 模式、Remote Control bridge、MCP/插件/技能扩展，以及多种后台任务形态。

## 推荐阅读顺序

1. [architecture-design.md](./architecture-design.md)
   全局视角，先建立系统分层和关键设计原则。

2. [runtime-startup.md](./runtime-startup.md)
   从入口开始理解系统如何启动、初始化、进入交互态。

3. [request-lifecycle.md](./request-lifecycle.md)
   理解一次用户请求从输入、组装上下文、调用模型、执行工具到收尾的全过程。

4. [command-tool-task-system.md](./command-tool-task-system.md)
   理解命令、工具、任务、技能、Agent、MCP 在系统中的角色分工。

5. [bridge-remote-control.md](./bridge-remote-control.md)
   理解 Remote Control 的环境注册、会话创建、传输层、权限回调和重连机制。

6. [state-and-data-flow.md](./state-and-data-flow.md)
   理解 AppState、bootstrap state、ToolUseContext、磁盘持久化之间的边界。

7. [services-layer.md](./services-layer.md)
   快速熟悉 services 目录里的能力模块和外部系统边界。

8. [source-code-reading-guide.md](./source-code-reading-guide.md)
   面向“我下一步应该读哪些文件”的落地阅读路线。

## 先记住的 12 个事实

- 运行时是 Bun，主代码是 TypeScript，交互 UI 是 React + Ink。
- 根入口不是直接进 REPL，而是先走 [src/entrypoints/cli.tsx](../src/entrypoints/cli.tsx) 做快速分流。
- 真正的大入口是 [src/main.tsx](../src/main.tsx)，它负责 Commander CLI、初始化、setup、模式分发。
- 交互模式和无头模式共用同一套“查询执行内核”，核心在 [src/query.ts](../src/query.ts) 和 [src/QueryEngine.ts](../src/QueryEngine.ts)。
- 命令系统解决“用户显式触发什么”，工具系统解决“模型能调用什么”。
- 任务系统解决“长耗时工作如何后台化、如何显示进度、如何恢复/终止”。
- MCP 不只是工具来源，也能注入命令、skills 和资源。
- AgentTool 会把子代理执行包装成任务，既支持前台同步，也支持后台持续运行。
- AppState 不是唯一状态源；bootstrap state、ToolUseContext、磁盘 transcript、task output 都是状态面。
- Remote Control bridge 既有独立的 `claude remote-control` 服务器模式，也有会话内 `/remote-control` 常驻桥接模式。
- 这个代码库大量使用动态导入与 feature gate，以控制冷启动成本和不同构建目标的体积。
- 目录名很多，但真正的热路径并不多：入口、query、tool execution、task framework、MCP、bridge。

## 文档地图

| 文档 | 适合什么时候读 | 你会得到什么 |
| --- | --- | --- |
| [architecture-design.md](./architecture-design.md) | 刚进仓库 | 整体结构、层次边界、设计取舍 |
| [runtime-startup.md](./runtime-startup.md) | 想看启动链路 | 从 bin 到 REPL/print/bridge 的完整启动过程 |
| [request-lifecycle.md](./request-lifecycle.md) | 想看一轮请求怎么跑 | 一次 turn 的真实执行链 |
| [command-tool-task-system.md](./command-tool-task-system.md) | 想扩展系统 | 命令、工具、任务、技能、Agent 的协作模型 |
| [bridge-remote-control.md](./bridge-remote-control.md) | 想看远控/移动端 | bridge 生命周期、传输协议、权限回调 |
| [state-and-data-flow.md](./state-and-data-flow.md) | 调试复杂状态问题 | 哪些状态放哪里、如何流动、何时落盘 |
| [services-layer.md](./services-layer.md) | 想掌握 services 目录 | API、MCP、插件、压缩、策略、分析等服务地图 |
| [source-code-reading-guide.md](./source-code-reading-guide.md) | 不知道下一步读哪 | 面向源码阅读和调试的具体路径 |

## 图示资源

docs 目录原本已经包含几张架构图，建议与文字文档一起看：

- [00runtime.png](./00runtime.png)：运行截图
- [01-overall-architecture.png](./01-overall-architecture.png)：整体架构
- [02-request-lifecycle.png](./02-request-lifecycle.png)：请求生命周期
- [03-tool-system.png](./03-tool-system.png)：工具系统
- [04-multi-agent.png](./04-multi-agent.png)：多 Agent 架构
- [05-terminal-ui.png](./05-terminal-ui.png)：终端 UI
- [06-permission-security.png](./06-permission-security.png)：权限与安全
- [07-services-layer.png](./07-services-layer.png)：服务层
- [08-state-data-flow.png](./08-state-data-flow.png)：状态与数据流

## 关键概念速查

| 概念 | 说明 |
| --- | --- |
| Command | 用户显式触发的斜杠命令，或 prompt 型技能命令 |
| Tool | 模型可以直接调用的能力，如 Bash、Read、Edit、Agent、MCP 工具 |
| Task | 长耗时执行单元，用于后台 shell、子代理、远程任务、队友等 |
| Skill | 一类 prompt 型命令，可被 SkillTool 或命令入口调用 |
| Agent | 子代理定义，带 system prompt、工具范围、MCP 依赖等 |
| MCP | 外部能力接入层，可注入工具、命令、skills、resources |
| Bridge | Remote Control 远程控制层，把本地会话接到远端客户端 |

## 如何使用这套文档

如果你的目标是：

- 先跑通系统：读 [runtime-startup.md](./runtime-startup.md)
- 看懂一次请求：读 [request-lifecycle.md](./request-lifecycle.md)
- 扩一个能力：读 [command-tool-task-system.md](./command-tool-task-system.md)
- 查状态问题：读 [state-and-data-flow.md](./state-and-data-flow.md)
- 查 bridge 问题：读 [bridge-remote-control.md](./bridge-remote-control.md)
- 快速定位关键源码：读 [source-code-reading-guide.md](./source-code-reading-guide.md)

建议阅读方式：先建立全局模型，再回到具体文件，不要一上来直接从 [src/screens/REPL.tsx](../src/screens/REPL.tsx) 这种大文件头部顺序往下读。
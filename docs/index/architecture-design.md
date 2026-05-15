# 架构设计文档

## 1. 系统定位

Claude Code Haha 是一个本地可运行的 Claude Code 执行框架。它不是一个“单纯的命令行聊天工具”，而是把以下几类能力合并到了同一个运行时里：

- 交互式终端 UI
- 无头 SDK/print 模式
- Remote Control 远程控制
- MCP、插件、skills、agents 扩展
- 后台任务与多 Agent 协作

因此这个系统的核心难点并不在单一功能，而在“多运行模式共用同一套执行内核，同时尽量减少冷启动和模块耦合”。

## 2. 顶层设计目标

### 2.1 一个内核，多种入口

系统既要支持用户直接在终端里交互，也要支持 `--print`、SDK、bridge、remote review 等无头场景。

设计结果是：

- 入口层分流很多
- 查询执行内核尽量收敛到 `query()` / `QueryEngine`
- UI 层尽量不直接拥有业务逻辑

### 2.2 长耗时工作可后台化

模型调用、Bash、子代理、远程任务都可能长时间运行，所以系统把“后台化、进度展示、完成通知、恢复/终止”统一抽象为 Task。

### 2.3 扩展能力要可组合

系统同时支持：

- 内建工具
- MCP 工具
- prompt 型 skills
- 插件命令
- 自定义 agents

这要求命令、工具、任务、MCP、权限控制之间可以组合，而不是彼此孤立。

### 2.4 启动要尽量快

代码库很大，所以大量能力采用：

- dynamic import
- `feature('...')` 条件裁剪
- prefetch 与并行初始化
- preAction hook 延迟初始化

## 3. 架构总览

可以把系统理解成下面这几个层次：

```text
Shell / Bun script
  -> CLI entrypoints
    -> main runtime dispatch
      -> REPL / print / bridge / recovery
        -> query engine
          -> commands / tools / tasks
            -> services / external systems
              -> state / storage / telemetry
```

对应目录大致如下：

| 层次 | 主要目录/文件 | 责任 |
| --- | --- | --- |
| 入口层 | [bin/claude-haha](../bin/claude-haha), [src/entrypoints/cli.tsx](../src/entrypoints/cli.tsx) | 参数分流、快速路径、模式选择 |
| 主运行时 | [src/main.tsx](../src/main.tsx), [src/entrypoints/init.ts](../src/entrypoints/init.ts), [src/setup.ts](../src/setup.ts) | 初始化、Commander、配置、trust、环境准备 |
| 交互/无头层 | [src/screens/REPL.tsx](../src/screens/REPL.tsx), [src/cli/print.ts](../src/cli/print.ts), [src/localRecoveryCli.ts](../src/localRecoveryCli.ts) | 不同运行模式下的会话组织 |
| 查询执行层 | [src/query.ts](../src/query.ts), [src/QueryEngine.ts](../src/QueryEngine.ts) | 一次请求的主循环、模型调用、工具执行、上下文压缩 |
| 能力层 | [src/commands.ts](../src/commands.ts), [src/tools.ts](../src/tools.ts), [src/Task.ts](../src/Task.ts), [src/tasks](../src/tasks) | 命令注册、工具注册、任务抽象与后台执行 |
| 服务层 | [src/services](../src/services) | API、MCP、analytics、plugin、compact、oauth、policy 等 |
| 状态与存储层 | [src/bootstrap/state.ts](../src/bootstrap/state.ts), [src/state/AppStateStore.ts](../src/state/AppStateStore.ts), `utils/sessionStorage*`, `utils/task/*` | 进程状态、UI 状态、磁盘 transcript、任务输出、恢复数据 |
| 远控层 | [src/bridge](../src/bridge) | Remote Control、session bridge、transport、重连、权限回传 |

## 4. 运行模式

| 模式 | 入口 | 核心文件 | 主要用途 |
| --- | --- | --- | --- |
| TUI 交互模式 | `claude-haha` / `bun ... cli.tsx` | [src/main.tsx](../src/main.tsx), [src/screens/REPL.tsx](../src/screens/REPL.tsx) | 正常交互、Slash 命令、工具调用、任务面板 |
| 无头/SDK 模式 | `-p` / `--print` / SDK URL | [src/cli/print.ts](../src/cli/print.ts), [src/QueryEngine.ts](../src/QueryEngine.ts) | CI、脚本、集成宿主 |
| Remote Control 独立模式 | `claude remote-control` | [src/bridge/bridgeMain.ts](../src/bridge/bridgeMain.ts) | 把本地机器作为远程会话承载端 |
| 会话内桥接模式 | `/remote-control` 或自动 bridge | [src/bridge/initReplBridge.ts](../src/bridge/initReplBridge.ts), [src/bridge/replBridge.ts](../src/bridge/replBridge.ts) | 把当前 REPL 会话接到远端客户端 |
| Recovery CLI | `CLAUDE_CODE_FORCE_RECOVERY_CLI=1` | [src/localRecoveryCli.ts](../src/localRecoveryCli.ts) | 当 Ink/TUI 有问题时的降级交互 |

## 5. 核心架构关系

### 5.1 主链路

最重要的调用关系是：

1. 入口层根据参数和 feature gate 选择运行模式。
2. 主运行时完成配置、信任校验、权限环境、MCP/插件/技能预加载。
3. 交互层或无头层收集用户输入。
4. 查询执行层构造 system prompt、user context、tool pool、permission context。
5. 模型返回 assistant 内容和 tool_use。
6. 工具层执行能力，必要时创建 Task。
7. 结果回流到 query loop，继续下一轮或结束。
8. 过程中所有状态变化同步到 AppState、bootstrap state 和磁盘 transcript。

### 5.2 状态不是单中心化的

这是理解该项目的关键点。

系统同时存在四种主要状态面：

- bootstrap state：进程级、与 React 无关的运行时状态
- AppState：UI/会话级状态，供 REPL 与部分 headless 场景共享
- ToolUseContext：一次 query 和一次 tool call 的执行上下文
- 磁盘持久化：transcript、task output、bridge pointer、remote task metadata

如果你带着“所有状态都在一个 store 里”的预期读这个仓库，会非常痛苦。

### 5.3 Query 是内核，UI 只是外壳

REPL 并不自己实现“模型调用 + 工具执行”的核心流程，而是把输入和上下文交给 [src/query.ts](../src/query.ts)。

headless 路径也是同理，只是它通过 [src/QueryEngine.ts](../src/QueryEngine.ts) 做一层会话封装和 SDK 兼容输出。

所以要理解这个仓库，优先级通常是：

`main.tsx / REPL.tsx / print.ts` -> `query.ts` -> `services/tools/*` -> `具体工具实现`

## 6. 关键设计原则

### 6.1 通过显式上下文对象隔离复杂度

[src/Tool.ts](../src/Tool.ts) 中的 `ToolUseContext` 是系统里最重要的执行上下文之一。它把工具执行所需的命令集、工具集、MCP 客户端、AppState 读写能力、文件缓存、通知接口、历史消息等打包在一起。

这让工具实现不需要直接依赖全局单例，也让子代理、headless、REPL 能共享工具执行逻辑。

### 6.2 通过任务抽象统一长耗时能力

[src/Task.ts](../src/Task.ts) 提供 Task 抽象，`src/tasks` 里再实现：

- 本地 shell 任务
- 本地 agent 任务
- 主会话后台任务
- 远程 agent 任务
- in-process teammate
- dream task

这样系统可以用统一方式处理：

- 注册
- 进度更新
- 后台化
- 停止
- 通知
- 输出持久化

### 6.3 把 bridge 做成可注入的独立核心

bridge 目录里最值得注意的设计是“bootstrap-free core”。

例如 [src/bridge/replBridge.ts](../src/bridge/replBridge.ts) 和 [src/bridge/remoteBridgeCore.ts](../src/bridge/remoteBridgeCore.ts) 都倾向于通过参数注入依赖，而不是直接读取主运行时的所有模块。这是为了：

- 降低 bundle 体积
- 避免循环依赖
- 让 daemon/SDK 子路径可以重用 bridge 核心

### 6.4 通过动态导入与 gate 控制复杂功能

这个代码库有大量 feature gate 与动态导入，它们的作用并不只是“开关功能”，还承担：

- 构建时 dead code elimination
- 缩小某些子入口的模块图
- 把冷门能力从冷启动路径上移开

典型例子包括：

- `BRIDGE_MODE`
- `KAIROS`
- `COORDINATOR_MODE`
- `AGENT_TRIGGERS`
- `MCP_SKILLS`
- `CONTEXT_COLLAPSE`

### 6.5 通过“同一能力，不同呈现”兼容 TUI 和 SDK

很多能力不是写两套，而是同一套底层逻辑，不同上层适配：

- REPL 和 print 共用 query 内核
- Tool 权限既能走终端交互，也能走 SDK permission prompt
- bridge 既能服务 REPL，也能服务 standalone remote-control

## 7. 复杂度最高的几个区域

### 7.1 query + tools

因为这里同时处理：

- 上下文组装
- 压缩/截断/恢复
- 模型 streaming
- tool_use 执行
- hook 与权限
- transcript 持久化

### 7.2 task system

因为这里同时处理：

- 前台与后台转换
- 本地与远程任务
- 任务输出文件
- UI 展示与通知
- resume/stop/cleanup

### 7.3 MCP

因为 MCP 同时能注入：

- tools
- commands
- skills
- resources
- channel notifications
- OAuth 流程

### 7.4 bridge

因为 bridge 同时覆盖：

- 环境注册/会话创建
- 两种实现路径（env-based 与 env-less）
- 两种 transport 形态
- 权限请求回传
- JWT/token refresh
- reconnect/recovery

## 8. 对阅读者最有用的心智模型

推荐你把系统分成三条主轴来理解：

### 8.1 会话主轴

用户输入 -> query -> tool/task -> assistant 输出

### 8.2 能力主轴

commands / tools / skills / MCP / agents 是“Claude 能做什么”的不同载体。

### 8.3 运维主轴

init/setup/bridge/policy/telemetry/remote settings 决定“系统在什么环境下、以什么限制运行”。

## 9. 阅读建议

如果你已经有总体印象，下一步建议：

1. 读 [runtime-startup.md](./runtime-startup.md) 看系统如何启动。
2. 读 [request-lifecycle.md](./request-lifecycle.md) 看一轮 query 细节。
3. 读 [command-tool-task-system.md](./command-tool-task-system.md) 建立扩展模型。
4. 如果你关心远控，再读 [bridge-remote-control.md](./bridge-remote-control.md)。
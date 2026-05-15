# 运行时与启动流程

## 1. 为什么启动链路值得单独理解

这个项目的启动并不是“一个 `main()` 调完所有东西”那么简单。它需要同时兼顾：

- 快速响应 `--version`、`--help` 这类轻路径
- 避免无谓加载大型模块图
- 在 trust 建立之前不做危险动作
- 区分 TUI、print、bridge、daemon、recovery 等多模式入口

因此，启动链路本身就是系统设计的一部分。

## 2. 启动总览

### 2.1 shell 入口

默认入口是 [bin/claude-haha](../bin/claude-haha)。它先切到项目根目录，然后做一个非常早的判断：

- 如果 `CLAUDE_CODE_FORCE_RECOVERY_CLI=1`，直接走 [src/localRecoveryCli.ts](../src/localRecoveryCli.ts)
- 否则进入 [src/entrypoints/cli.tsx](../src/entrypoints/cli.tsx)

这意味着 recovery CLI 是一条真正的“短路路径”，不会加载完整 TUI。

### 2.2 TypeScript 入口分流

[src/entrypoints/cli.tsx](../src/entrypoints/cli.tsx) 的职责是：

- 处理超轻量 fast path，例如 `--version`
- 处理若干独立子入口，例如 Chrome MCP、daemon worker、remote-control、BG sessions
- 在确实需要完整 CLI 时，再动态导入主运行时

这一步的设计目标很明确：

不要为了一个很轻的参数路径，把整个 React/Ink/commands/module graph 都拉起来。

## 3. 主入口 main.tsx 做什么

[src/main.tsx](../src/main.tsx) 是真正的主程序入口。它完成三类工作：

### 3.1 提前做必须的 side effect

文件顶部就会做一些必须早执行的动作，例如：

- startup profiler 打点
- MDM 配置预读
- keychain 预取

这类逻辑的目标是把慢操作尽量前置并并行化，减少用户感知的冷启动时间。

### 3.2 构造 Commander CLI

`run()` 中创建 Commander 程序，注册大量 option 和 subcommand，并在 `preAction` hook 中完成真正的初始化。

这有一个重要好处：

- 只有在真正执行动作时才初始化
- 单纯展示 help 时可以跳过大量初始化成本

### 3.3 分发到具体运行模式

主 action 里会根据参数与状态选择：

- 交互式 REPL
- `--print` / stream-json 无头模式
- resume/continue/rewind/worktree 等高级路径
- bridge 与远程会话协作路径

## 4. init() 与 setup() 的分工

系统把“初始化”拆成了两个阶段：

| 阶段 | 文件 | 主要责任 |
| --- | --- | --- |
| init | [src/entrypoints/init.ts](../src/entrypoints/init.ts) | 启用配置系统、安全环境变量、代理/mTLS、遥测、graceful shutdown、远程设置预加载 |
| setup | [src/setup.ts](../src/setup.ts) | 确定 cwd/projectRoot/session、hook snapshot、worktree、UDS inbox、session memory、预取后台能力 |

### 4.1 init() 更偏“进程级初始化”

典型职责包括：

- `enableConfigs()`
- `applySafeConfigEnvironmentVariables()`
- 配置 CA 证书、mTLS、代理
- 注册 shutdown cleanup
- 初始化部分 analytics/growthbook 相关异步任务
- 设置 Windows shell

可以把它理解成：

“把当前进程调到一个可运行 Claude Code 的安全基线状态。”

### 4.2 setup() 更偏“会话级初始化”

典型职责包括：

- 设置 cwd / originalCwd / projectRoot
- 启动 UDS messaging
- 捕获 hooks 配置快照
- 初始化 file changed watcher
- 处理 `--worktree`
- 初始化 session memory
- 启动若干后台预取任务

可以把它理解成：

“为这一次会话建立正确的项目上下文和本地协作基础设施。”

## 5. 交互模式启动流程

交互模式的主流程可以简化为：

1. shell 执行 [bin/claude-haha](../bin/claude-haha)
2. 进入 [src/entrypoints/cli.tsx](../src/entrypoints/cli.tsx)
3. 动态导入 [src/main.tsx](../src/main.tsx)
4. Commander `preAction` 执行 `init()`
5. 主 action 中调用 `setup()`
6. 加载 commands、agents、MCP、plugins、skills
7. 渲染 [src/screens/REPL.tsx](../src/screens/REPL.tsx)
8. REPL 在用户提交输入后调用 `query()`

值得注意的点：

- trust 相关逻辑会阻止过早执行危险路径
- LSP、插件、某些远程功能会刻意延后，避免在不可信目录提前启动
- REPL 只是 UI 壳，真正的请求执行不在它内部实现

## 6. 无头模式启动流程

无头模式仍然经过 `main.tsx`，但最后不会渲染 REPL，而是转入 [src/cli/print.ts](../src/cli/print.ts)。

### 6.1 print 模式的关键职责

- 加载初始消息与 resume 状态
- 组装工具与命令池
- 构造 `canUseTool` 回调
- 调用 QueryEngine 或 `ask()` 执行会话
- 通过 structured IO 输出 text/json/stream-json

### 6.2 为什么单独有 QueryEngine

REPL 直接使用 `query()` 即可，但 headless/SDK 需要额外处理：

- SDK replay
- 权限拒绝结构化输出
- transcript 与消息归一化
- 状态在多个 `submitMessage()` 调用间延续

这就是 [src/QueryEngine.ts](../src/QueryEngine.ts) 存在的理由。

## 7. Remote Control 启动路径

Remote Control 有两条不同入口：

### 7.1 独立 bridge 服务器

`claude remote-control` 在 [src/entrypoints/cli.tsx](../src/entrypoints/cli.tsx) 里走 fast path，直接进入 [src/bridge/bridgeMain.ts](../src/bridge/bridgeMain.ts)。

它不会经过完整 REPL，而是启动一个承载远程 session 的桥接服务。

### 7.2 会话内 bridge

在正常 REPL 会话里，通过 `/remote-control` 或配置自动启用时，会调用 [src/bridge/initReplBridge.ts](../src/bridge/initReplBridge.ts)，进一步进入：

- [src/bridge/replBridge.ts](../src/bridge/replBridge.ts)，或
- [src/bridge/remoteBridgeCore.ts](../src/bridge/remoteBridgeCore.ts)

这条路径的特点是：

- 当前会话继续本地运行
- 同时把消息桥接到远程客户端
- 远程的控制请求、权限响应再回流到本地

## 8. Recovery CLI 启动路径

[src/localRecoveryCli.ts](../src/localRecoveryCli.ts) 是故障回退路径，特点是：

- 不依赖 Ink TUI
- 使用更简单的 readline 风格交互
- 启动链路明显更短

如果你只想确认“模型调用本身通不通”，这条路径非常有用。

## 9. 启动阶段的重要设计技巧

### 9.1 fast path

`cli.tsx` 对若干参数走零或极少导入的快速路径，例如：

- `--version`
- 某些专用 server/worker 参数
- remote-control
- bg sessions

### 9.2 动态导入

很多子系统不是静态 import，而是在真正需要时加载，例如：

- bridge
- daemon
- 某些 ant-only 能力
- 某些 feature-gated 模块

### 9.3 并行化初始化

启动过程中会主动把一些预取放早并发执行，例如：

- keychain prefetch
- MDM prefetch
- setup 与命令/agent 定义加载并行

### 9.4 trust 先行

系统非常强调“在目录可信之前，不要启动会执行代码或读取不可信配置的模块”。

这也是为什么很多逻辑不是越早越好，而是必须在 trust 之后再做。

## 10. 看启动链路时最值得断点的位置

如果你在调试启动问题，建议从这些位置下断点：

- [src/entrypoints/cli.tsx](../src/entrypoints/cli.tsx)
- [src/main.tsx](../src/main.tsx)
- [src/entrypoints/init.ts](../src/entrypoints/init.ts)
- [src/setup.ts](../src/setup.ts)
- [src/screens/REPL.tsx](../src/screens/REPL.tsx)
- [src/cli/print.ts](../src/cli/print.ts)
- [src/bridge/initReplBridge.ts](../src/bridge/initReplBridge.ts)

## 11. 启动阶段常见误区

### 11.1 误区：main.tsx 就是 REPL

不对。`main.tsx` 是“总调度入口”，它既负责 interactive，也负责 print、plugin、mcp、bridge 相关子路径。

### 11.2 误区：init 和 setup 是重复的

不对。它们分别面向进程级和会话级初始化，分工很明确。

### 11.3 误区：远控一定在 REPL 内启动

不对。独立 `remote-control` 模式是完全不同的启动路径。

## 12. 下一步建议

启动链路看完之后，下一步建议读 [request-lifecycle.md](./request-lifecycle.md)。那一份文档会解释系统启动之后，一次真实请求是怎么被执行的。
# 服务层说明

## 1. 为什么要单独看 services 目录

这个仓库的 `src/services` 并不是一个“纯后端 SDK 层”，而是承载了很多跨模块的业务基础设施，例如：

- 模型 API 调用
- MCP 客户端管理
- 上下文压缩
- 插件系统
- OAuth、策略、远程设置
- 通知、建议、记忆、LSP 等辅助能力

如果说 `query.ts` 是执行内核，那么 `services` 更像是它依赖的一组专业子系统。

## 2. 目录总览

当前 `src/services` 里最值得优先掌握的分组包括：

- `api`
- `tools`
- `mcp`
- `compact`
- `plugins`
- `analytics`
- `oauth`
- `policyLimits`
- `remoteManagedSettings`
- `SessionMemory`

## 3. API 服务层

### 3.1 主要目录

- [src/services/api](../src/services/api)

### 3.2 主要职责

- 调用模型 API
- 构造请求体
- 处理 usage / retry / fallback
- 提供文件下载等 API 辅助

### 3.3 关键文件

- [src/services/api/claude.ts](../src/services/api/claude.ts)
- `withRetry*`
- `errors*`
- `bootstrap*`

### 3.4 为什么重要

模型请求的最终参数、beta header、工具 schema、thinking、output config 等都在这里汇总。

## 4. Tool execution 服务层

### 4.1 主要目录

- [src/services/tools](../src/services/tools)

### 4.2 主要职责

- 工具调度
- 并发控制
- hook 执行
- 权限决策衔接
- tool result 规范化

### 4.3 关键文件

- [src/services/tools/toolOrchestration.ts](../src/services/tools/toolOrchestration.ts)
- [src/services/tools/StreamingToolExecutor.ts](../src/services/tools/StreamingToolExecutor.ts)
- [src/services/tools/toolExecution.ts](../src/services/tools/toolExecution.ts)
- [src/services/tools/toolHooks.ts](../src/services/tools/toolHooks.ts)

这是 query 内核之外的另一个热点目录。

## 5. MCP 服务层

### 5.1 主要目录

- [src/services/mcp](../src/services/mcp)

### 5.2 主要职责

- 解析配置
- 连接 MCP server
- 拉取 tools / commands / skills / resources
- 处理 OAuth 授权
- 处理 channel / elicitation / reconnect

### 5.3 关键文件

- [src/services/mcp/client.ts](../src/services/mcp/client.ts)
- `config.ts`
- `types.ts`
- [src/services/mcp/useManageMCPConnections.ts](../src/services/mcp/useManageMCPConnections.ts)
- [src/services/mcp/MCPConnectionManager.tsx](../src/services/mcp/MCPConnectionManager.tsx)

### 5.4 为什么它比你想象的大

在这个系统里，MCP 不只是工具来源，还能影响：

- 命令列表
- skills
- 资源读取
- channel 消息
- permission / approval / OAuth 流程

## 6. compact / context 管理服务层

### 6.1 主要目录

- [src/services/compact](../src/services/compact)

### 6.2 主要职责

- auto compact
- micro compact
- snip compact
- post compact cleanup
- 相关 token/usage 统计

### 6.3 为什么重要

长会话是否可持续，主要取决于这一层，而不是 UI。

如果你在调试：

- prompt too long
- 历史被摘要
- compact boundary
- token budget

第一站通常就是这里。

## 7. analytics 服务层

### 7.1 主要目录

- [src/services/analytics](../src/services/analytics)

### 7.2 主要职责

- GrowthBook gate
- 事件埋点
- Datadog / 1P event logging
- feature config 与实验开关

### 7.3 为什么必须知道它存在

这个仓库里很多行为不是纯代码静态决定，还会被：

- build-time feature gate
- runtime GrowthBook
- config / policy

共同影响。

所以遇到“为什么这里没走我以为的分支”时，analytics/growthbook 往往是解释器之一。

## 8. plugins 服务层

### 8.1 主要目录

- [src/services/plugins](../src/services/plugins)

### 8.2 主要职责

- 插件安装/卸载/更新
- marketplace 管理
- 插件命令与 MCP 注入
- 插件缓存与校验

### 8.3 相关入口

除了 services 层本身，插件能力还会在这些位置被消费：

- `commands/plugin*`
- `utils/plugins*`
- `main.tsx` / `setup.ts`

## 9. OAuth、策略与远程设置

### 9.1 主要目录

- [src/services/oauth](../src/services/oauth)
- [src/services/policyLimits](../src/services/policyLimits)
- [src/services/remoteManagedSettings](../src/services/remoteManagedSettings)
- [src/services/settingsSync](../src/services/settingsSync)

### 9.2 主要职责

- 身份与组织信息
- 企业策略限制
- 远程托管配置
- 用户设置同步

### 9.3 为什么对主流程有直接影响

这些服务层会直接影响：

- 是否允许 remote control
- 某些功能 gate 是否开启
- permission mode 是否可用
- 当前会话的环境变量与设置来源

## 10. SessionMemory 与记忆相关服务

### 10.1 主要目录

- [src/services/SessionMemory](../src/services/SessionMemory)
- `extractMemories`
- `teamMemorySync`

### 10.2 主要职责

- 初始化 session memory
- 提取和同步记忆
- 为长期会话提供额外上下文辅助

这一层与 prompt 组装、attachments、skills 之间往往有联动。

## 11. 其他值得知道但不必最先深挖的服务

| 目录/文件 | 作用 |
| --- | --- |
| `PromptSuggestion` | 输入建议与推测执行相关辅助 |
| `tips` | 提示语与 onboarding 辅助 |
| `lsp` | 语言服务集成 |
| `notifier.ts` / `preventSleep.ts` | 系统通知与运行时辅助 |
| `tokenEstimation.ts` | token 粗估相关辅助 |
| `voice*` | 语音相关能力 |
| `MagicDocs` | 文档/说明类附加能力 |

## 12. 服务层与其他层的依赖关系

### 12.1 常见依赖方向

通常是：

- query / tools / commands 依赖 services
- services 再依赖 utils、types、少量 state

但这个仓库不是严格洁净架构，所以你也会看到：

- 某些 services 读取 AppState
- 某些 services 受 bootstrap state 影响
- 某些 UI manager 也放在 services 中

### 12.2 不要强行把 services 当成“纯无状态层”

它更像“基础设施与能力子系统集合”，而不是传统后端里的 service class 层。

## 13. 读 services 代码的建议顺序

如果你时间有限，建议先看：

1. [src/services/api/claude.ts](../src/services/api/claude.ts)
2. [src/services/tools/toolExecution.ts](../src/services/tools/toolExecution.ts)
3. [src/services/mcp/client.ts](../src/services/mcp/client.ts)
4. compact 相关目录
5. analytics/growthbook
6. policyLimits / remoteManagedSettings

## 14. 调试时的经验法则

### 14.1 模型行为不符合预期

优先看：

- `services/api`
- `query.ts`
- compact 目录

### 14.2 外部工具、MCP、授权问题

优先看：

- `services/mcp`
- `tools/McpAuthTool`
- bridge 相关权限回传逻辑

### 14.3 运行时功能开关问题

优先看：

- `services/analytics/growthbook`
- `policyLimits`
- `remoteManagedSettings`

## 15. 下一步建议

如果你已经有了 services 目录的全局地图，最后建议读 [source-code-reading-guide.md](./source-code-reading-guide.md)。那一章会把这些理解转换成具体的源码阅读和调试路线。
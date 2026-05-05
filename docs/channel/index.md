# Channel 源码研究

> 这里讲的是 Claude Code 原生的 Channel / MCP 体系。  
> 如果你要配置当前桌面版的 Telegram / 飞书接入，请先看 [IM 接入文档](../im/)。

## 这组文档是干什么的

这个仓库当前实际可用的 IM 接入方案，是 `adapters/* + /api/adapters + /ws/:sessionId`。

`docs/channel/` 保留的价值主要是：

- 解释上游 Claude Code 的原生 Channel 机制
- 记录历史上为什么没有直接沿用那套机制做当前 IM 接入
- 作为后续架构演进时的参考资料

## 文档目录

### [01-channel-system.md](./01-channel-system.md)

从源码视角分析 Claude Code 原始 Channel 系统，包括：

- Channel 的概念模型
- MCP 通知和工具出入站协议
- 六层门控与权限中继
- Plugin Channel 的注册和安全边界

### [02-im-gateway-proposal.md](./02-im-gateway-proposal.md)

这是历史方案设计文档，记录了从 `IM Gateway` 设想演进到“独立 Adapter 直连 `/ws/:sessionId`”的过程。

它适合回答：

- 为什么最后没有走完整 Gateway
- 为什么当前实现选择了 `adapters/*`
- 设计阶段曾经考虑过哪些替代方案

## 相关入口

- [IM 接入总览](../im/)
- [Telegram 接入](../im/telegram)
- [飞书接入](../im/feishu)

## 适合谁看

- 想研究 Claude Code 原生 IM / Channel 思路的开发者
- 想理解当前仓库 IM 实现为什么没有直接复用 Channel 的贡献者
- 想做架构对比和二次设计的人

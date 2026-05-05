# 贡献指南与本地质量门禁

这份文档说明贡献代码前应该如何在本地安装、开发、测试和运行质量门禁。目标是让维护者和贡献者都能在提交 PR 前回答一个问题：这次改动有没有破坏核心 Coding Agent 工作流。

## 环境准备

项目根目录使用 Bun：

```bash
bun install
```

如果改动涉及 `adapters/`，或者要运行 `check:adapters`，安装 adapter 依赖：

```bash
cd adapters
bun install
```

不要提交本地运行产物，例如 `artifacts/quality-runs/`、`node_modules/`。

## 普通 PR 必跑门禁

普通贡献者在提交 PR 前至少运行：

```bash
bun run quality:pr
```

这个门禁不调用真实大模型，适合所有人本地运行。它会生成报告：

```text
artifacts/quality-runs/<timestamp>/report.md
artifacts/quality-runs/<timestamp>/report.json
```

PR 描述里请贴出你实际运行的命令和 summary。

## 按改动范围补充测试

根据你改动的区域补充运行：

```bash
bun run check:server      # 服务端 API、WebSocket、provider、会话等测试
bun run check:adapters    # IM adapter 测试
bun run check:docs        # 文档构建，使用 npm ci + docs:build
```

如果只改了很窄的文件，也可以先跑对应的定向测试，但 PR 前仍应跑 `bun run quality:pr`。

## 真实模型 Baseline

`quality:baseline` 用来跑真实 Coding Agent 任务：启动本地服务端、创建隔离 fixture、让模型通过聊天修代码、跑测试，并保存 transcript、diff、verification log 和报告。

默认命令不会调用真实模型：

```bash
bun run quality:baseline
```

要真正跑模型，必须显式加 `--allow-live` 并选择本机 provider。

先列出本机可用 provider 和可复制参数：

```bash
bun run quality:providers
```

输出示例：

```text
Saved providers:
  MiniMax
    selector: minimax
    main: MiniMax-M2.7-highspeed
      --provider-model minimax:main:minimax-main
```

复制输出里的参数运行 baseline：

```bash
bun run quality:gate --mode baseline --allow-live --provider-model minimax:main:minimax-main
```

可以一次跑多个模型：

```bash
bun run quality:gate --mode baseline --allow-live \
  --provider-model codingplan:main:codingplan-main \
  --provider-model minimax:main:minimax-main
```

`provider` selector 来自本机保存的 provider 配置。别人 clone 代码后不需要知道你的 provider UUID，也不需要使用你的供应商；他们可以配置自己的 provider 后运行 `bun run quality:providers` 选择自己的模型。

## 什么时候必须跑 Baseline

以下改动建议跑 live baseline：

- 会话恢复、WebSocket、CLI bridge
- provider/model/runtime 选择
- 权限、工具调用、文件编辑、任务执行
- Computer Use、Skills、MCP
- release 前或风险较大的跨模块重构

如果没有模型额度，至少运行 `bun run quality:pr`，并在 PR 里说明未跑 live baseline 的原因。

## Release 门禁

发版前使用 release 模式：

```bash
bun run quality:gate --mode release --allow-live --provider-model <selector>:main
```

release 模式会组合 PR checks、baseline catalog 和 live baseline。发版报告同样写入 `artifacts/quality-runs/<timestamp>/`。

## PR 提交流程

1. 新建普通产品分支，例如 `fix/session-reconnect` 或 `feat/provider-quality-gate`。
2. 安装依赖并完成改动。
3. 为行为变化补测试。
4. 运行相关定向测试。
5. 运行 `bun run quality:pr`。
6. 对高风险改动运行 live baseline。
7. 在 PR 描述里写清楚用户影响、测试命令、报告 summary、已知风险。

## 常见问题

### 没有 provider 可以跑吗？

可以跑普通门禁：

```bash
bun run quality:pr
```

只有 live baseline 需要真实模型。先配置自己的 provider，再运行：

```bash
bun run quality:providers
```

### provider selector 冲突怎么办？

如果两个 provider 名称生成了相同 selector，`quality:providers` 会退回输出 provider ID。直接复制它给出的 `--provider-model ...` 即可。

### 模型 ID 里带冒号怎么办？

优先使用角色选择，例如：

```bash
--provider-model custom:haiku:custom-haiku
```

脚本会把 `haiku` 解析成本机 provider 配置里的真实模型 ID。

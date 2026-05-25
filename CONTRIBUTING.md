# 贡献指南

提交 PR 前需要完成以下三步。

## 1. 运行本地门禁

```bash
bun run verify
```

`bun run verify` 会一键检查 policy、desktop、server、adapters、native、docs、quarantine 和 coverage。非 0 退出就说明当前分支还不能提交 PR。

已安装本地 hook 的仓库在 `git push` 前会自动运行快速门禁 `bun run quality:push`；它复用 PR 门禁但默认跳过耗时的 coverage lane，完整覆盖率仍以 `bun run verify` 为准。

只改了某个模块时可以用窄命令快速迭代：

| 改动范围 | 快速验证 |
| --- | --- |
| CLI / Server / 工具 | `bun run check:server` |
| 桌面端 | `bun run check:desktop` |
| IM Adapter | `bun run check:adapters` |
| Tauri / 原生 | `bun run check:native` |
| 文档 | `bun run check:docs` |

门禁失败时，查看最新质量报告和对应 lane 日志定位问题：

```
artifacts/quality-runs/<timestamp>/report.md
artifacts/quality-runs/<timestamp>/logs/<lane>.log
```

## 2. 桌面端功能必须手工测试

改动涉及 `desktop/` 的 UI、store、API 或 Tauri 原生层时，除了自动门禁外，还必须在真机上做手工测试：

- 起本地服务 `SERVER_PORT=3456 bun run src/server/index.ts`
- 起桌面端 `cd desktop && bun run dev`
- 验证改动涉及的交互流程：页面渲染、按钮/表单行为、弹窗、快捷键、多窗口等
- 必要时打本地 macOS 包 `desktop/scripts/build-macos-arm64.sh` 做完整验证

## 3. PR 必须附上影响范围和测试说明

每个 PR 的描述里必须包含：

- **影响范围**：改了哪些模块（desktop / server / adapter / native / docs / provider / agent-loop）
- **测试说明**：跑了哪些测试、覆盖率情况、手工测试了哪些流程（桌面端改动必须有真机测试记录）
- **剩余风险**：已知未覆盖的边界或需要后续跟进的点

如果改动了 provider/runtime、agent-loop、文件编辑、权限、session 等核心路径，还需要跑真实模型验证：

```bash
bun run quality:providers
bun run quality:smoke --provider-model <provider:model>
```

## 更多

完整质量门禁和覆盖率说明见 [AGENTS.md](AGENTS.md)。

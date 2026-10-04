# ts-tiny-claw

最小的 TypeScript agent harness。架构与目录约定见 `.cursor/rules/project-structure.mdc`。

## 模块职责

- `src/cli` 入口交互层(CLI,human-in-loop)
- `src/engine` ReAct MainLoop、强制 Thinking、运行时事件
- `src/provider` 大模型抽象与厂商实现
- `src/context` prompt 动态组装、token 监控、事件注入
- `src/memory` 基于 `.claw/` 文件系统的 todo 与记忆
- `src/tools` 工具注册表、审批 middleware、read/write/edit/bash
- `src/feishu` 飞书机器人与审批通道

## 约定

- ESM + `strict`,运行用 `pnpm dev`,类型检查用 `pnpm typecheck`
- tools 不直接依赖 feishu,只依赖 `ApprovalChannel` 接口
- 运行时状态写入 `.claw/`,不提交到 git

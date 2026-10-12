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

## Cursor Cloud specific instructions

- 单包 CLI。脚本见 `package.json`：`pnpm dev`、`pnpm typecheck`、`pnpm build`、`pnpm start`。没有 lint 或测试脚本。
- `pnpm dev` 依赖 gitignore 的 `.env`（从 `.env.example` 复制）。文件不存在时 `tsx --env-file=.env` 以退出码 9 报 `.env: not found`。`LLM_API_KEY` 为空时进程抛出 `LLM_API_KEY 未设置`。`pnpm start`（`node dist/claw.js`）不会读 `.env`，需要自行导出 `LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`。
- 未设置时，`src/provider/openai.ts` 默认 `https://api.deepseek.com` 与模型 `deepseek-flash`。`.env.example` 写的是 `deepseek-chat`。
- 没有必须常驻的本地服务。飞书、`.claw/` 记忆、read/write/edit/bash 仍是空模块。当前入口调用兼容 Chat Completions 的模型，工具是进程内的 `get_weather` mock。
- pnpm 10 会提示忽略 esbuild 的安装脚本。本环境里平台包已解压，`pnpm dev` 与 `pnpm build` 仍可成功。不要运行交互式的 `pnpm approve-builds`。

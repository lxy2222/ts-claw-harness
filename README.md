# Tiny Claw

最小 TypeScript Agent Harness：CLI 输入任务，模型选择工具，工具结果回到下一轮模型上下文，会话以 JSONL 保存在工作区。

## 启动

需要 Node.js >= 20.12 和 pnpm。

```bash
pnpm install
pnpm dev --help
```

通过环境变量或**启动目录**的 `.env` 配置模型服务；`.env` 不提交 Git。

```dotenv
LLM_API_KEY=填入自己的密钥
LLM_BASE_URL=填入兼容 Chat Completions 的接口地址
LLM_MODEL=填入该服务实际支持的模型标识
```

其中 `LLM_API_KEY` 必填。未指定地址与模型时沿用当前代码里的 DeepSeek 默认配置；不同服务的模型、流式和工具支持需以其实际接口为准。已有进程环境变量优先于 `.env`，不自动更换模型。

```bash
pnpm dev --session demo --workdir ./demo "读取说明文件，生成摘要并保存到 summary.md"
pnpm dev --session demo --workdir ./demo "继续刚才的对话，检查 summary.md"
pnpm build
pnpm start --help
```

工作区必须事先存在。会话标识相同且工作区相同，会恢复已有历史；使用新标识开启新会话。启动不会生成测试日志或清空旧会话。

## CLI 选项

| 选项 | 含义 |
| --- | --- |
| `--help` / `-h` | 无需密钥的帮助，不创建会话 |
| `--workdir` / `-C` | 工具和会话使用的工作区，默认当前目录 |
| `--session` / `-s` | 会话标识，默认 `default` |
| `--max-turns` | 执行轮数上限，默认 20；持续调用工具时明确停止 |
| `--context-chars` | 上下文字符估算预算，默认 12000；不是精确 token 计数 |
| `--no-stream` | 使用普通响应，兼容不支持流式工具调用的服务 |
| `--thinking` | 单独生成规划文本，再进入工具执行阶段 |
| `--plan` | 启用已有 `PLAN.md` / `TODO.md` 协议与未完成提醒 |

默认只实时输出模型正文，内部推理字段不作为流式正文展示。取消使用 Ctrl-C；任务会显式报取消，不把部分输出标成成功。

## 已实现

- Provider：兼容 Chat Completions；正文流式输出，按索引聚合分片工具调用，保留厂商推理字段；截断或不完整响应不执行工具。
- Engine：有轮数上限的工具循环，同会话单进程串行执行；模型前后与工具执行前检查取消。
- Tools：`read_file`、`write_file`、`edit_file`、`bash`。文件工具校验真实路径；读文件按块保留前缀。Bash 输出收集有界，超时和非零退出作为失败返回。
- Session：`.claw/sessions/<id>.jsonl` 追加记录；写盘失败显式报错；损坏历史保留并拒绝恢复，工作区与会话共同标识缓存。
- Context：加载工作区 `AGENTS.md` 与本地 skills；按完整用户回合获取工作记忆，折叠历史工具输出，保留工具调用配对。无法折叠到字符预算内时明确报错，可缩短输入或调整预算。
- CLI 审批：沿用危险 Bash 命令的启发式识别，明确允许才执行；EOF 和中断会结算为拒绝。

## 恢复与权限边界

恢复的是会话历史，不是执行检查点。上次进程在工具执行中退出时，缺少结果的调用会补记“执行结果未记录，请先检查副作用，禁止自动重复执行”，不会自动重新运行工具。

会话锁仅用于同一进程；不要让两个独立 CLI 进程同时写同一个会话文件。JSONL 写入不是跨进程事务，也没有掉电持久性保证。

文件工具的工作区路径检查和 Bash 审批是流程限制；Bash 仍以当前用户权限执行，并非操作系统沙箱。只在可信工作区运行。字符折叠与输出截断不等于完整 token 预算或进程内存限制。

`src/feishu` 和独立长期记忆模块目前仍是预留位置；飞书、REPL、多 Agent、Web 工作台与完整断点续跑不属于本轮 CLI 完成范围。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build
```

测试使用临时工作区、本地 HTTP/SSE 服务和可控假 provider，不使用真实密钥或修改工作区数据。包含完整 CLI 读取→编辑→读回及跨进程恢复历史；这些离线测试不代表真实模型服务已通过联调。

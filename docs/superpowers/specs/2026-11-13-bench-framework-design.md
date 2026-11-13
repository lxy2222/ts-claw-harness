# Bench：Agent 评测框架设计

> 状态：设计草案，待评审
> 日期：2026-11-13
> 适用范围：ts-tiny-claw 的离线可复现评测

## 1. 目标与非目标

**目标**

1. 一条命令跑完 N 个任务，输出可复现的成功率、成本、延迟。
2. 离线可重放：CI 和本地无网络时也能跑，用于回归。
3. 任务可增删、可校验、可归因：失败能定位到某一族、某一任务。
4. 数字经得起追问：给出样本量、方差、环境锁。

**非目标**

- 不做分布式执行、不做 Web UI、不做调度服务。
- 不做多语言（先 TS/JS），不追求和 SWE-bench 对齐。
- 不替代人工 review，只回答“这个 harness 在固定尺子上的表现”。

## 2. 总体架构

```
bench/cli.ts
├── validate   → task.ts 加载 + judge.ts 跑 G1/G2 关卡
├── run        → runner.ts → workspace.ts → engine(现有) → judge.ts → report.ts
├── compare    → report.ts 读两份 results.json 输出差异表
└── list       → 列出任务与元数据
```

| 模块 | 职责 | 依赖 |
| --- | --- | --- |
| `cli.ts` | 参数解析、子命令分发 | task/runner/report |
| `task.ts` | 任务 schema、加载、校验、路径解析 | fs |
| `workspace.ts` | 任务工作区准备、git 基线、清理 | fs, child_process |
| `runner.ts` | 遍历任务、并发控制、错误隔离、断点续跑 | workspace, engine, judge |
| `judge.ts` | 重置测试、注入隐藏用例、执行、判定 | fs, child_process |
| `provider.ts` | 真实/录制/回放三种 provider，统一装饰器 | src/provider |
| `report.ts` | 聚合指标、生成 `report.md` / `results.json`、对比 | fs |
| `types.ts` | `TaskSpec`、`TaskResult`、`RunSummary`、`Verdict` | — |

## 3. 与现有仓库的集成

设计原则：**不改产品代码的对外行为**，只增量。

| 现有模块 | 复用方式 | 需要的改动 |
| --- | --- | --- |
| `src/engine/loop.ts` `AgentEngine` | 每个任务 new 一个实例，`workDir` 指向任务目录 | `run()` 返回值从 `void` 改为 `RunSummary`（向后兼容，现有调用方可忽略） |
| `src/tools/*` | 直接复用 `RegistryImpl` + 四个工具 | 无 |
| `src/engine/session.ts` `Session` | 复用，`sessionId = bench-<task-id>`，JSONL 落在任务 workdir 的 `.claw/` | 无 |
| `src/provider/openai.ts` | 用装饰器包一层 `RecordingProvider` / `ReplayProvider` | 流式请求增加 `stream_options.include_usage`，读取 `chunk.usage` |
| `src/types/message.ts` | 复用 `Message` | 新增可选字段 `usage?: TokenUsage` |
| `src/context/*` | 由任务配置注入 `Compactor` / `PromptComposer` | 无 |
| `globalSessionMgr` | 键是 `workdir + sessionId`，任务间天然隔离 | 无 |

新增 `RunSummary`：

```ts
export interface RunSummary {
  turns: number;
  toolCalls: number;
  durationMs: number;
  usage: { promptTokens: number; completionTokens: number };
  stopReason: "final" | "max_turns" | "aborted" | "error";
}
```

> 为什么改 `run()` 而不是在 bench 里另写循环：另写一份会立刻和产品行为分叉，评测就不再测“你发布的东西”。这是评测框架最容易被做错的地方。

## 4. 任务模型

目录：

```
bench/tasks/<id>/
├── task.json        # 机器可读配置
├── repo/            # 失败态源码快照（git archive，不含 node_modules）
├── verify/          # 隐藏用例，判分时注入
└── meta.json        # 上游仓库、commit、license、F2P/P2P 列表、难度
```

`task.json`：

```jsonc
{
  "id": "ts-ms-001",
  "family": "fix",                 // fix | implement | harden
  "prompt": "用户反馈：ms(\"2 days\") 返回 undefined……",
  "setup": {
    "install": "pnpm install --offline --frozen-lockfile",
    "env": { "CI": "1" }
  },
  "verify": {
    "command": "pnpm vitest run --reporter=json",
    "testPaths": ["tests"],
    "expectMinTests": 42,
    "timeoutSec": 300
  },
  "limits": { "maxTurns": 30, "contextChars": 12000 },
  "tags": ["parsing", "boundary"]
}
```

任务生命周期：

```
prepare  → 复制 repo 到 .bench/work/<id>/，git init + commit 基线
run      → 注入 prompt，AgentEngine.run，记录 RunSummary
judge    → 重置 testPaths → 拷贝 verify → 执行 → 判定
cleanup  → 保留失败现场（--keep），默认删除
```

## 5. 隔离与判分

**隔离**

- 每个任务独立目录，`git init` 并提交基线，便于 `git checkout -- .` 与 patch 采集。
- 不污染用户工作区：所有产物落在 `bench/.work/`（已 gitignore）。
- 并发默认 1，`--jobs N` 时按任务隔离；`--llm-concurrency` 单独限制模型并发。

**判分步骤**

1. `git checkout -- <testPaths>`，`git clean -fd <testPaths>` —— 防改测试、防 `.only`/`.skip`。
2. 拷贝 `verify/` 到约定位置（如 `tests-hidden/`）。
3. 执行 `verify.command`，带超时、独立进程组（复用 `bash.ts` 的杀进程组思路）。
4. 判定：
   - `exit 0` **且** 测试数 ≥ `expectMinTests` **且** 隐藏用例全过 → `PASS`
   - 否则 `FAIL`
   - 超时 / 改测试 / 无改动 / 解析失败 → `INVALID`（单独统计，不进分母）

**反作弊清单**

| 手法 | 检测 |
| --- | --- |
| 删测试 | 测试数下限 + 恢复测试目录 |
| `.skip` / `.only` | 恢复测试目录 + 正则扫描 |
| 改断言 | 恢复测试目录 |
| 硬编码返回值 | 隐藏用例覆盖同一函数的其他输入 |
| 无限输出刷屏 | 工具输出本来就截断，判分只看 exit code |

## 6. 指标与报告

每个任务记录：`status`、`turns`、`toolCalls`、`promptTokens`、`completionTokens`、`costUsd`、`wallMs`、`patchLines`。

`report.md`：

```
## 汇总（n=30, repeat=3, model=deepseek-chat@2026-11, temp=0）
| 族 | 任务数 | pass@1 | pass@3 | invalid | 平均轮数 | 平均 tokens | $/任务 | p50 |
| fix | 12 | 58.3% ± 4.2% | 66.7% | 0 | 9.4 | 41.2k | 0.06 | 38s |
| implement | 10 | ... |
| harden | 8 | ... |

## 失败归因
- fix-03：8/9 次卡在 old_text 不匹配 → 定位能力问题
- ...
```

`results.json` 保存原始记录 + 环境锁（node/pnpm 版本、模型、commit、温度、seed、开始时间）。

`bench compare a.json b.json` 输出：

```
指标            baseline    optimized   Δ
pass@1          58.3%       61.0%       +2.7pp
平均 tokens     41.2k       26.1k       -36.7%
$/任务          0.06        0.04        -33%
```

## 7. 可复现性

三层锁：

1. **依赖锁**：任务仓库自带 lockfile；首次 `bench setup` 把依赖装进共享 store，之后全部 `--offline`。
2. **模型锁**：`--repeat N` + 温度 0 + 记录模型版本；`--replay` 使用录制文件，完全确定性。
3. **环境锁**：记录 node/pnpm 版本与 commit hash，写进 `results.json`。

**录制/回放**：

- `RecordingProvider` 把 `(messages, tools) → response` 写成 JSONL，key 用请求内容的哈希。
- `ReplayProvider` 按 key 命中，未命中即报错（不静默降级）。
- 用途：CI 里跑 bench 自身测试；复现某次失败现场。

## 8. 错误处理

| 场景 | 行为 |
| --- | --- |
| 任务配置非法 | `validate` 直接失败，列出字段与原因（中文） |
| 模型报错/超时 | 该任务记 `ERROR`，继续下一个，最后汇总 |
| 判分脚本崩溃 | 记 `INVALID`，保留现场 |
| 进程被 Ctrl-C | 已完成任务写入 `results.partial.json`，支持 `--resume` |
| 依赖安装失败 | 该任务 `INVALID(install)`，不阻塞其他任务 |

**断点续跑**：`--resume` 读 `results.json`，跳过已 `PASS` 的任务，重跑 `FAIL`/`ERROR`。

## 9. 目录与命令

```
bench/
├── cli.ts
├── task.ts
├── workspace.ts
├── runner.ts
├── judge.ts
├── provider.ts
├── report.ts
├── types.ts
├── tasks/
├── fixtures/          # 录制文件、tarball
└── .work/             # gitignore
```

```bash
pnpm bench list
pnpm bench validate --suite fix
pnpm bench run --suite all --repeat 3 --out bench/.work/run-01
pnpm bench compare bench/.work/base.json bench/.work/run-01/results.json
```

`package.json` 增加：`"bench": "tsx bench/cli.ts"`。

## 10. 分阶段实施

| 阶段 | 内容 | 产出 |
| --- | --- | --- |
| P0 | `types` / `task` / `workspace` / `judge` + 3 个金标准任务（假 provider） | `pnpm bench run` 离线跑通 |
| P1 | `runner` + `report` + `compare` + 12 个任务 | 第一张真实分数表 |
| P2 | 上下文优化（token 计数、裁剪、摘要）+ 消融 | token 降幅数字 |
| P3 | 工具优化（并行/重试/截断）+ `--repeat` 方差 | 第二张对比表 |
| P4 | 30 任务 + holdout + demo | 最终报告与 demo |

## 11. 验收标准

- `pnpm bench validate` 对 12 个任务返回 G1/G2 全通过。
- `pnpm bench run --suite all` 在无网络时也能跑（P0 金标准任务）。
- 报告包含：族级 pass@1、invalid 率、平均 tokens、$/任务、p50。
- `bench` 自身的测试进 `pnpm test`，不依赖网络与真实密钥。
- 同一 commit 连跑 3 次，pass@1 差异 ≤ 1 个任务。

## 12. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 任务构造耗时超预期 | W1 做不完 | 先 12 个，schema 稳定后再批量 |
| 上游测试 flaky | 分数抖动 | G1/G2 关卡筛掉；同任务跑 3 次 |
| 测试框架不统一（vitest/jest/ava） | 解析复杂 | 统一用 vitest；非 vitest 任务用 `expectMinTests` + exit code |
| `run()` 改返回值影响现有调用 | 低 | 返回新结构，忽略即可；补一条测试 |
| 模型 API 成本 | 低 | 全量一次 $2–8；开发期用 replay |

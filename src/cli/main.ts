// 入口交互层:解析参数、装配依赖、启动 engine。
import { existsSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { Compactor } from "../context/compactor";
import { AgentEngine } from "../engine/loop";
import { globalSessionMgr } from "../engine/session";
import { OpenAIProvider } from "../provider/openai";
import { CostTracker } from "../provider/tracker";
import { BashTool } from "../tools/bash";
import { EditFileTool } from "../tools/edit_file";
import { ApprovalMiddleware } from "../tools/middleware";
import { ReadFileTool } from "../tools/read_file";
import { RegistryImpl } from "../tools/registry";
import { WriteFileTool } from "../tools/write_file";
import type { Context } from "../types/context";
import { Role } from "../types/message";
import { CliApprovalChannel } from "./approval";
import { HELP, parseCliArgs } from "./options";

async function main(): Promise<void> {
  // 通过命令行参数接收用户的 prompt（支持 -prompt "xxx" 或直接位置参数 "xxx"）
  const rawArgs = process.argv.slice(2);
  const options = parseCliArgs(
    rawArgs.length > 0 ? rawArgs : ["--no-plan", "-s", "test_tracker_001", "__DEFAULT_PROMPT__"],
  );
  if (options.help) {
    console.log(HELP);
    return;
  }

  // 加载启动目录下的 .env 环境变量配置
  const envPath = path.join(process.cwd(), ".env");
  if (existsSync(envPath)) {
    try {
      loadEnvFile(envPath);
    } catch (error) {
      throw new Error("无法加载启动目录的 .env 配置", { cause: error });
    }
  }

  // 1. 初始化底层大模型 Provider，并用可观测性装饰器 CostTracker 包裹起来
  const baseProvider = OpenAIProvider.fromEnv();
  const modelName = process.env.LLM_MODEL || "deepseek-flash";
  // 构建 Tracker 装饰器：根据模型名称和单价（如 DeepSeek 报价：输入 1 元/百万Tokens，输出 2 元/百万Tokens）计费并记录耗时
  const tracker = new CostTracker(baseProvider, modelName, {
    inputPricePerMillion: 1.0,
    outputPricePerMillion: 2.0,
  });

  // 2. 确定物理工作区（直接在当前 git 仓库目录运行，方便使用 bash 执行 git status 列举未提交文件）
  let workDir: string;
  try {
    workDir = realpathSync(options.workDir);
    if (!statSync(workDir).isDirectory()) throw new Error("不是目录");
  } catch (error) {
    throw new Error(`工作区不存在或无法访问：${options.workDir}`, { cause: error });
  }

  const approvalChannel = new CliApprovalChannel();

  // 3. 挂载 4 大基础工具（去掉 Sub-Agent，专注测试 bash 与可观测性统计）
  const mainRegistry = new RegistryImpl();
  mainRegistry.registerTool(new ReadFileTool(workDir));
  mainRegistry.registerTool(new WriteFileTool(workDir));
  mainRegistry.registerTool(new BashTool(workDir));
  mainRegistry.registerTool(new EditFileTool(workDir));
  mainRegistry.use(new ApprovalMiddleware(approvalChannel));

  // 4. 实例化主引擎：传入包裹了底层 Provider 的 tracker 装饰器！
  const eng = new AgentEngine(
    tracker,
    mainRegistry,
    options.thinking,
    options.planMode,
    20,
    new Compactor(options.maxContextChars, 4),
  );

  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  const ctx: Context = { signal: controller.signal };

  try {
    const isDefaultDemo = options.prompt === "__DEFAULT_PROMPT__";
    if (isDefaultDemo) {
      rmSync(path.join(workDir, ".claw", "sessions", "test_tracker_001.jsonl"), { force: true });
    }

    const prompt = !isDefaultDemo
      ? options.prompt
      : `请使用 bash 工具执行 git status ，帮我列举当前仓库里所有未提交（已修改或未跟踪）的文件，并简要汇总汇报。`;

    const session = globalSessionMgr.getOrCreate(options.sessionId, workDir);
    // 将当前会话绑定到 Tracker，使每次推理的 Token、费用与耗时同步写入 Session 统计字段
    tracker.bindSession(session);

    console.log(`\n>>> 🚀 收到指令: ${prompt}\n`);

    // 将用户的 Prompt 压入 Session 并唤醒引擎执行
    session.append({ role: Role.User, content: prompt });
    await eng.run(ctx, session, undefined, {
      maxTurns: options.maxTurns,
      ...(options.stream
        ? {
            onTextDelta: (text: string) => {
              process.stdout.write(text);
            },
          }
        : {}),
    });

    // 6. 任务结束后直接由 Tracker 打印该 Session 的 Token、费用与时间统计账单
    tracker.printSummary();
  } finally {
    process.off("SIGINT", cancel);
  }
}

main().catch((err: unknown) => {
  let reason = err instanceof Error ? err.message : "未知错误";
  if (err instanceof Error && err.cause instanceof Error) reason += `：${err.cause.message}`;
  console.error(`\n任务失败：${reason}`);
  process.exitCode = 1;
});

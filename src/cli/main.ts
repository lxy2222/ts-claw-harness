// 入口交互层:解析参数、装配依赖、启动 engine。
import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { Compactor } from "../context/compactor";
import { AgentEngine } from "../engine/loop";
import { globalSessionMgr } from "../engine/session";
import { OpenAIProvider } from "../provider/openai";
import { BashTool } from "../tools/bash";
import { EditFileTool } from "../tools/edit_file";
import { ApprovalMiddleware } from "../tools/middleware";
import { ReadFileTool } from "../tools/read_file";
import { RegistryImpl } from "../tools/registry";
import { SubAgentTool } from "../tools/subagent";
import { WriteFileTool } from "../tools/write_file";
import type { Context } from "../types/context";
import { Role } from "../types/message";
import { CliApprovalChannel } from "./approval";
import { HELP, parseCliArgs } from "./options";

async function main(): Promise<void> {
  // 通过命令行参数接收用户的 prompt（支持 -prompt "xxx" 或直接位置参数 "xxx"）
  const rawArgs = process.argv.slice(2);
  const options = parseCliArgs(
    rawArgs.length > 0 ? rawArgs : ["--no-plan", "-s", "test_subagent_001", "__DEFAULT_PROMPT__"],
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

  // 1. 初始化大模型 Provider
  const provider = OpenAIProvider.fromEnv();

  // 2. 确定物理工作区
  const hasExplicitWorkDir = rawArgs.includes("-C") || rawArgs.includes("--workdir");
  const isProjectRoot = existsSync(path.join(process.cwd(), "src", "cli", "main.ts"));
  const targetWorkDir =
    !hasExplicitWorkDir && isProjectRoot
      ? path.join(process.cwd(), "workspace")
      : options.workDir;

  let workDir: string;
  try {
    if (!hasExplicitWorkDir && isProjectRoot) {
      mkdirSync(targetWorkDir, { recursive: true });
    }
    workDir = realpathSync(targetWorkDir);
    if (!statSync(workDir).isDirectory()) throw new Error("不是目录");
  } catch (error) {
    throw new Error(`工作区不存在或无法访问：${targetWorkDir}`, { cause: error });
  }

  const approvalChannel = new CliApprovalChannel();

  // 3.1 为只读侦察型 Sub-Agent 准备受限的注册表 (ReadOnly Registry：仅挂载 read_file 和 bash，不给 write/edit 权限)
  const readOnlyRegistry = new RegistryImpl();
  readOnlyRegistry.registerTool(new ReadFileTool(workDir));
  readOnlyRegistry.registerTool(new BashTool(workDir));
  readOnlyRegistry.use(new ApprovalMiddleware(approvalChannel));

  // 3.2 为主 Agent 准备大而全的注册表 (Main Registry)
  const mainRegistry = new RegistryImpl();
  mainRegistry.registerTool(new ReadFileTool(workDir));
  mainRegistry.registerTool(new WriteFileTool(workDir));
  mainRegistry.registerTool(new BashTool(workDir));
  mainRegistry.registerTool(new EditFileTool(workDir));
  mainRegistry.use(new ApprovalMiddleware(approvalChannel));

  // 4. 实例化主引擎
  const eng = new AgentEngine(
    provider,
    mainRegistry,
    options.thinking,
    options.planMode,
    20,
    new Compactor(options.maxContextChars, 4),
  );

  // 4.5 将带有 Engine 引用和只读 Registry 的 SubAgent 工具注册进主 Agent 的工具箱中
  mainRegistry.registerTool(
    new SubAgentTool(
      eng,
      readOnlyRegistry,
      "explore_subagent",
      "委派一个只读侦察子智能体（仅拥有 read_file 和 bash 权限，无权修改文件）去深入探索目录或检索文件内容。支持在同一轮并发调用多个 explore_subagent 同时探索不同线索！",
    ),
  );

  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  const ctx: Context = { signal: controller.signal };

  try {
    const isDefaultDemo = options.prompt === "__DEFAULT_PROMPT__";
    if (isDefaultDemo) {
      // 每次运行演示测试前，彻底清空 workspace/.claw/sessions 目录下的所有历史记录，
      // 防止子智能体或 bash grep 扫描工作区时误读到旧会话 .jsonl 中的提示词或旧答案！
      rmSync(path.join(workDir, ".claw", "sessions"), { recursive: true, force: true });
    }

    const prompt = !isDefaultDemo
      ? options.prompt
      : `
我把系统的核心密码藏在了当前工作区的某个角落。目前有两个可疑线索：
线索 A：根目录下的 fake1.go 和 fake2.go 文件
线索 B：legacy 目录下的深层配置文件

请你不要亲自去读文件或跑 bash 翻目录（保持你自己的主上下文干净）！
请在同一轮并发调用两个 explore_subagent 子智能体分别去排查「线索 A」和「线索 B」，拿到它们的汇报后，把核心密码写入根目录的 found_secret.txt 文件中！
`.trim();

    const session = globalSessionMgr.getOrCreate(options.sessionId, workDir);

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

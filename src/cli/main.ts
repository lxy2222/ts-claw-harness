// 入口交互层:解析参数、装配依赖、启动 engine。
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { Compactor } from "../context/compactor";
import { AgentEngine } from "../engine/loop";
import { globalSessionMgr } from "../engine/session";
import { OpenAIProvider } from "../provider/openai";
import { BashTool } from "../tools/bash";
import { EditFileTool } from "../tools/edit_file";
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
  const options = parseCliArgs(rawArgs);
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

  // 1. 初始化大模型 Provider（若未配置 LLM_API_KEY 会在此处提前抛错，不会在磁盘上残留空目录）
  const provider = OpenAIProvider.fromEnv();

  // 2. 确定物理工作区：
  // 如果是在 ts-tiny-claw 仓库根目录下直接运行且未显式指定 -C/--workdir，
  // 默认对齐 Go 版使用 ./workspace 子目录作为沙箱工作区，防止污染引擎自身源码目录。
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

  // 3. 挂载 4 大基础工具（ReadFile / WriteFile / Bash / EditFile）
  const registry = new RegistryImpl();
  registry.registerTool(new ReadFileTool(workDir));
  registry.registerTool(new WriteFileTool(workDir));
  registry.registerTool(new BashTool(workDir, new CliApprovalChannel()));
  registry.registerTool(new EditFileTool(workDir));

  // 4. 实例化引擎并开启计划模式 (enableThinking = options.thinking, planMode = options.planMode，默认 true)
  const eng = new AgentEngine(
    provider,
    registry,
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
    // 5. 使用固定的 SessionID (默认 "task_web_server_01") 获取或创建会话
    const session = globalSessionMgr.getOrCreate(options.sessionId, workDir);

    console.log(`\n>>> 🚀 收到指令: ${options.prompt}\n`);

    // 将用户的 Prompt 压入 Session 并唤醒引擎执行
    session.append({ role: Role.User, content: options.prompt });
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

// 入口交互层:解析参数、装配依赖、启动 engine。
import { AgentEngine } from "../engine/loop";
import { OpenAIProvider } from "../provider/openai";
import { BashTool } from "../tools/bash";
import { EditFileTool } from "../tools/edit_file";
import { ReadFileTool } from "../tools/read_file";
import { RegistryImpl } from "../tools/registry";
import { WriteFileTool } from "../tools/write_file";
import type { Context } from "../types/context";
import { CliApprovalChannel } from "./approval";

async function main(): Promise<void> {
  // 1. 获取工作区物理边界
  const workDir = process.cwd();

  // 2. 初始化真实的大脑:从 .env 读取 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL
  const provider = OpenAIProvider.fromEnv();

  // 3. 初始化真实的 Tool Registry,并挂载内置工具
  const registry = new RegistryImpl();
  registry.registerTool(new ReadFileTool(workDir));
  registry.registerTool(new WriteFileTool(workDir));
  registry.registerTool(new EditFileTool(workDir));
  registry.registerTool(new BashTool(workDir, new CliApprovalChannel()));

  // 4. 任务简单,关闭思考阶段以加快速度
  const engine = new AgentEngine(provider, registry, workDir, false);

  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  const ctx: Context = { signal: controller.signal };

  // 5. 下发一个必须通过真实工具才能完成的任务
  const prompt = `我当前目录下有一个 server.ts 文件。请帮我把里面 "todo: 增加鉴权逻辑" 下面的那个 if 语句，
整个替换为：if (user == null) { console.log("Forbidden!"); return; } 同时请你帮我修改这个文件，让它语法通过`;
  await engine.run(ctx, prompt);
}

main().catch((err: unknown) => {
  console.error("引擎运行崩溃:", err);
  process.exit(1);
});

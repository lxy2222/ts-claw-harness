// 入口交互层:解析参数、装配依赖、启动 engine。
import { AgentEngine } from "../engine/loop";
import { OpenAIProvider } from "../provider/openai";
import { ReadFileTool } from "../tools/read_file";
import { RegistryImpl } from "../tools/registry";
import type { Context } from "../types/context";

async function main(): Promise<void> {
  // 1. 获取工作区物理边界
  const workDir = process.cwd();

  // 2. 初始化真实的大脑:从 .env 读取 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL
  const provider = OpenAIProvider.fromEnv();

  // 3. 初始化真实的 Tool Registry,并挂载 ReadFile 工具
  const registry = new RegistryImpl();
  registry.registerTool(new ReadFileTool(workDir));

  // 4. 任务简单,关闭思考阶段以加快速度
  const engine = new AgentEngine(provider, registry, workDir, false);

  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  const ctx: Context = { signal: controller.signal };

  // 5. 下发一个必须通过真实工具才能完成的任务
  const prompt = "请调用工具读取一下当前工作区目录下 hello.txt 文件的内容，并用一句话向我总结它说了什么。";
  await engine.run(ctx, prompt);
}

main().catch((err: unknown) => {
  console.error("引擎运行崩溃:", err);
  process.exit(1);
});

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

  // 4. 开启慢思考阶段 (enableThinking = true)，验证二阶段规划 + 动态上下文组装
  const engine = new AgentEngine(provider, registry, workDir, true);

  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  const ctx: Context = { signal: controller.signal };

  // 5. 下发测试任务：同时验证 AGENTS.md 规范约束 + .cursor/skills 技能触发 (find-skills)
  const prompt = [
    "请帮我完成两件事：",
    "1. 在当前目录下新建或更新 server.ts，实现一个简单的 HTTP 服务器（包含一个健康检查接口和一个模拟报错接口，注意必须严格遵守本工作区 AGENTS.md 中的返回格式和错误处理规范）。",
    "2. 我想找一个关于 git 自动化提交的 agent skill 来扩展你的能力，请根据你拥有的专业技能（Agent Skills），在回复中告诉我应该使用什么 CLI 命令去搜索和安装这个 skill（不需要实际执行 bash 命令）。",
  ].join("\n");
  await engine.run(ctx, prompt);
}

main().catch((err: unknown) => {
  console.error("引擎运行崩溃:", err);
  process.exit(1);
});

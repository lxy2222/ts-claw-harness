// 入口交互层:解析参数、装配依赖、启动 engine。
// 当前用 mock provider / registry 验证 engine 的最小 ReAct 循环。
import { AgentEngine } from "../engine/loop";
import type { LLMProvider } from "../provider";
import { OpenAIProvider } from "../provider/openai";
import type { ToolRegistry } from "../tools/registry";
import type { Context } from "../types/context";
import type { Message, ToolCall, ToolDefinition, ToolResult } from "../types/message";
// 改为查询天气的provider

class MockProvider implements LLMProvider {
  private turn = 0;

  async generate(_ctx: Context, _messages: Message[], tools?: ToolDefinition[]): Promise<Message> {
    // 工具列表为空,说明这是引擎发起的 Phase 1: Thinking 阶段
    if (!tools || tools.length === 0) {
      return {
        role: "assistant",
        content:
          "【推理中】目标是检查文件。我不能直接盲猜,我需要先调用 bash 工具执行 ls 命令,看看当前目录下有什么,然后再做定夺。",
      };
    }

    // 工具列表不为空,说明这是 Phase 2: Action 阶段
    this.turn++;
    if (this.turn === 1) {
      return {
        role: "assistant",
        content: "我要执行我刚才计划的步骤了。",
        toolCalls: [{ id: "call_123", name: "bash", arguments: JSON.stringify({ command: "ls -la" }) }],
      };
    }

    return {
      role: "assistant",
      content: "根据工具返回的结果,我看到了 main.go,任务圆满完成!",
    };
  }
}

class MockRegistry implements ToolRegistry {
  getAvailableTools(): ToolDefinition[] {
    return [{
      name: "get_weather",
      description: "获取天气",
      inputSchema: {
        type: "object",
        properties: {
          city: { type: "string", description: "城市" },
        },
      },
    }];
  }

  async executeTool(_ctx: Context, call: ToolCall): Promise<ToolResult> {
    console.log(`工具执行中 获取工具名称 ${call.name}`)
    return {
      toolCallId: call.id,
      output: "API 返回今天是晴天 气温25度",
      isError: false,
    };
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  const ctx: Context = { signal: controller.signal };
  if (!process.env.LLM_API_KEY) {
    throw new Error("LLM_API_KEY 未设置");
  }
  const provider = new OpenAIProvider({
    apiKey: process.env.LLM_API_KEY,
    baseURL: process.env.LLM_BASE_URL,
    model: process.env.LLM_MODEL,
  });
  const engine = new AgentEngine(provider, new MockRegistry(), process.cwd(), true);
  await engine.run(ctx, "我想去北京跑步，帮我查查天气合适吗");
  // const engine = new AgentEngine(new MockProvider(), new MockRegistry(), process.cwd(), true);
  // await engine.run(ctx, "帮我检查当前目录的文件");
}

main().catch((err: unknown) => {
  console.error("引擎崩溃:", err);
  process.exit(1);
});

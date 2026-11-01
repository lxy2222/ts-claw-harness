// main loop of the engine 
import { PromptComposer } from "../context/composer";
import type { Context } from "../types/context";
import type { Message, ToolCall, ToolDefinition } from "../types/message";
import type { ToolRegistry } from "../tools/registry";
import type { LLMProvider } from "../provider";

function buildPlanningInstruction(tools: ToolDefinition[]): string {
  const toolList =
    tools.length > 0
      ? tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n")
      : "（当前没有可用工具）";
  return [
    "【规划阶段】请先分析任务，并写出下一步的行动计划。",
    "在下一阶段你可以调用以下工具：",
    toolList,
    "要求：",
    "1. 本阶段只做规划，不要调用工具，也不要假装执行命令或编造工具的返回结果。",
    "2. 只能使用上面列出的工具，说明打算调用哪个工具以及传入什么参数。",
    "3. 如果已有的信息足以完成任务，直接说明可以给出最终答复。",
  ].join("\n");
}

export class AgentEngine {
  private readonly composer: PromptComposer;

  constructor(
    private provider: LLMProvider,
    private registry: ToolRegistry,
    public workdir: string,
    public enableThinking: boolean = false,
  ) {
    this.composer = new PromptComposer(workdir);
  }

  async run(
    ctx: Context,
    userPrompt: string,
  ): Promise<void> {
    if (ctx.signal?.aborted) {
      throw new Error("Agent run aborted");
    }
    console.log(`[Engine] 引擎启动，锁定工作区: ${this.workdir}`);
    console.log(`[Engine] 慢思考模式 (Thinking Phase): ${this.enableThinking}`);

    const systemMessage = this.composer.build();
    const history: Message[] = [
      systemMessage,
      {
        role: "user",
        content: userPrompt,
      },
    ];

    let turnCnt = 0;
    while (true) {
      turnCnt++;
      console.log(`\n========== [Turn ${turnCnt}] 开始 ==========`);
      const availableTools = this.registry.getAvailableTools();

      // Phase 1: 慢思考阶段 (Thinking) - 剥夺工具，强制规划
      if (this.enableThinking) {
        console.log("[Engine][Phase 1] 剥夺工具访问权，强制进入慢思考与规划阶段...");

        // 传入空工具列表：模型看不到任何 JSON Schema，只能输出纯文本的思考过程。
        // 规划指令只用于本次调用，不写入 history，避免污染后续上下文。
        const planningInstruction: Message = {
          role: "user",
          content: buildPlanningInstruction(availableTools),
        };
        let thinkResp: Message;
        try {
          thinkResp = await this.provider.generate(ctx, [...history, planningInstruction], []);
        } catch (error) {
          throw new Error("Thinking 阶段生成失败", { cause: error });
        }

        if (thinkResp.content || thinkResp.reasoningContent) {
          console.log(`🧠 [内部思考 Trace]: ${thinkResp.content}`);
          // 只保留文本和推理过程，丢弃可能出现的 toolCalls（没有对应的工具结果会让 API 报错）
          history.push({
            role: "assistant",
            content: thinkResp.content,
            ...(thinkResp.reasoningContent ? { reasoningContent: thinkResp.reasoningContent } : {}),
          });
        }
      }

      // Phase 2: 行动阶段 (Action) - 恢复工具，顺着规划执行
      console.log("[Engine][Phase 2] 恢复工具挂载，等待模型采取行动...");

      let actionResp: Message;
      try {
        actionResp = await this.provider.generate(ctx, history, availableTools);
      } catch (error) {
        throw new Error("Action 阶段生成失败", { cause: error });
      }

      history.push(actionResp);

      if (actionResp.content) {
        console.log(`🤖 [对外回复]: ${actionResp.content}`);
      }

      const toolCalls = actionResp.toolCalls;
      if (!toolCalls || toolCalls.length === 0) {
        console.log("[Engine] 模型未请求调用工具，任务宣告完成。");
        break;
      }

      console.log(`[Engine] 模型请求并发调用 ${toolCalls.length} 个工具...`);

      // 所有工具同时启动;Promise.all 的结果与 toolCalls 一一按下标对应(相当于 Go 中预分配的切片),
      // executeTool 内部已捕获所有异常,单个工具失败不会中断其他工具
      const observations = await Promise.all(
        toolCalls.map((toolCall, idx) => this.executeAndObserve(ctx, toolCall, idx)),
      );
      console.log("[Engine] 所有并发工具执行完毕，开始聚合观察结果 (Observation)...");

      // 按模型给出的原始调用顺序追加,而不是按完成顺序
      history.push(...observations);
    }
  }

  private async executeAndObserve(ctx: Context, toolCall: ToolCall, idx: number): Promise<Message> {
    console.log(`  -> [Task-${idx}] 🛠️ 触发并行执行: ${toolCall.name}, 参数: ${toolCall.arguments}`);
    const result = await this.registry.executeTool(ctx, toolCall);
    if (result.isError) {
      console.log(`  -> [Task-${idx}] ❌ 工具执行报错: ${result.output}`);
    } else {
      console.log(`  -> [Task-${idx}] ✅ 工具执行成功 (返回 ${Buffer.byteLength(result.output)} 字节)`);
    }
    return { role: "user", content: result.output, toolCallId: toolCall.id };
  }
}

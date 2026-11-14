// main loop of the engine
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Compactor } from "../context/compactor";
import { PromptComposer } from "../context/composer";
import { RecoveryManager } from "../context/recovery";
import { Reminder } from "../context/reminder";
import type { LLMProvider } from "../provider";
import type { ToolRegistry } from "../tools/registry";
import type { Context } from "../types/context";
import type { Message, ToolCall, ToolDefinition, ToolResult } from "../types/message";
import { globalSessionMgr, Session } from "./session";

const DEFAULT_WORKING_MEMORY_LIMIT = 20;
const DEFAULT_COMPACTOR_MAX_CHARS = 12000;
const DEFAULT_COMPACTOR_RETAIN_MSGS = 4;

export interface RunOptions {
  maxTurns?: number;
  onTextDelta?: (text: string) => void;
}

interface ExecutionOutcome {
  observation: Message;
  rawResult: ToolResult;
}

function assertActive(ctx: Context): void {
  if (ctx.signal.aborted) throw new Error("任务已被用户取消");
}

function buildPlanningInstruction(tools: ToolDefinition[], planMode: boolean): string {
  const toolList =
    tools.length > 0
      ? tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n")
      : "（当前没有可用工具）";
  return [
    "【规划阶段】请先分析任务，并写出下一步的行动计划。",
    ...(planMode
      ? [
          "当前已开启 Plan Mode：请对照 PLAN.md 与 TODO.md 的状态，明确当前处于 STEP 1（环境嗅探/建档）、STEP 2（单步执行与实时打勾 `- [x]`）还是 STEP 3（迷失自救）。",
        ]
      : []),
    "在下一阶段你可以调用以下工具：",
    toolList,
    "要求：",
    "1. 本阶段只做规划，不要调用工具，也不要假装执行命令或编造工具的返回结果。",
    "2. 只能使用上面列出的工具，说明打算调用哪个工具以及传入什么参数。",
    "3. 如果已有的信息足以完成任务，直接说明可以给出最终答复。",
  ].join("\n");
}

export class AgentEngine {
  private readonly compactor: Compactor;
  private readonly recovery: RecoveryManager;
  private readonly reminder: Reminder;

  /**
   * 历史由 Session 保存。工具注册表可能绑定工作区，因此每个工作区分别装配引擎和工具。
   */
  constructor(
    private provider: LLMProvider,
    private registry: ToolRegistry,
    public enableThinking: boolean = false,
    public planMode: boolean = false,
    private readonly workingMemoryLimit: number = DEFAULT_WORKING_MEMORY_LIMIT,
    compactor?: Compactor,
    recovery?: RecoveryManager,
    reminder?: Reminder,
  ) {
    this.compactor =
      compactor ?? new Compactor(DEFAULT_COMPACTOR_MAX_CHARS, DEFAULT_COMPACTOR_RETAIN_MSGS);
    this.recovery = recovery ?? new RecoveryManager();
    this.reminder = reminder ?? new Reminder();
  }

  /**
   * 驱动一个 Session 运行 ReAct 闭环：
   * 推荐 engine.run(ctx, session, userPrompt)：输入与整轮执行在同一会话锁内。
   * engine.run(ctx, session) 保留供已装载输入的单一调用方使用。
   */
  async run(
    ctx: Context,
    sessionOrPrompt: Session | string,
    maybeUserPrompt?: string,
    options: RunOptions = {},
  ): Promise<void> {
    assertActive(ctx);
    const maxTurns = options.maxTurns ?? 20;
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) {
      throw new Error("最大轮数必须是正整数");
    }

    const session =
      sessionOrPrompt instanceof Session
        ? sessionOrPrompt
        : globalSessionMgr.getOrCreate("default", process.cwd());

    const userPrompt = typeof sessionOrPrompt === "string" ? sessionOrPrompt : maybeUserPrompt;

    // 使用会话级异步串行锁（OpenClaw Lane 模式），保证同一 Session 同一时刻只跑一个 Turn 循环
    await session.withTurnLock(async () => {
      assertActive(ctx);
      if (userPrompt !== undefined) {
        session.append({ role: "user", content: userPrompt });
      }
      console.log(
        `[Engine] 唤醒会话 [${session.id}]，锁定工作区: ${session.workDir} (PlanMode=${this.planMode}, Thinking=${this.enableThinking})`,
      );

      // 根据当前 Session 绑定的物理工作区和 planMode 开关动态创建 PromptComposer
      const composer = new PromptComposer(session.workDir, this.planMode);

      // 每次 run 启动时重置死循环检测计数器
      this.reminder.reset();

      // 防止模型在 TODO.md 尚未全部打勾时中途偷懒退出的最大督促次数
      let todoRemindCount = 0;
      const maxTodoReminders = 3;

      for (let turn = 0; turn < maxTurns; turn++) {
        assertActive(ctx);
        const availableTools = this.registry.getAvailableTools();

        // System Prompt 永远置顶，且每轮重新 build() 以同步磁盘上最新的 TODO.md 状态
        const systemMessage = composer.build();

        // Phase 1: 慢思考阶段 (Thinking) - 剥夺工具，强制规划
        if (this.enableThinking) {
          const workingMemory = session.getWorkingMemory(this.workingMemoryLimit);
          const planningInstruction: Message = {
            role: "user",
            content: buildPlanningInstruction(availableTools, this.planMode),
          };
          const thinkContext = this.compactor.compact([
            systemMessage,
            ...workingMemory,
            planningInstruction,
          ]);
          let thinkResp: Message;
          try {
            thinkResp = await this.provider.generate(ctx, thinkContext, []);
          } catch (error) {
            assertActive(ctx);
            throw new Error("规划阶段生成失败", { cause: error });
          }
          assertActive(ctx);

          if (thinkResp.content || thinkResp.reasoningContent) {
            console.log(`\n🧠 [思考规划]:\n${thinkResp.content}\n`);
            session.append({
              role: "assistant",
              content: thinkResp.content,
              ...(thinkResp.reasoningContent
                ? { reasoningContent: thinkResp.reasoningContent }
                : {}),
            });
          }
        }

        // Phase 2: 行动阶段 (Action) - 从 Session 提取短期工作记忆 (Working Memory)
        const actionWorkingMemory = session.getWorkingMemory(this.workingMemoryLimit);

        // 在发起大模型推理前，调用 Compactor 对上下文进行压缩（远期 Full Masking + 近期 Head-Tail Truncation）
        const actionContext = this.compactor.compact([systemMessage, ...actionWorkingMemory]);

        let actionResp: Message;
        try {
          actionResp = await this.provider.generate(
            ctx,
            actionContext,
            availableTools,
            options.onTextDelta ? { onTextDelta: options.onTextDelta } : undefined,
          );
        } catch (error) {
          assertActive(ctx);
          throw new Error("行动阶段生成失败", { cause: error });
        }
        assertActive(ctx);

        const ids = actionResp.toolCalls?.map((call) => call.id) ?? [];
        if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
          throw new Error("模型返回的工具调用标识为空或重复，已停止执行");
        }

        session.append(actionResp);

        if (!options.onTextDelta) {
          console.log(`\n🤖 Agent 回复:\n\n${actionResp.content || ""}`);
        } else if (actionResp.content) {
          process.stdout.write("\n");
        }

        const toolCalls = actionResp.toolCalls;
        if (!toolCalls || toolCalls.length === 0) {
          // 【Plan Mode 防半途而废守卫】：如果开启了 planMode，且工作区 TODO.md 中仍有未勾选的 `- [ ]`，
          // 自动督促模型继续完成或更新 TODO.md，而不是直接退出循环烂尾！
          if (
            this.planMode &&
            todoRemindCount < maxTodoReminders &&
            this.hasUnfinishedTodos(session.workDir)
          ) {
            todoRemindCount++;
            console.log(
              `\n[Engine][PlanMode 守卫] ⚠️ 检测到 TODO.md 仍有未完成项 (- [ ])，触发第 ${todoRemindCount}/${maxTodoReminders} 次自动督促...`,
            );
            session.append({
              // 内部守卫指令不构成新的用户任务，避免工作记忆从提醒处切断原始要求。
              role: "system",
              content:
                "[系统守卫提醒] 检测到工作区 TODO.md 中仍然存在未完成的 `- [ ]` 任务项。请继续调用工具完成剩余步骤，并在每完成一步后使用 edit_file 将对应的 `- [ ]` 更新为 `- [x]`，直到全部完成！",
            });
            continue;
          }
          if (this.planMode && this.hasUnfinishedTodos(session.workDir)) {
            throw new Error("任务清单仍有未完成项，已达到提醒上限，请检查阻塞原因后继续");
          }
          return;
        }

        const outcomes = await Promise.all(
          toolCalls.map((toolCall) => this.executeAndObserve(ctx, toolCall)),
        );

        // 1. 先将所有带 toolCallId 的工具观察结果追加进 Session（满足大模型 API 要求每个 toolCall 必须紧跟 toolResult 的协议约束）
        session.append(...outcomes.map((o) => o.observation));

        // 2. 运行 Reminder 死循环检测：若连续失败达到阈值，在所有 toolResult 之后追加一条高权重的 Role.User 元认知警告消息
        for (let i = 0; i < toolCalls.length; i++) {
          const call = toolCalls[i]!;
          const outcome = outcomes[i]!;
          const warningMsg = this.reminder.analyzeAndRemind(call, outcome.rawResult);
          if (warningMsg) {
            session.append(warningMsg);
          }
        }

        assertActive(ctx);
      }
      throw new Error(`任务已达到最大执行轮数（${maxTurns}），请检查执行记录后继续`);
    });
  }

  /**
   * 检查工作区下的 TODO.md 是否还存在未完成的 `- [ ]` 任务项
   */
  private hasUnfinishedTodos(workDir: string): boolean {
    const todoPath = path.join(workDir, "TODO.md");
    if (!existsSync(todoPath)) {
      return false;
    }
    try {
      const content = readFileSync(todoPath, "utf8");
      return /^\s*-\s*\[\s\]\s+/m.test(content);
    } catch {
      return false;
    }
  }

  private async executeAndObserve(ctx: Context, toolCall: ToolCall): Promise<ExecutionOutcome> {
    console.log(`\n[🛠️ 调用工具] ${toolCall.name}`);
    console.log(`   参数: ${toolCall.arguments}`);
    let result: ToolResult;
    try {
      result = ctx.signal.aborted
        ? { toolCallId: toolCall.id, output: "任务已取消，未启动此工具", isError: true }
        : await this.registry.executeTool(ctx, toolCall);
    } catch (error) {
      result = {
        toolCallId: toolCall.id,
        output: `工具执行失败：${error instanceof Error ? error.message : "未知错误"}`,
        isError: true,
      };
    }
    if (result.isError) {
      const enhancedError = this.recovery.analyzeAndInject(toolCall.name, result.output);
      console.log(`[❌ 执行失败] ${toolCall.name}`);
      console.log(`   错误: ${enhancedError}`);
      return {
        observation: { role: "user", content: enhancedError, toolCallId: toolCall.id },
        rawResult: result,
      };
    }
    console.log(`[✅ 执行成功] ${toolCall.name}`);
    return {
      observation: { role: "user", content: result.output, toolCallId: toolCall.id },
      rawResult: result,
    };
  }
}

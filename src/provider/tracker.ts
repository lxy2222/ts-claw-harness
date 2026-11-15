import type { Session } from "../engine/session";
import type { Context } from "../types/context";
import type { Message, ToolDefinition } from "../types/message";
import type { GenerateOptions, LLMProvider } from "./index";

/**
 * 模型单价配置（单位：元 / 百万 Tokens，即 RMB per 1M tokens）
 */
export interface ModelPricing {
  /** 输入提示词价格（元 / 1M Tokens） */
  inputPricePerMillion: number;
  /** 模型输出价格（元 / 1M Tokens） */
  outputPricePerMillion: number;
}

/**
 * 主流模型官方参考报价表（单位：元 / 1M Tokens）
 *
 * DeepSeek 官方 API 标准定价（deepseek-chat / DeepSeek-V3.2）：
 * - 输入（缓存未命中）：2.0 元 / 百万 Tokens（缓存命中 0.2 元 / 百万 Tokens，此处按标准输入计）
 * - 输出：8.0 元 / 百万 Tokens（注：早期 V3 优惠期为 输入 1~2 元 / 输出 2~8 元，也支持自定义传入）
 */
export const DEFAULT_MODEL_PRICING: Record<string, ModelPricing> = {
  "deepseek-chat": { inputPricePerMillion: 2.0, outputPricePerMillion: 8.0 },
  "deepseek-flash": { inputPricePerMillion: 1.0, outputPricePerMillion: 2.0 },
  "deepseek-reasoner": { inputPricePerMillion: 4.0, outputPricePerMillion: 16.0 },
  default: { inputPricePerMillion: 1.0, outputPricePerMillion: 2.0 },
};

/**
 * CostTracker (或 ProviderTracker) —— LLMProvider 的可观测性装饰器 (Decorator Pattern)
 *
 * 为什么要做成 LLMProvider 的装饰器？
 * 1. 对 Engine 完全透明：CostTracker 同样实现了 LLMProvider 接口，Engine 照常调用 provider.generate(...)，
 *    不需要知道底层是裸的 OpenAIProvider 还是包了一层计费监控的 Tracker；
 * 2. 职责单一：OpenAIProvider 只管发 HTTP 请求和解析协议，Tracker 专门负责掐表计时 (Duration)、
 *    统计 Prompt/Completion Tokens、按模型单价计算 Input/Output Cost，并同步累加到当前 Session 中。
 */
export class CostTracker implements LLMProvider {
  private readonly pricing: ModelPricing;
  private activeSession?: Session;

  public totalCalls = 0;
  public totalPromptTokens = 0;
  public totalCompletionTokens = 0;
  public totalInputCost = 0;
  public totalOutputCost = 0;
  public totalDurationMs = 0;

  constructor(
    private readonly inner: LLMProvider,
    private readonly modelName: string = "deepseek-flash",
    customPricing?: ModelPricing,
    session?: Session,
  ) {
    this.pricing =
      customPricing ??
      DEFAULT_MODEL_PRICING[modelName] ??
      DEFAULT_MODEL_PRICING.default!;
    this.activeSession = session;
  }

  /**
   * 绑定当前活跃的 Session，使每次调用产生的 Token 与费用自动归集到该 Session 的统计字段中
   */
  bindSession(session: Session): void {
    this.activeSession = session;
  }

  async generate(
    ctx: Context,
    messages: Message[],
    tools?: ToolDefinition[],
    options?: GenerateOptions,
  ): Promise<Message> {
    const startTime = performance.now();

    const response = await this.inner.generate(ctx, messages, tools, options);

    const durationMs = Math.round(performance.now() - startTime);
    const promptTokens = response.usage?.promptTokens ?? 0;
    const completionTokens = response.usage?.completionTokens ?? 0;

    // 费用计算公式：Token 数量 / 1,000,000 * 每百万 Token 单价
    const inputCost = (promptTokens / 1_000_000) * this.pricing.inputPricePerMillion;
    const outputCost = (completionTokens / 1_000_000) * this.pricing.outputPricePerMillion;
    const callTotalCost = inputCost + outputCost;

    // 1. 累加到 Tracker 自身统计
    this.totalCalls++;
    this.totalPromptTokens += promptTokens;
    this.totalCompletionTokens += completionTokens;
    this.totalInputCost += inputCost;
    this.totalOutputCost += outputCost;
    this.totalDurationMs += durationMs;

    // 2. 同步累加到绑定的 Session 数据结构中
    if (this.activeSession) {
      this.activeSession.recordMetrics(
        promptTokens,
        completionTokens,
        inputCost,
        outputCost,
        durationMs,
      );
    }

    console.log(
      `\n📊 [Tracker | ${this.modelName}] 耗时: ${(durationMs / 1000).toFixed(2)}s | ` +
        `Tokens: 输入=${promptTokens}, 输出=${completionTokens}, 合计=${promptTokens + completionTokens} | ` +
        `本轮费用: ¥${callTotalCost.toFixed(6)} (输入: ¥${inputCost.toFixed(6)}, 输出: ¥${outputCost.toFixed(6)})`,
    );

    return response;
  }

  /**
   * 打印当前绑定的 Session（或 Tracker 全局）的总账单与耗时汇总报告
   */
  printSummary(): void {
    if (this.activeSession) {
      const metrics = this.activeSession.getMetricsSummary();
      const wallClockMs = Date.now() - this.activeSession.createdAt.getTime();
      console.log("\n==========================================");
      console.log(
        `📈 [Session (${this.activeSession.id}) 可观测性统计账单 | 模型: ${this.modelName}]`,
      );
      console.log(
        `   ⏱️  推理调用次数 : ${this.totalCalls} 次 | 累计模型推理耗时: ${(metrics.totalDurationMs / 1000).toFixed(2)}s (会话总历时: ${(wallClockMs / 1000).toFixed(2)}s)`,
      );
      console.log(
        `   🔢 累计消耗 Tokens: ${metrics.totalTokens} Tokens (输入 Prompt: ${metrics.totalPromptTokens}, 输出 Completion: ${metrics.totalCompletionTokens})`,
      );
      console.log(
        `   💰 累计产生费用   : ¥${metrics.totalCost.toFixed(6)} (输入费用: ¥${metrics.totalInputCost.toFixed(6)}, 输出费用: ¥${metrics.totalOutputCost.toFixed(6)})`,
      );
      console.log("==========================================\n");
      return;
    }

    const totalTokens = this.totalPromptTokens + this.totalCompletionTokens;
    const totalCost = this.totalInputCost + this.totalOutputCost;
    console.log("\n==========================================");
    console.log(`💰 [可观测性总账单 | 模型: ${this.modelName}]`);
    console.log(
      `   单价配置: 输入 ¥${this.pricing.inputPricePerMillion}/1M Tokens, 输出 ¥${this.pricing.outputPricePerMillion}/1M Tokens`,
    );
    console.log(
      `   调用次数: ${this.totalCalls} 次 | 累计模型推理耗时: ${(this.totalDurationMs / 1000).toFixed(2)}s`,
    );
    console.log(
      `   累计 Tokens: ${totalTokens} (输入 Prompt: ${this.totalPromptTokens}, 输出 Completion: ${this.totalCompletionTokens})`,
    );
    console.log(
      `   累计总费用: ¥${totalCost.toFixed(6)} (输入费用: ¥${this.totalInputCost.toFixed(6)}, 输出费用: ¥${this.totalOutputCost.toFixed(6)})`,
    );
    console.log("==========================================\n");
  }
}

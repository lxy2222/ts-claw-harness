// 大模型接口抽象(Provider)与各厂商 SDK 实现。
import type { Context } from "../types/context";
import type { Message, ToolDefinition } from "../types/message";

/** 单次生成的输出选项;不传回调时保留普通响应模式。 */
export interface GenerateOptions {
  /** 仅推送可展示的正文增量,不包含厂商内部推理内容。 */
  onTextDelta?: (text: string) => void;
}

/** 与大模型通信的统一契约 */
export interface LLMProvider {
  /** 接收上下文历史与可用工具列表,发起一次大模型推理 */
  generate(
    ctx: Context,
    messages: Message[],
    tools?: ToolDefinition[],
    options?: GenerateOptions,
  ): Promise<Message>;
}

export { CostTracker, DEFAULT_MODEL_PRICING, type ModelPricing } from "./tracker";

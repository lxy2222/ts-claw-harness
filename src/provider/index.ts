// 大模型接口抽象(Provider)与各厂商 SDK 实现。
import type { Context } from "../types/context";
import type { Message, ToolDefinition } from "../types/message";

/** 与大模型通信的统一契约 */
export interface LLMProvider {
  /** 接收上下文历史与可用工具列表,发起一次大模型推理 */
  generate(ctx: Context, messages: Message[], tools?: ToolDefinition[]): Promise<Message>;
}

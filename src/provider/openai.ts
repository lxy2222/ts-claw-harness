// OpenAI-compatible provider:适用于 OpenAI、DeepSeek 等兼容 Chat Completions 协议的厂商。
import OpenAI from "openai";
import type {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import type { Context } from "../types/context";
import { Role, type Message, type ToolCall, type ToolDefinition } from "../types/message";
import type { LLMProvider } from "./index";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-flash";

export interface OpenAIProviderOptions {
  apiKey: string;
  /** 默认 DeepSeek;接 OpenAI 时传 https://api.openai.com/v1 */
  baseURL?: string;
  model?: string;
}

export class OpenAIProvider implements LLMProvider {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(options: OpenAIProviderOptions) {
    if (!options.apiKey) {
      throw new Error("OpenAI-compatible API key is required");
    }

    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL ?? DEEPSEEK_BASE_URL,
    });
    this.model = options.model ?? DEEPSEEK_DEFAULT_MODEL;
  }

  /** 从环境变量读取配置:LLM_API_KEY(必填)、LLM_BASE_URL、LLM_MODEL */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): OpenAIProvider {
    const apiKey = env.LLM_API_KEY;
    if (!apiKey) {
      throw new Error("环境变量 LLM_API_KEY 未设置");
    }
    return new OpenAIProvider({
      apiKey,
      baseURL: env.LLM_BASE_URL || undefined,
      model: env.LLM_MODEL || undefined,
    });
  }

  async generate(ctx: Context, messages: Message[], tools: ToolDefinition[] = []): Promise<Message> {
    // 如果包含大量工具必须把工具放入大模型的思考链当中
    const openaiTools = this.toOpenAITools(tools);

    try {
      const response = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: this.toOpenAIMessages(messages),
          // 空数组会被部分厂商拒绝,Thinking 阶段直接不传 tools
          ...(openaiTools.length > 0 ? { tools: openaiTools } : {}),
        },
        {
          signal: ctx.signal,
          ...(ctx.requestId ? { headers: { "x-request-id": ctx.requestId } } : {}),
        },
      );

      const choice = response.choices[0];
      if (!choice) {
        throw new Error("API returned empty choices");
      }
      return this.fromOpenAIMessage(choice.message);
    } catch (error) {
      if (ctx.signal.aborted) {
        throw new Error(`LLM request aborted${ctx.requestId ? `: ${ctx.requestId}` : ""}`, {
          cause: error,
        });
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`OpenAI-compatible API request failed: ${reason}`, { cause: error });
    }
  }

  private toOpenAIMessages(messages: Message[]): ChatCompletionMessageParam[] {
    return messages.map((message): ChatCompletionMessageParam => {
      switch (message.role) {
        case Role.System:
          return { role: "system", content: message.content };

        case Role.User:
          // 内部沿用 Go 的设计:工具结果是带 toolCallId 的 user 消息,发给 OpenAI 时要转成 role: "tool"
          if (message.toolCallId) {
            return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
          }
          return { role: "user", content: message.content };

        case Role.Assistant:
          return {
            role: "assistant",
            content: message.content || null,
            // DeepSeek 扩展字段,SDK 类型中没有;思考模式下缺失会返回 400
            ...(message.reasoningContent ? { reasoning_content: message.reasoningContent } : {}),
            ...(message.toolCalls?.length
              ? {
                  tool_calls: message.toolCalls.map((toolCall) => ({
                    id: toolCall.id,
                    type: "function" as const,
                    function: { name: toolCall.name, arguments: toolCall.arguments },
                  })),
                }
              : {}),
          };
      }
    });
  }

  private toOpenAITools(tools: ToolDefinition[]): ChatCompletionTool[] {
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as Record<string, unknown>,
      },
    }));
  }

  private fromOpenAIMessage(message: ChatCompletionMessage): Message {
    const toolCalls: ToolCall[] =
      message.tool_calls
        ?.filter((toolCall) => toolCall.type === "function")
        .map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        })) ?? [];

    const { reasoning_content: reasoningContent } = message as ChatCompletionMessage & {
      reasoning_content?: string | null;
    };

    return {
      role: Role.Assistant,
      content: message.content ?? "",
      ...(reasoningContent ? { reasoningContent } : {}),
      toolCalls,
    };
  }
}

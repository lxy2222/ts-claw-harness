// OpenAI-compatible provider:适用于 OpenAI、DeepSeek 等兼容 Chat Completions 协议的厂商。
import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import type { Context } from "../types/context";
import { Role, type Message, type ToolCall, type ToolDefinition } from "../types/message";
import type { GenerateOptions, LLMProvider } from "./index";

/** 已转换为中文的响应校验错误,保留具体原因供调用方展示。 */
class ProviderResponseError extends Error {}

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
      throw new Error("模型服务 API 密钥不能为空");
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

  async generate(
    ctx: Context,
    messages: Message[],
    tools: ToolDefinition[] = [],
    options: GenerateOptions = {},
  ): Promise<Message> {
    if (ctx.signal.aborted) {
      throw this.abortedError(ctx);
    }
    // 如果包含大量工具必须把工具放入大模型的思考链当中
    const openaiTools = this.toOpenAITools(tools);
    const body = {
      model: this.model,
      messages: this.toOpenAIMessages(messages),
      // 空数组会被部分厂商拒绝,Thinking 阶段直接不传 tools
      ...(openaiTools.length > 0 ? { tools: openaiTools } : {}),
    };
    const requestOptions = {
      signal: ctx.signal,
      ...(ctx.requestId ? { headers: { "x-request-id": ctx.requestId } } : {}),
    };

    try {
      if (options.onTextDelta) {
        const stream = await this.client.chat.completions.create(
          { ...body, stream: true },
          requestOptions,
        );
        return await this.fromOpenAIStream(stream, options.onTextDelta, ctx);
      }

      const response = await this.client.chat.completions.create(
        body,
        requestOptions,
      );

      const choice = response.choices[0];
      if (!choice) {
        throw new ProviderResponseError("模型服务未返回任何候选结果");
      }
      this.validateFinishReason(choice.finish_reason);
      return this.fromOpenAIMessage(choice.message);
    } catch (error) {
      if (ctx.signal.aborted) {
        throw this.abortedError(ctx, error);
      }
      if (error instanceof ProviderResponseError) throw error;
      if (error instanceof OpenAI.APIConnectionTimeoutError) {
        throw new Error("模型服务请求超时，请稍后重试", { cause: error });
      }
      if (error instanceof OpenAI.APIConnectionError) {
        throw new Error("模型服务连接失败，请检查网络和服务地址", { cause: error });
      }
      if (error instanceof OpenAI.APIError && error.status) {
        throw new Error(`模型服务请求失败（HTTP ${error.status}）`, { cause: error });
      }
      throw new Error("模型服务请求失败，请检查服务状态或响应格式", { cause: error });
    }
  }

  private abortedError(ctx: Context, cause?: unknown): Error {
    return new Error(`模型请求已取消${ctx.requestId ? `：${ctx.requestId}` : ""}`, { cause });
  }

  private validateFinishReason(reason: string | null | undefined): void {
    if (!reason) {
      throw new ProviderResponseError("模型响应意外中断，未收到完成标记，已停止处理工具调用");
    }
    if (reason === "length") {
      throw new ProviderResponseError("模型输出已达到长度上限，响应不完整，已停止处理工具调用");
    }
    if (reason === "content_filter") {
      throw new ProviderResponseError("模型响应被内容过滤规则中止，已停止处理工具调用");
    }
    if (reason !== "stop" && reason !== "tool_calls") {
      throw new ProviderResponseError("模型返回了不支持的结束状态，已停止处理工具调用");
    }
  }

  private async fromOpenAIStream(
    stream: AsyncIterable<ChatCompletionChunk>,
    onTextDelta: (text: string) => void,
    ctx: Context,
  ): Promise<Message> {
    let content = "";
    let reasoningContent = "";
    let finishReason: string | null = null;
    const toolCalls = new Map<number, ToolCall>();

    for await (const chunk of stream) {
      if (ctx.signal.aborted) throw this.abortedError(ctx);
      const choice = chunk.choices.find((item) => item.index === 0);
      // 厂商可能在完成标记后额外发送 usage chunk,其中没有 choices。
      if (!choice) continue;

      const delta = choice.delta as ChatCompletionChunk.Choice.Delta & {
        reasoning_content?: string | null;
      };
      if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
      if (delta.content) {
        content += delta.content;
        onTextDelta(delta.content);
      }
      for (const toolDelta of delta.tool_calls ?? []) {
        if (!Number.isInteger(toolDelta.index) || toolDelta.index < 0) {
          throw new ProviderResponseError("模型返回的工具调用索引无效，已停止处理工具调用");
        }
        const toolCall = toolCalls.get(toolDelta.index) ?? { id: "", name: "", arguments: "" };
        toolCall.id += toolDelta.id ?? "";
        toolCall.name += toolDelta.function?.name ?? "";
        toolCall.arguments += toolDelta.function?.arguments ?? "";
        toolCalls.set(toolDelta.index, toolCall);
      }
      if (choice.finish_reason) {
        this.validateFinishReason(choice.finish_reason);
        finishReason = choice.finish_reason;
      }
    }

    if (ctx.signal.aborted) throw this.abortedError(ctx);
    // 连接关闭或 [DONE] 都不足以证明响应完整,必须收到显式完成标记。
    this.validateFinishReason(finishReason);
    const completedTools = [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, toolCall]) => toolCall);
    for (const toolCall of completedTools) {
      if (!toolCall.id || !toolCall.name) {
        throw new ProviderResponseError("模型返回的工具调用缺少标识或名称，已停止处理工具调用");
      }
      try {
        JSON.parse(toolCall.arguments);
      } catch (error) {
        throw new ProviderResponseError("模型返回的工具参数不是完整的 JSON，已停止处理工具调用", {
          cause: error,
        });
      }
    }
    return {
      role: Role.Assistant,
      content,
      ...(reasoningContent ? { reasoningContent } : {}),
      toolCalls: completedTools,
    };
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

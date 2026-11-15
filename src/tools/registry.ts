import type { Context } from "../types/context";
import type { ToolCall, ToolDefinition, ToolResult } from "../types/message";
import type { ToolMiddleware } from "./middleware/approval";

// base tool registry
export interface baseTool {
  name: string;
  description: string;
  /** 参数的 JSON Schema;缺失时模型不知道该传哪些参数 */
  inputSchema?: unknown;
  execute: (ctx: Context, args: any) => Promise<string>;
}

export interface ToolRegistry {
  registerTool(tool: baseTool): void;
  /** 注册工具执行前置中间件（支持挂载多个，按注册顺序依次拦截检查） */
  use(middleware: ToolMiddleware): void;
  getAvailableTools(): ToolDefinition[];
  executeTool(ctx: Context, toolCall: ToolCall): Promise<ToolResult>;
}

export class RegistryImpl implements ToolRegistry {
  private tools: Map<string, baseTool> = new Map();
  private middlewares: ToolMiddleware[] = [];

  registerTool(tool: baseTool): void {
    if (this.tools.has(tool.name)) {
      console.log(`[Registry] 覆盖已存在的工具: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    console.log(`[Registry] 成功挂载工具: ${tool.name}`);
  }

  /**
   * 挂载中间件（在工具注册之后、execute 之前按顺序遍历执行）
   */
  use(middleware: ToolMiddleware): void {
    this.middlewares.push(middleware);
    console.log(`[Registry] 成功挂载中间件: ${middleware.constructor.name}`);
  }

  getAvailableTools(): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    this.tools.forEach((tool) => {
      defs.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    });
    return defs;
  }

  async executeTool(ctx: Context, toolCall: ToolCall): Promise<ToolResult> {
    const failure = (output: string): ToolResult => ({
      toolCallId: toolCall.id,
      output,
      isError: true,
    });
    if (ctx.signal.aborted) {
      return failure("工具执行已取消");
    }
    const tool = this.tools.get(toolCall.name);
    if (!tool) {
      return failure(`未找到工具：${toolCall.name}`);
    }
    let args: unknown;
    try {
      args = JSON.parse(toolCall.arguments);
    } catch {
      return failure(`工具 ${toolCall.name} 的参数不是有效的 JSON`);
    }

    // 【核心拦截管线】：在调用 tool.execute 之前，依次遍历所有已注册的 middleware。
    // 如果任何一个 middleware 抛错（例如用户拒绝审批），立即中止执行并返回拦截错误结果。
    try {
      for (const mw of this.middlewares) {
        if (ctx.signal.aborted) {
          return failure("工具执行已取消");
        }
        await mw.beforeExecute(ctx, toolCall, args);
      }
    } catch (error) {
      if (ctx.signal.aborted) return failure("工具执行已取消");
      const detail = error instanceof Error ? error.message : String(error);
      return failure(`工具 ${toolCall.name} 被中间件拦截：${detail}`);
    }

    try {
      const result = await tool.execute(ctx, args);
      return {
        toolCallId: toolCall.id,
        output: result,
        isError: false,
      };
    } catch (error) {
      if (ctx.signal.aborted) return failure("工具执行已取消");
      const detail = error instanceof Error ? error.message : String(error);
      return failure(`工具 ${toolCall.name} 执行失败：${detail}`);
    }
  }
}

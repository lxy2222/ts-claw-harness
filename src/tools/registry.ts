import type { Context } from "../types/context";
import type { ToolDefinition, ToolCall, ToolResult } from "../types/message";
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
  getAvailableTools(): ToolDefinition[];
  executeTool(ctx: Context, toolCall: ToolCall): Promise<ToolResult>;
}

export class RegistryImpl implements ToolRegistry {
  private tools: Map<string, baseTool> = new Map();
  registerTool(tool: baseTool): void {
    if (this.tools.has(tool.name)) {
      console.log(`[Registry] 覆盖已存在的工具: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    console.log(`[Registry] 成功挂载工具: ${tool.name}`);
  }

  getAvailableTools(): ToolDefinition[] {
    let defs: ToolDefinition[] = [];
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

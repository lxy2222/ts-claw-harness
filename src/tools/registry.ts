import type { Context } from "../types/context";
import type { 
  ToolDefinition,
  ToolCall,
  ToolResult,
} from "../types/message";
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
      console.log(`${tool.name} already registered, it will be covered`);
    }
    this.tools.set(tool.name, tool)
    console.log(`${tool.name} registered successfully`);
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
    const tool = this.tools.get(toolCall.name);
    if (!tool) {
      // 告诉大模型不存在
      let errMsg = `There is no tool called ${toolCall.name}`
      return {
        toolCallId: toolCall.id,
        output: errMsg,
        isError: true,
      }
    }
    try {
      let result = await tool.execute(ctx, JSON.parse(toolCall.arguments));
      return {
        toolCallId: toolCall.id,
        output: result,
        isError: false,
      }
    } catch (e) {
      let errMsg = `Tool ${toolCall.name} execution failed: ${e}`
      return {
        toolCallId: toolCall.id,
        output: errMsg,
        isError: true,
      }
    }
    
  }
}
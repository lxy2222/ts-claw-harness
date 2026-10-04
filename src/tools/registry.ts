import type { Context } from "../types/context";
import type { 
  ToolDefinition,
  ToolCall,
  ToolResult,
} from "../types/message";
export interface ToolRegistry {
  getAvailableTools(): ToolDefinition[];
  executeTool(ctx: Context, toolCall: ToolCall): Promise<ToolResult>;
}
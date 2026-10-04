/**
 * 与大模型沟通的消息类型,对应 go-tiny-claw 的 schema 包。
 */

/** 消息角色:Agent 的性格与红线 / 用户输入与工具结果 / 模型输出 */
export type Role = "system" | "user" | "assistant";

export const Role = {
  /** 系统提示词:确立 Agent 的性格与红线 */
  System: "system",
  /** 用户输入 / 工具执行的返回结果 (Observation) */
  User: "user",
  /** 模型的输出:包含推理 (Reasoning) 或工具调用 (ToolCall) */
  Assistant: "assistant",
} as const satisfies Record<string, Role>;

/** 上下文中传递的单条消息 */
export interface Message {
  role: Role;
  /** 纯文本内容 */
  content: string;
  /** 思考模式模型(如 DeepSeek)返回的推理过程,后续请求必须原样回传 */
  reasoningContent?: string;
  /** 模型决定调用工具时填充,支持并行调用多个工具 */
  toolCalls?: ToolCall[];
  /** 对某个工具调用的响应时必填,告知模型上下文的关联性 */
  toolCallId?: string;
}

/** 模型请求调用某个具体的工具 */
export interface ToolCall {
  /** 工具调用的唯一 ID */
  id: string;
  /** 想要调用的工具名称 (例如 "bash") */
  name: string;
  arguments: string;
}

/** 工具在本地执行完毕后返回的物理结果 */
export interface ToolResult {
  toolCallId: string;
  /** 工具执行的控制台输出或报错堆栈 */
  output: string;
  /** 标记是否失败,供后续的驾驭工程进行错误自愈 */
  isError: boolean;
}

/** 描述一个大模型可以调用的工具元信息 (供模型理解工具有什么用) */
export interface ToolDefinition {
  name: string;
  description: string;
  /** 对应 JSON Schema */
  inputSchema: unknown;
}

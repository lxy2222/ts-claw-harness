import type { AgentEngine } from "../engine/loop";
import type { Context } from "../types/context";
import type { baseTool, ToolRegistry } from "./registry";

/**
 * SubAgentTool (子智能体委派工具 / 侦察兵)
 *
 * 核心设计原则：
 * 1. 工具即智能体 (Agent-as-a-Tool)：对主 Agent 来说，它只是一个名叫 delegate_subagent（或自定义名称）的普通工具；
 * 2. 权限最小化 (Least Privilege)：SubAgent 仅持有受限的 readOnlyRegistry（如 read_file、bash），没有 write_file / edit_file 权限，
 *    因此多个 SubAgent 可以安全地并行运行而不会产生文件写冲突；
 * 3. 上下文物理隔离 (Context Isolation)：SubAgent 在 Engine.runSubAgent() 的独立内存栈中完成十几次翻箱倒柜的试错，
 *    最终只将浓缩后的最后一条总结汇报返回给主 Agent，保持主 Agent 上下文窗口绝对干净！
 */
export class SubAgentTool implements baseTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema = {
    type: "object",
    properties: {
      task_directive: {
        type: "string",
        description:
          "下发给子智能体的具体专项任务指令（请清晰描述要查找或分析的目标，子智能体会独立探索并返回最终结论）",
      },
    },
    required: ["task_directive"],
  };

  constructor(
    private readonly engine: AgentEngine,
    private readonly subRegistry: ToolRegistry,
    name: string = "delegate_subagent",
    description: string = "委派一个拥有独立上下文和只读权限的子智能体（Sub-Agent）去执行信息检索、目录探索或代码分析任务。支持并发委派多个子任务。",
  ) {
    this.name = name;
    this.description = description;
  }

  async execute(ctx: Context, args: unknown): Promise<string> {
    const directive = (args as { task_directive?: unknown } | null)?.task_directive;
    if (typeof directive !== "string" || directive.trim() === "") {
      throw new Error("参数 task_directive 必须是非空字符串");
    }

    const cleanDirective = directive.trim();
    console.log(`\n[SubAgentTool:${this.name}] 🚀 启动子智能体，委派任务: "${cleanDirective}"`);

    try {
      // 拉起完全物理隔离的子循环，传入专项指令和受限的只读工具注册表
      const summary = await this.engine.runSubAgent(ctx, cleanDirective, this.subRegistry);
      console.log(
        `\n[SubAgentTool:${this.name}] 📋 子智能体执行完毕，返回 Summary:\n${summary}\n`,
      );
      return `[子智能体 (${this.name}) 汇报结果]:\n${summary}`;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`\n[SubAgentTool:${this.name}] ❌ 子智能体执行失败: ${reason}\n`);
      throw new Error(`子智能体 (${this.name}) 执行失败: ${reason}`, { cause: error });
    }
  }
}

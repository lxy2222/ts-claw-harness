import type { ApprovalChannel } from "../../types/approval";
import type { Context } from "../../types/context";
import type { ToolCall } from "../../types/message";
import { CliApprovalChannel } from "../../cli/approval";

/**
 * 工具执行前置中间件契约 (Tool Middleware)
 * 注册在 ToolRegistry 中：在工具注册之后、物理 tool.execute() 执行之前依次运行。
 */
export interface ToolMiddleware {
  /**
   * 在工具执行前进行拦截检查。
   * - 如果放行，正常 resolve 返回；
   * - 如果被拦截（例如用户拒绝审批），抛出 Error，Registry 会立即中止工具执行并将错误包装返回给大模型。
   */
  beforeExecute(ctx: Context, toolCall: ToolCall, args: unknown): Promise<void>;
}

export interface DangerRule {
  reason: string;
  pattern: RegExp;
}

/**
 * 默认高危操作特征规则库
 */
export const DEFAULT_DANGER_RULES: DangerRule[] = [
  { reason: "级联删除 (rm -r / rm -rf)", pattern: /rm\s+-[a-zA-Z]*r/i },
  { reason: "提权操作 (sudo)", pattern: /sudo\s+/i },
  { reason: "数据库删除 (DROP)", pattern: /drop\s+/i },
  { reason: "重定向覆盖源代码 (> *.go / *.ts / *.js)", pattern: />.*\.(go|ts|js|mjs|json)\b/i },
];

/**
 * ApprovalGate (审批挂起器)
 * 当中间件命中高危规则时，调用 gate.waitForApproval(...) 会挂起当前 Session 的执行流，
 * 直到人类在 TUI 终端（或外部审批通道）输入确认结果后才恢复返回。
 */
export class ApprovalGate {
  private readonly channel: ApprovalChannel;

  constructor(channel?: ApprovalChannel) {
    this.channel = channel ?? new CliApprovalChannel();
  }

  /**
   * 挂起当前工具调用，等待用户确认是否放行
   */
  async waitForApproval(
    ctx: Context,
    toolName: string,
    reason: string,
    detail: string,
  ): Promise<boolean> {
    if (ctx.signal.aborted) {
      throw new Error("任务已被用户取消");
    }
    console.log(
      `\n⏸️  [ApprovalGate] 检测到高危调用 (${reason})，当前 Session 已挂起，等待人类审批...`,
    );
    const approved = await this.channel.ask({
      toolName,
      reason,
      detail,
    });
    if (ctx.signal.aborted) {
      throw new Error("任务已被用户取消");
    }
    return approved;
  }
}

/**
 * ApprovalMiddleware (安全审批中间件)
 * 挂载在 ToolRegistry 上，对所有即将执行的工具调用进行安全扫描。
 */
export class ApprovalMiddleware implements ToolMiddleware {
  private readonly gate: ApprovalGate;
  private readonly rules: DangerRule[];

  constructor(channelOrGate?: ApprovalChannel | ApprovalGate, customRules?: DangerRule[]) {
    this.gate =
      channelOrGate instanceof ApprovalGate
        ? channelOrGate
        : new ApprovalGate(channelOrGate);
    this.rules = customRules ?? DEFAULT_DANGER_RULES;
  }

  async beforeExecute(ctx: Context, toolCall: ToolCall, args: unknown): Promise<void> {
    const matched = this.inspectDanger(toolCall, args);
    if (!matched) {
      return;
    }

    // 命中高危规则：挂起当前 Session，通过 TUI 向用户发起确认
    const approved = await this.gate.waitForApproval(
      ctx,
      toolCall.name,
      matched.reason,
      matched.detail,
    );

    if (!approved) {
      console.log(`🛑 [ApprovalMiddleware] 用户拒绝了高危操作: ${matched.detail}`);
      throw new Error(
        `[安全审批拦截] 用户明确拒绝了你调用 '${toolCall.name}' 执行高危操作（原因: ${matched.reason}，内容: ${matched.detail}）。请立即放弃该危险操作，严禁尝试绕过审批，直接向用户说明情况或改用安全方案！`,
      );
    }

    console.log(`✅ [ApprovalMiddleware] 用户已批准高危操作，恢复 Session 继续执行...`);
  }

  /**
   * 检查工具调用参数是否命中危险规则
   */
  private inspectDanger(
    toolCall: ToolCall,
    args: unknown,
  ): { reason: string; detail: string } | null {
    // 1. 针对 bash 工具：扫描 command 字符串
    if (toolCall.name === "bash") {
      const command =
        typeof (args as { command?: unknown } | null)?.command === "string"
          ? (args as { command: string }).command
          : toolCall.arguments;

      for (const rule of this.rules) {
        if (rule.pattern.test(command)) {
          return { reason: rule.reason, detail: command };
        }
      }
    }

    // 2. 针对文件写入/编辑工具：检查是否试图直接覆写受保护的关键文件（如 .env）
    if (toolCall.name === "write_file" || toolCall.name === "edit_file") {
      const targetPath =
        typeof (args as { path?: unknown } | null)?.path === "string"
          ? (args as { path: string }).path
          : "";
      if (/(^|\/)\.env(\.|$)/i.test(targetPath)) {
        return {
          reason: "修改敏感环境配置文件 (.env)",
          detail: `${toolCall.name} -> ${targetPath}`,
        };
      }
    }

    return null;
  }
}

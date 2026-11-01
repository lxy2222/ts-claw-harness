import { createInterface } from "node:readline/promises";
import type { ApprovalChannel, ApprovalRequest } from "../types/approval";

/** 在终端里向用户确认;除明确输入 y/yes 外一律视为拒绝 */
export class CliApprovalChannel implements ApprovalChannel {
  /** 工具并发执行时可能同时请求审批,多个 readline 同时读 stdin 会互相抢输入,必须排队逐个询问 */
  private queue: Promise<unknown> = Promise.resolve();

  ask(request: ApprovalRequest): Promise<boolean> {
    const answer = this.queue.then(() => this.prompt(request));
    this.queue = answer;
    return answer;
  }

  private async prompt(request: ApprovalRequest): Promise<boolean> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // readline 会吞掉 Ctrl-C,不处理的话 question 永远不返回
    rl.on("SIGINT", () => rl.close());
    try {
      const answer = await rl.question(
        `\n⚠️  [${request.toolName}] 检测到危险操作: ${request.reason}\n    ${request.detail}\n是否允许执行? [y/N] `,
      );
      return /^y(es)?$/i.test(answer.trim());
    } catch {
      return false;
    } finally {
      rl.close();
    }
  }
}

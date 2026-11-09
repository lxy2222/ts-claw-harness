import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ApprovalChannel, ApprovalRequest } from "../types/approval";

/** 在终端里向用户确认;除明确输入 y/yes 外一律视为拒绝 */
export class CliApprovalChannel implements ApprovalChannel {
  /** 工具并发执行时可能同时请求审批,多个 readline 同时读 stdin 会互相抢输入,必须排队逐个询问 */
  private queue: Promise<void> = Promise.resolve();
  private interruptVersion = 0;

  constructor(
    private readonly input: Readable = process.stdin,
    private readonly output: Writable = process.stdout,
  ) {}

  ask(request: ApprovalRequest): Promise<boolean> {
    const version = this.interruptVersion;
    const answer = this.queue
      .then(() => version === this.interruptVersion ? this.prompt(request) : false)
      .catch(() => false);
    this.queue = answer.then(() => {});
    return answer;
  }

  private prompt(request: ApprovalRequest): Promise<boolean> {
    if (this.input.readableEnded || this.input.destroyed) return Promise.resolve(false);
    return new Promise((resolve) => {
      const rl = createInterface({ input: this.input, output: this.output });
      let settled = false;
      const finish = (approved: boolean) => {
        if (settled) return;
        settled = true;
        rl.removeListener("SIGINT", onTerminalInterrupt);
        rl.removeListener("close", onClose);
        process.removeListener("SIGINT", onProcessInterrupt);
        this.input.removeListener("error", onInputError);
        rl.close();
        resolve(approved);
      };
      const onClose = () => finish(false);
      const onInputError = () => finish(false);
      const onProcessInterrupt = () => {
        this.interruptVersion++;
        finish(false);
      };
      const onTerminalInterrupt = () => {
        this.interruptVersion++;
        finish(false);
        // readline 吞掉的终端 Ctrl-C 仍需传给 CLI 的 AbortController。
        process.emit("SIGINT");
      };
      rl.once("close", onClose);
      rl.once("SIGINT", onTerminalInterrupt);
      process.once("SIGINT", onProcessInterrupt);
      this.input.once("error", onInputError);
      try {
        rl.question(
          `\n⚠️  [${request.toolName}] 检测到危险操作: ${request.reason}\n    ${request.detail}\n是否允许执行? [y/N] `,
          (answer) => finish(/^y(es)?$/i.test(answer.trim())),
        );
      } catch {
        finish(false);
      }
    });
  }
}

import { spawn } from "node:child_process";
import type { ApprovalChannel } from "../types/approval";
import type { Context } from "../types/context";
import type { baseTool } from "./registry";

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 8000;
const MAX_OUTPUT_BYTES = 32 * 1024;

/** 命中任意一条即需要用户确认;新增危险模式往这里加 */
const DANGEROUS_PATTERNS: { reason: string; test: (command: string) => boolean }[] = [
  { reason: "rm -rf 递归强制删除", test: isRecursiveForceRm },
];

interface RunResult {
  /** stdout 与 stderr 按到达顺序合并 */
  output: string;
  outputBytes: number;
  truncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

/** 在工作区内执行 bash 命令;失败时抛错,由 registry 标记为工具错误 */
export class BashTool implements baseTool {
  readonly name = "bash";  readonly description =
    "在当前工作区执行任意的 bash 命令。支持链式命令(如 &&)。返回标准输出(stdout)和标准错误(stderr)。";
  readonly inputSchema = {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "要执行的 bash 命令，例如: ls -la 或 pnpm test",
      },
    },
    required: ["command"],
  };
  private readonly workDir: string = "";
  private readonly approval: ApprovalChannel;

  constructor(workDir: string, approval: ApprovalChannel) {
    this.workDir = workDir;
    this.approval = approval;
  }

  async execute(ctx: Context, args: unknown): Promise<string> {
    if (ctx.signal.aborted) throw new Error("命令已被用户取消");
    const command = (args as { command?: unknown } | null)?.command;
    if (typeof command !== "string" || command.trim() === "") {
      throw new Error("参数 command 必须是非空字符串");
    }

    const danger = detectDanger(command);
    if (danger) {
      const approved = await this.approval.ask({ toolName: this.name, reason: danger, detail: command });
      if (!approved) {
        throw new Error(`用户拒绝执行危险命令(${danger})。请改用更安全的方式,或先向用户说明原因再重试`);
      }
    }

    if (ctx.signal.aborted) throw new Error("命令已被用户取消");
    const result = await runCommand(command, this.workDir, ctx.signal);
    if (ctx.signal.aborted) {
      throw new Error("命令已被用户取消");
    }

    const output = truncate(result);
    if (result.timedOut) {
      throw new Error(`命令执行超时（${TIMEOUT_MS / 1000} 秒），已终止进程组。\n输出：\n${output}`);
    }
    if (result.exitCode !== 0) {
      const reason = result.signal ? `被信号 ${result.signal} 终止` : `退出码 ${result.exitCode}`;
      throw new Error(`命令执行失败：${reason}\n输出：\n${output}`);
    }
    if (output === "") {
      return "命令执行成功，无终端输出。";
    }
    return output;
  }
}

function detectDanger(command: string): string | undefined {
  return DANGEROUS_PATTERNS.find((pattern) => pattern.test(command))?.reason;
}

/**
 * 识别 rm -rf / rm -fr / rm -r -f / rm --recursive --force 等写法。
 * 按命令分隔符和引号切段,使 `sudo rm -rf`、`bash -c "rm -rf x"` 也能命中;
 * 只是启发式检查,`$(...)` 拼接、变量展开等写法仍可绕过。
 */
function isRecursiveForceRm(command: string): boolean {
  for (const segment of command.split(/[;&|\n()`'"]/)) {
    const tokens = segment.trim().split(/\s+/);
    const rmIndex = tokens.findIndex((token) => token === "rm" || token.endsWith("/rm"));
    if (rmIndex === -1) continue;

    let recursive = false;
    let force = false;
    for (const token of tokens.slice(rmIndex + 1)) {
      if (token === "--") break;
      if (token === "--recursive") recursive = true;
      else if (token === "--force") force = true;
      else if (/^-[a-zA-Z]+$/.test(token)) {
        if (/[rR]/.test(token)) recursive = true;
        if (token.includes("f")) force = true;
      }
    }
    if (recursive && force) return true;
  }
  return false;
}

function runCommand(command: string, cwd: string, signal: AbortSignal): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("命令已被用户取消"));
      return;
    }
    // detached 让 bash 成为新进程组的组长,超时时可以连同它派生的子进程一起杀掉;
    // 否则 `sleep 100 | cat` 这类命令里孙进程仍持有管道,close 事件迟迟不来
    const child = spawn("bash", ["-c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    // 固定容量复制前缀,超出后继续排空管道,不把全部输出留在内存里。
    const outputBuffer = Buffer.alloc(MAX_OUTPUT_BYTES);
    let capturedBytes = 0;
    let outputBytes = 0;
    const collect = (chunk: Buffer) => {
      outputBytes += chunk.length;
      const remaining = MAX_OUTPUT_BYTES - capturedBytes;
      if (remaining > 0) {
        capturedBytes += chunk.copy(outputBuffer, capturedBytes, 0, Math.min(chunk.length, remaining));
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    let timedOut = false;
    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // 进程组已经退出
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, TIMEOUT_MS);
    signal.addEventListener("abort", killGroup, { once: true });
    if (signal.aborted) killGroup();

    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", killGroup);
    };
    child.on("error", (err) => {
      cleanup();
      reject(new Error("无法启动 Bash 命令，请检查工作目录和 Bash 是否可用", { cause: err }));
    });
    child.on("close", (exitCode, exitSignal) => {
      cleanup();
      resolve({
        output: outputBuffer.subarray(0, capturedBytes).toString("utf8"),
        outputBytes,
        truncated: outputBytes > capturedBytes,
        exitCode,
        signal: exitSignal,
        timedOut,
      });
    });
  });
}

function truncate(result: RunResult): string {
  if (!result.truncated && result.output.length <= MAX_OUTPUT_CHARS) return result.output;
  return `${result.output.slice(0, MAX_OUTPUT_CHARS)}\n\n[终端输出过长，已截断；共收到 ${result.outputBytes} 字节，最多保留 ${MAX_OUTPUT_BYTES} 字节，展示前 ${MAX_OUTPUT_CHARS} 字符]`;
}

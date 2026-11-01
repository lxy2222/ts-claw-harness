import { spawn } from "node:child_process";
import type { ApprovalChannel } from "../types/approval";
import type { Context } from "../types/context";
import type { baseTool } from "./registry";

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 8000;

/** 命中任意一条即需要用户确认;新增危险模式往这里加 */
const DANGEROUS_PATTERNS: { reason: string; test: (command: string) => boolean }[] = [
  { reason: "rm -rf 递归强制删除", test: isRecursiveForceRm },
];

interface RunResult {
  /** stdout 与 stderr 按到达顺序合并 */
  output: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

/** 在工作区内执行 bash 命令;命令失败时把报错作为普通输出返回,交给模型自行纠错 */
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

    const result = await runCommand(command, this.workDir, ctx.signal);
    if (ctx.signal.aborted) {
      throw new Error("命令已被用户取消");
    }

    const output = truncate(result.output);
    if (result.timedOut) {
      return `${output}\n[警告: 命令执行超时(${TIMEOUT_MS / 1000}s)，已被系统强制终止。如果是启动常驻服务，请尝试将其转入后台。]`;
    }
    if (result.exitCode !== 0) {
      const reason = result.signal ? `被信号 ${result.signal} 终止` : `退出码 ${result.exitCode}`;
      return `执行报错: ${reason}\n输出:\n${output}`;
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
    // detached 让 bash 成为新进程组的组长,超时时可以连同它派生的子进程一起杀掉;
    // 否则 `sleep 100 | cat` 这类命令里孙进程仍持有管道,close 事件迟迟不来
    const child = spawn("bash", ["-c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));

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
      reject(err);
    });
    child.on("close", (exitCode, exitSignal) => {
      cleanup();
      resolve({
        output: Buffer.concat(chunks).toString("utf8"),
        exitCode,
        signal: exitSignal,
        timedOut,
      });
    });
  });
}

function truncate(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  return `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n...[终端输出过长，已截断至前 ${MAX_OUTPUT_CHARS} 字符，共 ${output.length} 字符]...`;
}

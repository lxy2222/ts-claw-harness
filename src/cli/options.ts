import path from "node:path";

export interface CliOptions {
  help: boolean;
  workDir: string;
  sessionId: string;
  prompt: string;
  maxTurns: number;
  maxContextChars: number;
  thinking: boolean;
  planMode: boolean;
  stream: boolean;
}

export const HELP = `Tiny Claw：轻量 Agent CLI

用法：claw [选项] "任务描述"
  或：claw -prompt "任务描述"

  -h, --help                  查看帮助（无需密钥，不创建会话）
  -p, -prompt, --prompt <文>  要交给 Agent 执行的任务描述（也可直接作为位置参数）
  -C, --workdir <目录>        工作区，默认当前目录
  -s, --session <标识>        会话标识，默认 task_web_server_01；同工作区同标识恢复历史
      --max-turns <轮数>     最大执行轮数，默认 20
      --context-chars <数量> 上下文字符预算，默认 12000（非精确 token 数）
      --thinking             开启独立规划阶段
      --plan                 开启 PLAN.md / TODO.md 计划模式（默认开启）
      --no-plan              关闭计划模式
      --no-stream            使用非流式兼容接口

示例：claw -prompt "读取说明并生成摘要"
运行前设置 LLM_API_KEY，可选 LLM_BASE_URL、LLM_MODEL；也可使用启动目录的 .env。
会话保存在工作区 .claw/sessions/；Bash 以当前用户权限运行。`;

export function parseCliArgs(args: string[], cwd = process.cwd()): CliOptions {
  const options: CliOptions = {
    help: false, workDir: cwd, sessionId: "task_web_server_01", prompt: "",
    maxTurns: 20, maxContextChars: 12000, thinking: false, planMode: true, stream: true,
  };
  const prompt: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") { prompt.push(...args.slice(i + 1)); break; }
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    if (arg === "--thinking") { options.thinking = true; continue; }
    if (arg === "--plan") { options.planMode = true; continue; }
    if (arg === "--no-plan") { options.planMode = false; continue; }
    if (arg === "--no-stream") { options.stream = false; continue; }
    if (["-p", "-prompt", "--prompt"].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`选项 ${arg} 缺少参数`);
      prompt.push(value);
      continue;
    }
    if (["--workdir", "-C", "--session", "-s", "--max-turns", "--context-chars"].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`选项 ${arg} 缺少参数`);
      if (arg === "--workdir" || arg === "-C") options.workDir = path.resolve(cwd, value);
      else if (arg === "--session" || arg === "-s") options.sessionId = value;
      else {
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
          throw new Error(`选项 ${arg} 必须是正整数`);
        }
        if (arg === "--max-turns") options.maxTurns = Number(value);
        else options.maxContextChars = Number(value);
      }
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`未知选项：${arg}，请使用 --help 查看帮助`);
    prompt.push(arg);
  }
  options.prompt = prompt.join(" ").trim();
  if (options.help) return options;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.sessionId)) {
    throw new Error("会话标识须为 1–64 位字母、数字、下划线或连字符");
  }
  if (!options.prompt) throw new Error("请提供任务描述，或使用 --help 查看帮助");
  return options;
}

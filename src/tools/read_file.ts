import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Context } from "../types/context";
import type { baseTool } from "./registry";

const MAX_OUTPUT_CHARS = 20000;

/** 读取工作区内的文本文件;路径限制在 workDir 之内,防止模型越界读取 */
export class ReadFileTool implements baseTool {
  readonly name = "read_file";
  readonly description =
    "读取当前工作区内指定文件的文本内容。path 为相对工作区根目录的路径,例如 hello.txt 或 src/index.ts。";
  readonly inputSchema = {
    type: "object",
    properties: {
      path: { type: "string", description: "相对工作区根目录的文件路径" },
    },
    required: ["path"],
  };
  private readonly workDir: string = "";

  constructor(workDir: string) {
    this.workDir = workDir;
  }

  async execute(ctx: Context, args: unknown): Promise<string> {
    const filePath = (args as { path?: unknown } | null)?.path;
    if (typeof filePath !== "string" || filePath.trim() === "") {
      throw new Error("参数 path 必须是非空字符串");
    }

    const target = await this.resolveInsideWorkDir(filePath);
    const info = await stat(target);
    if (!info.isFile()) {
      throw new Error(`${filePath} 不是文件`);
    }

    const content = await readFile(target, { encoding: "utf8", signal: ctx.signal });
    if (content.length <= MAX_OUTPUT_CHARS) {
      return content;
    }
    return `${content.slice(0, MAX_OUTPUT_CHARS)}\n\n[内容过长,已截断:共 ${content.length} 字符,只返回前 ${MAX_OUTPUT_CHARS} 字符]`;
  }

  /** realpath 会解析符号链接,避免通过软链接跳出工作区 */
  private async resolveInsideWorkDir(filePath: string): Promise<string> {
    const root = await realpath(this.workDir);
    let target: string;
    try {
      target = await realpath(path.resolve(root, filePath));
    } catch {
      throw new Error(`文件不存在: ${filePath}`);
    }

    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`拒绝访问工作区之外的路径: ${filePath}`);
    }
    return target;
  }
}

import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { Context } from "../types/context";
import type { baseTool } from "./registry";
import { resolveInsideWorkDir } from "./workspace";

const MAX_OUTPUT_CHARS = 8000;

/** 读取工作区内的文本文件;路径限制在 workDir 之内,防止模型越界读取 */
export class ReadFileTool implements baseTool {
  readonly name = "read_file";  readonly description =
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

    const target = await resolveInsideWorkDir(this.workDir, filePath);
    const info = await stat(target);
    if (!info.isFile()) {
      throw new Error(`${filePath} 不是文件`);
    }

    if (ctx.signal.aborted) throw new Error("读取文件已取消");
    const file = await open(target, "r");
    const buffer = Buffer.alloc(16 * 1024);
    const decoder = new StringDecoder("utf8");
    let content = "";
    try {
      while (content.length <= MAX_OUTPUT_CHARS) {
        if (ctx.signal.aborted) throw new Error("读取文件已取消");
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
        if (ctx.signal.aborted) throw new Error("读取文件已取消");
        if (bytesRead === 0) {
          content += decoder.end();
          break;
        }
        content += decoder.write(buffer.subarray(0, bytesRead));
      }
    } finally {
      await file.close();
    }
    if (content.length <= MAX_OUTPUT_CHARS) {
      return content;
    }
    return `${content.slice(0, MAX_OUTPUT_CHARS)}\n\n[内容过长,已截断:文件共 ${info.size} 字节,只返回前 ${MAX_OUTPUT_CHARS} 字符]`;
  }
}

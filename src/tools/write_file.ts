import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Context } from "../types/context";
import type { baseTool } from "./registry";
import { resolveWritableInsideWorkDir } from "./workspace";

/** 创建或覆盖写入工作区内的文件,缺失的父目录会自动创建 */
export class WriteFileTool implements baseTool {
  readonly name = "write_file";  readonly description =
    "创建或覆盖写入一个文件。如果目录不存在会自动创建。请提供相对于工作区的相对路径。";
  readonly inputSchema = {
    type: "object",
    properties: {
      path: { type: "string", description: "要写入的文件路径，如 src/main.ts" },
      content: { type: "string", description: "要写入的完整文件内容" },
    },
    required: ["path", "content"],
  };
  private readonly workDir: string = "";

  constructor(workDir: string) {
    this.workDir = workDir;
  }

  async execute(ctx: Context, args: unknown): Promise<string> {
    const { path: filePath, content } = (args ?? {}) as { path?: unknown; content?: unknown };
    if (typeof filePath !== "string" || filePath.trim() === "") {
      throw new Error("参数 path 必须是非空字符串");
    }
    if (typeof content !== "string") {
      throw new Error("参数 content 必须是字符串");
    }

    const target = await resolveWritableInsideWorkDir(this.workDir, filePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { encoding: "utf8", signal: ctx.signal });

    return `成功将内容写入到文件: ${filePath}`;
  }
}

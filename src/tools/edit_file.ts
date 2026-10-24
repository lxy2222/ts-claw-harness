import { readFile, stat, writeFile } from "node:fs/promises";
import type { Context } from "../types/context";
import type { baseTool } from "./registry";
import { resolveInsideWorkDir } from "./workspace";

interface EditFileArgs {
  path: string;
  old_text: string;
  new_text: string;
}

/** 对工作区内的已有文件做局部字符串替换;old_text 需唯一匹配,匹配不上时按 fuzzyReplace 逐级放宽 */
export class EditFileTool implements baseTool {
  readonly name = "edit_file";
  readonly description =
    "对现有文件进行局部的字符串替换。这比重写整个文件更安全、更快速。请提供足够的 old_text 上下文以确保匹配的唯一性。";
  readonly inputSchema = {
    type: "object",
    properties: {
      path: { type: "string", description: "要修改的文件路径" },
      old_text: {
        type: "string",
        description:
          "文件中原有的文本。必须包含足够的上下文（建议上下各多包含几行），以确保在文件中的唯一性。",
      },
      new_text: { type: "string", description: "要替换成的新文本" },
    },
    required: ["path", "old_text", "new_text"],
  };
  private readonly workDir: string = "";

  constructor(workDir: string) {
    this.workDir = workDir;
  }

  async execute(ctx: Context, args: unknown): Promise<string> {
    const { path: filePath, old_text: oldText, new_text: newText } = parseArgs(args);

    const target = await resolveInsideWorkDir(this.workDir, filePath);
    const info = await stat(target);
    if (!info.isFile()) {
      throw new Error(`${filePath} 不是文件`);
    }

    const originalContent = await readFile(target, { encoding: "utf8", signal: ctx.signal });
    // 匹配失败的具体原因(找不到 / 匹配多处)原样抛给模型,让它自行纠正
    const newContent = fuzzyReplace(originalContent, oldText, newText);
    await writeFile(target, newContent, { encoding: "utf8", signal: ctx.signal });

    return `✅ 成功修改文件: ${filePath}`;
  }
}

/** 四级容错降级替换:精确匹配 → 换行符归一化 → 去首尾空白 → 逐行去缩进 */
export function fuzzyReplace(originalContent: string, oldText: string, newText: string): string {
  // L1: 精确匹配
  let count = countOccurrences(originalContent, oldText);
  if (count === 1) {
    return replaceOnce(originalContent, oldText, newText);
  }
  if (count > 1) {
    throw new Error(`old_text 匹配到了 ${count} 处，请提供更多的上下文代码以确保唯一性`);
  }

  // L2: 换行符归一化,\r\n 统一为 \n;命中后整个文件的换行符都会变成 \n
  const normalizedContent = originalContent.replaceAll("\r\n", "\n");
  const normalizedOld = oldText.replaceAll("\r\n", "\n");
  count = countOccurrences(normalizedContent, normalizedOld);
  if (count === 1) {
    return replaceOnce(normalizedContent, normalizedOld, newText);
  }

  // L3: 忽略 old_text 首尾的空行和空格;new_text 不会补回被 trim 掉的缩进
  const trimmedOld = normalizedOld.trim();
  if (trimmedOld !== "") {
    count = countOccurrences(normalizedContent, trimmedOld);
    if (count === 1) {
      return replaceOnce(normalizedContent, trimmedOld, newText);
    }
  }

  // L4: 逐行去缩进匹配,兜住模型遗漏或写错缩进的情况
  return lineByLineReplace(normalizedContent, normalizedOld, newText);
}

/** 按行切割,每行去首尾空白后做滑动窗口匹配,命中的整段行替换为 newText */
function lineByLineReplace(content: string, oldText: string, newText: string): string {
  const contentLines = content.split("\n");
  const oldLines = oldText
    .trim()
    .split("\n")
    .map((line) => line.trim());

  if (contentLines.length < oldLines.length) {
    throw new Error("找不到该代码片段");
  }

  let matchCount = 0;
  let matchStart = -1;
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    if (oldLines.every((oldLine, j) => contentLines[i + j]?.trim() === oldLine)) {
      matchCount++;
      matchStart = i;
    }
  }

  if (matchCount === 0) {
    throw new Error("在文件中未找到 old_text，请先调用 read_file 仔细确认文件内容和缩进");
  }
  if (matchCount > 1) {
    throw new Error(`模糊匹配到了 ${matchCount} 处相似代码，请提供更多上下行代码以精确定位`);
  }

  return [
    ...contentLines.slice(0, matchStart),
    newText,
    ...contentLines.slice(matchStart + oldLines.length),
  ].join("\n");
}

/** 不用 String.replace:new_text 中的 `$&`、`$1` 等会被当作替换模式解释 */
function replaceOnce(content: string, search: string, replacement: string): string {
  const index = content.indexOf(search);
  return content.slice(0, index) + replacement + content.slice(index + search.length);
}

function parseArgs(args: unknown): EditFileArgs {
  const { path, old_text, new_text } = (args ?? {}) as Partial<Record<keyof EditFileArgs, unknown>>;
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error("参数 path 必须是非空字符串");
  }
  if (typeof old_text !== "string" || old_text === "") {
    throw new Error("参数 old_text 必须是非空字符串");
  }
  if (typeof new_text !== "string") {
    throw new Error("参数 new_text 必须是字符串");
  }
  return { path, old_text, new_text };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  while (true) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return count;
    count++;
    from = index + needle.length;
  }
}

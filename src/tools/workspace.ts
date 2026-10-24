import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

/** 把工作区内的已有文件解析为真实路径;realpath 会解析符号链接,避免通过软链接跳出工作区 */
export async function resolveInsideWorkDir(workDir: string, filePath: string): Promise<string> {
  const root = await realpath(workDir);
  let target: string;
  try {
    target = await realpath(path.resolve(root, filePath));
  } catch {
    throw new Error(`文件不存在: ${filePath}`);
  }

  assertInside(root, target, filePath);
  return target;
}

/**
 * 解析一个可能尚不存在的写入目标。
 * 对最近一个已存在的祖先(或目标本身)做 realpath 校验,防止经由软链接写出工作区。
 */
export async function resolveWritableInsideWorkDir(workDir: string, filePath: string): Promise<string> {
  const root = await realpath(workDir);
  const target = path.resolve(root, filePath);
  assertInside(root, target, filePath);

  let existing = target;
  while (!(await exists(existing))) {
    existing = path.dirname(existing);
  }

  let real: string;
  try {
    real = await realpath(existing);
  } catch {
    throw new Error(`拒绝写入悬空的符号链接: ${filePath}`);
  }
  assertInside(root, real, filePath);
  return target;
}

function assertInside(root: string, target: string, filePath: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`拒绝访问工作区之外的路径: ${filePath}`);
  }
}

/** 用 lstat 判断,悬空的符号链接也算存在 */
async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

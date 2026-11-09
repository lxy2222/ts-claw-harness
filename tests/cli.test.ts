import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseCliArgs } from "../src/cli/options";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const loader = import.meta.resolve("tsx/esm");

test("解析任务、工作区、会话和运行限制", () => {
  const options = parseCliArgs(["-C", "demo", "-s", "session_1", "--max-turns", "3", "--no-stream", "执行", "任务"], "/tmp");
  assert.equal(options.workDir, "/tmp/demo");
  assert.equal(options.sessionId, "session_1");
  assert.equal(options.maxTurns, 3);
  assert.equal(options.stream, false);
  assert.equal(options.prompt, "执行 任务");
});

test("缺失任务、非法参数和路径式会话标识有中文报错", () => {
  assert.throws(() => parseCliArgs([]), /任务描述/);
  assert.throws(() => parseCliArgs(["--unknown"]), /未知选项/);
  assert.throws(() => parseCliArgs(["--session"]), /缺少参数/);
  assert.throws(() => parseCliArgs(["--session", "../escape", "任务"]), /会话标识/);
  assert.throws(() => parseCliArgs(["--max-turns", "0", "任务"]), /正整数/);
  assert.throws(() => parseCliArgs(["--max-turns", "1.5", "任务"]), /正整数/);
});

test("帮助无需密钥，不创建日志或会话文件", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tiny-claw-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { stdout } = await exec(process.execPath, ["--import", loader, cli, "--help"], {
    cwd: dir, env: { ...process.env, LLM_API_KEY: "" }, timeout: 10_000,
  });
  assert.match(stdout, /Tiny Claw/);
  assert.match(stdout, /--session/);
  assert.deepEqual(readdirSync(dir), []);
});

test("缺失密钥可预测地失败，不产生演示文件", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tiny-claw-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(exec(process.execPath, ["--import", loader, cli, "测试任务"], {
    cwd: dir, env: { ...process.env, LLM_API_KEY: "" }, timeout: 10_000,
  }), (error: unknown) => {
    assert.match((error as { stderr: string }).stderr, /LLM_API_KEY/);
    return true;
  });
  assert.deepEqual(readdirSync(dir), []);
});

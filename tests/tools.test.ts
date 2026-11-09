import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import { test } from "node:test";
import { BashTool } from "../src/tools/bash";
import { EditFileTool } from "../src/tools/edit_file";
import { ReadFileTool } from "../src/tools/read_file";
import { RegistryImpl } from "../src/tools/registry";
import { WriteFileTool } from "../src/tools/write_file";

const context = () => ({ signal: new AbortController().signal });
const call = (name: string, args: unknown) => ({ id: `test-${name}`, name, arguments: JSON.stringify(args) });
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test("registry 返回中文未知工具、无效 JSON 和执行错误，并保留调用关联", async () => {
  const registry = new RegistryImpl();
  let executions = 0;
  registry.registerTool({
    name: "example",
    description: "测试工具",
    execute: async () => { executions++; throw new Error("预期失败"); },
  });
  const missing = await registry.executeTool(context(), call("missing", {}));
  assert.equal(missing.isError, true);
  assert.equal(missing.toolCallId, "test-missing");
  assert.match(missing.output, /未找到工具/);
  const invalid = await registry.executeTool(context(), { id: "invalid", name: "example", arguments: "{" });
  assert.equal(invalid.isError, true);
  assert.match(invalid.output, /参数不是有效的 JSON/);
  assert.equal(executions, 0);
  const failed = await registry.executeTool(context(), call("example", {}));
  assert.equal(failed.isError, true);
  assert.match(failed.output, /执行失败：预期失败/);
  assert.equal(executions, 1);
});

test("registry 已取消时不调用工具", async () => {
  const registry = new RegistryImpl();
  let executions = 0;
  registry.registerTool({ name: "example", description: "测试工具", execute: async () => { executions++; return "完成"; } });
  const controller = new AbortController();
  controller.abort();
  const result = await registry.executeTool({ signal: controller.signal }, call("example", {}));
  assert.equal(result.isError, true);
  assert.match(result.output, /已取消/);
  assert.equal(executions, 0);
});

test("bash 非零退出向 registry 报错，并保留输出", async () => {
  const registry = new RegistryImpl();
  registry.registerTool(new BashTool(os.tmpdir(), { ask: async () => false }));
  const result = await registry.executeTool(context(), call("bash", { command: "printf audit-only; exit 7" }));
  assert.equal(result.isError, true);
  assert.match(result.output, /退出码 7/);
  assert.match(result.output, /audit-only/);
});

test("bash 大量输出有界返回并报告截断和总字节数", async () => {
  const bash = new BashTool(os.tmpdir(), { ask: async () => false });
  const script = "process.stdout.write('x'.repeat(2 * 1024 * 1024))";
  const result = await bash.execute(context(), { command: `${shellQuote(process.execPath)} -e ${shellQuote(script)}` });
  assert.ok(result.startsWith("x".repeat(8000)));
  assert.ok(result.length < 9000);
  assert.match(result, /已截断/);
  assert.match(result, /共收到 2097152 字节/);
});

test("bash 预取消和审批期间取消均不启动命令", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tiny-claw-cancel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const controller = new AbortController();
  controller.abort();
  const bash = new BashTool(dir, { ask: async () => true });
  await assert.rejects(bash.execute({ signal: controller.signal }, { command: "printf unexpected > pre-cancelled.txt" }), /取消/);
  assert.equal(existsSync(path.join(dir, "pre-cancelled.txt")), false);

  const duringApproval = new AbortController();
  let asked = false;
  const approved = new BashTool(dir, { ask: async () => { asked = true; duringApproval.abort(); return true; } });
  // 只打印字符串,并非执行 rm;保留现有启发式审批检测。
  await assert.rejects(approved.execute({ signal: duringApproval.signal }, { command: "printf '%s' 'rm -rf' > after-approval.txt" }), /取消/);
  assert.equal(asked, true);
  assert.equal(existsSync(path.join(dir, "after-approval.txt")), false);
});

test("bash 运行中取消能终止进程组并返回取消错误", async () => {
  const controller = new AbortController();
  const bash = new BashTool(os.tmpdir(), { ask: async () => false });
  const running = bash.execute({ signal: controller.signal }, { command: "sleep 30 | cat" });
  const cancellation = setTimeout(() => controller.abort(), 30);
  try {
    await assert.rejects(running, /已被用户取消/);
  } finally {
    clearTimeout(cancellation);
  }
});

test("bash 超时被标记为工具失败", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const registry = new RegistryImpl();
  registry.registerTool(new BashTool(os.tmpdir(), { ask: async () => false }));
  const running = registry.executeTool(context(), call("bash", { command: "sleep 30 | cat" }));
  await nextTick();
  t.mock.timers.tick(30_000);
  const result = await running;
  assert.equal(result.isError, true);
  assert.match(result.output, /命令执行超时/);
});

test("文件工具能读写编辑；大文件只返回前缀且不破坏 UTF-8", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tiny-claw-tools-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registry = new RegistryImpl();
  registry.registerTool(new ReadFileTool(dir));
  registry.registerTool(new WriteFileTool(dir));
  registry.registerTool(new EditFileTool(dir));
  assert.equal((await registry.executeTool(context(), call("write_file", { path: "example.txt", content: "hello world" }))).isError, false);
  assert.equal((await registry.executeTool(context(), call("edit_file", { path: "example.txt", old_text: "world", new_text: "工具" }))).isError, false);
  assert.equal(await readFile(path.join(dir, "example.txt"), "utf8"), "hello 工具");
  assert.equal((await registry.executeTool(context(), call("read_file", { path: "example.txt" }))).output, "hello 工具");
  await writeFile(path.join(dir, "large.txt"), "中".repeat(100_000));
  const large = await registry.executeTool(context(), call("read_file", { path: "large.txt" }));
  assert.equal(large.isError, false);
  assert.ok(large.output.startsWith("中".repeat(8000)));
  assert.ok(large.output.length < 8200);
  assert.match(large.output, /文件共 300000 字节/);
  assert.equal(large.output.includes("�"), false);
});

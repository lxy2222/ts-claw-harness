import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { CliApprovalChannel } from "../src/cli/approval";

const request = { toolName: "bash", reason: "测试确认", detail: "只测试输入，不执行命令" };

test("CLI 审批仅允许明确 y/yes，拒绝后队列仍能继续", async (t) => {
  const input = new PassThrough();
  const output = new PassThrough();
  t.after(() => { input.destroy(); output.destroy(); });
  const channel = new CliApprovalChannel(input, output);
  const firstPrompt = once(output, "data");
  const first = channel.ask(request);
  const second = channel.ask(request);
  await firstPrompt;
  const secondPrompt = once(output, "data");
  input.write("n\n");
  assert.equal(await first, false);
  await secondPrompt;
  input.write("yes\n");
  assert.equal(await second, true);
});

test("CLI 审批 EOF 与后续排队请求均拒绝并完成", async (t) => {
  const input = new PassThrough();
  const output = new PassThrough();
  t.after(() => { input.destroy(); output.destroy(); });
  const channel = new CliApprovalChannel(input, output);
  const prompt = once(output, "data");
  const first = channel.ask(request);
  const second = channel.ask(request);
  await prompt;
  input.end();
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
});

test("CLI 审批进程 SIGINT 能结算并清理监听器", async (t) => {
  const input = new PassThrough();
  const output = new PassThrough();
  t.after(() => { input.destroy(); output.destroy(); });
  const initialListeners = process.listenerCount("SIGINT");
  const channel = new CliApprovalChannel(input, output);
  const prompt = once(output, "data");
  const answer = channel.ask(request);
  const queued = channel.ask(request);
  await prompt;
  process.emit("SIGINT");
  assert.equal(await answer, false);
  assert.equal(await queued, false);
  assert.equal(process.listenerCount("SIGINT"), initialListeners);
});

test("CLI 审批终端 Ctrl-C 能结算并传递取消信号", async (t) => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} });
  const output = Object.assign(new PassThrough(), { isTTY: true });
  t.after(() => { input.destroy(); output.destroy(); });
  let interrupts = 0;
  const onInterrupt = () => { interrupts++; };
  process.on("SIGINT", onInterrupt);
  t.after(() => process.removeListener("SIGINT", onInterrupt));
  const channel = new CliApprovalChannel(input, output);
  const prompt = once(output, "data");
  const answer = channel.ask(request);
  await prompt;
  input.write("\x03");
  assert.equal(await answer, false);
  assert.equal(interrupts, 1);
});

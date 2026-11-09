import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentEngine } from "../src/engine/loop";
import { Session } from "../src/engine/session";
import type { GenerateOptions, LLMProvider } from "../src/provider";
import { RegistryImpl } from "../src/tools/registry";
import type { Context } from "../src/types/context";
import type { Message } from "../src/types/message";

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tiny-claw-engine-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, session: new Session("test", dir), ctx: { signal: new AbortController().signal } };
}

test("同会话的用户输入和执行串行，不把下一条输入插入当前轮", async (t) => {
  const { session, ctx } = fixture(t);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const ready = new Promise<void>((r) => { started = r; });
  const contexts: Message[][] = [];
  const provider: LLMProvider = { async generate(_ctx, messages) {
    contexts.push(structuredClone(messages));
    if (contexts.length === 1) { started(); await gate; }
    return { role: "assistant", content: `回答${contexts.length}` };
  } };
  const engine = new AgentEngine(provider, new RegistryImpl());
  const first = engine.run(ctx, session, "任务A");
  await ready;
  const second = engine.run(ctx, session, "任务B");
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(session.size(), 1);
  assert.equal(contexts[0]!.some((m) => m.content === "任务B"), false);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(session.getWorkingMemory(100).map((m) => m.content),
    ["任务A", "回答1", "任务B", "回答2"]);
});

test("排队期间取消的任务不追加输入或调用模型", async (t) => {
  const { session, ctx } = fixture(t);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const ready = new Promise<void>((r) => { started = r; });
  let calls = 0;
  const provider: LLMProvider = { async generate() {
    calls++; started(); await gate;
    return { role: "assistant", content: "完成" };
  } };
  const engine = new AgentEngine(provider, new RegistryImpl());
  const first = engine.run(ctx, session, "任务A");
  await ready;
  const controller = new AbortController();
  const second = engine.run({ signal: controller.signal }, session, "任务B");
  const rejected = assert.rejects(second, /取消/);
  controller.abort(); release();
  await Promise.all([first, rejected]);
  assert.equal(calls, 1);
  assert.equal(session.size(), 2);
});

test("模型返回后取消不会启动工具或保存不完整工具组", async (t) => {
  const { session } = fixture(t);
  const controller = new AbortController();
  let executions = 0;
  const registry = new RegistryImpl();
  registry.registerTool({ name: "probe", description: "测试", async execute() { executions++; return "完成"; } });
  const provider: LLMProvider = { async generate() {
    controller.abort();
    return { role: "assistant", content: "", toolCalls: [{ id: "one", name: "probe", arguments: "{}" }] };
  } };
  await assert.rejects(new AgentEngine(provider, registry).run(
    { signal: controller.signal }, session, "测试取消"), /取消/);
  assert.equal(executions, 0);
  assert.equal(session.size(), 1);
});

test("持续调用工具达到上限后终止，每个已保存调用有对应结果", async (t) => {
  const { session, ctx } = fixture(t);
  let count = 0;
  const registry = new RegistryImpl();
  registry.registerTool({ name: "probe", description: "测试", async execute() { return "完成"; } });
  const provider: LLMProvider = { async generate() {
    return { role: "assistant", content: "", toolCalls: [{ id: `call-${++count}`, name: "probe", arguments: "{}" }] };
  } };
  await assert.rejects(new AgentEngine(provider, registry).run(ctx, session, "持续执行", { maxTurns: 3 }), /最大执行轮数/);
  const memory = session.getWorkingMemory(100);
  assert.equal(count, 3);
  assert.equal(memory.length, 7);
  for (const m of memory.filter((m) => m.toolCalls?.length)) {
    assert.equal(memory.filter((r) => r.toolCallId === m.toolCalls![0]!.id).length, 1);
  }
});

test("规划清单仍未完成时达到提醒上限会明确失败", async (t) => {
  const { session, ctx, dir } = fixture(t);
  writeFileSync(path.join(dir, "TODO.md"), "- [ ] 尚未完成\n");
  const provider: LLMProvider = { async generate() { return { role: "assistant", content: "完成了" }; } };
  await assert.rejects(new AgentEngine(provider, new RegistryImpl(), false, true).run(
    ctx, session, "完成待办", { maxTurns: 8 }), /清单仍有未完成项/);
});

test("正文流式回调被传给provider，完整回答仍被持久化", async (t) => {
  const { session, ctx } = fixture(t);
  const deltas: string[] = [];
  const provider: LLMProvider = { async generate(_ctx, _messages, _tools, options?: GenerateOptions) {
    options?.onTextDelta?.("你"); options?.onTextDelta?.("好");
    return { role: "assistant", content: "你好" };
  } };
  await new AgentEngine(provider, new RegistryImpl()).run(ctx, session, "问好", {
    onTextDelta: (text) => { deltas.push(text); },
  });
  assert.deepEqual(deltas, ["你", "好"]);
  assert.equal(session.getWorkingMemory(100).at(-1)?.content, "你好");
});

test("Plan Mode 内部提醒不会成为新任务边界并挤掉原始要求", async (t) => {
  const { session, ctx, dir } = fixture(t);
  const todo = path.join(dir, "TODO.md");
  writeFileSync(todo, "- [ ] 尚未完成\n");
  let calls = 0;
  const provider: LLMProvider = { async generate(_ctx, messages) {
    calls++;
    if (calls === 2) {
      assert.ok(messages.some((message) => message.role === "user" && message.content === "保留原始要求"));
      writeFileSync(todo, "- [x] 已完成\n");
    }
    return { role: "assistant", content: "完成" };
  } };
  await new AgentEngine(provider, new RegistryImpl(), false, true, 1).run(ctx, session, "保留原始要求");
  assert.equal(calls, 2);
});

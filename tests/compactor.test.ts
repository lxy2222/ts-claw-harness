import assert from "node:assert/strict";
import test from "node:test";
import { Compactor } from "../src/context/compactor";
import type { Message } from "../src/types/message";

test("预算内上下文内容不变，返回值不共享原数组和消息引用", () => {
  const messages: Message[] = [
    { role: "system", content: "系统提示" },
    { role: "user", content: "当前任务" },
  ];
  const original = structuredClone(messages);
  const compactor = new Compactor(100, 2);
  const compacted = compactor.compact(messages);
  assert.deepEqual(compacted, original);
  compacted[0]!.content = "修改返回值";
  assert.deepEqual(messages, original);
});

test("折叠旧工具输出，保留系统、最新任务、调用结构和推理字段", () => {
  const messages: Message[] = [
    { role: "system", content: "系统规则" },
    { role: "user", content: "当前用户任务" },
    {
      role: "assistant", content: "步骤解释".repeat(100), reasoningContent: "必须原样保留的推理协议",
      toolCalls: [{ id: "tool_a", name: "read_file", arguments: '{"path":"example.txt"}' }],
    },
    { role: "user", content: "工具输出".repeat(2000), toolCallId: "tool_a" },
    { role: "assistant", content: "阶段结果" },
    { role: "user", content: "最新任务" },
  ];
  const original = structuredClone(messages);
  const compactor = new Compactor(1000, 1);
  const compacted = compactor.compact(messages);
  assert.match(compacted[3]!.content, /早期的工具输出/);
  assert.deepEqual(compacted[0], original[0]);
  assert.deepEqual(compacted[5], original[5]);
  assert.deepEqual(compacted[2]!.toolCalls, original[2]!.toolCalls);
  assert.equal(compacted[2]!.reasoningContent, original[2]!.reasoningContent);
  assert.equal(compacted[3]!.toolCallId, "tool_a");
  assert.ok(compactor.estimateLength(compacted) <= compactor.maxChars);
  assert.deepEqual(messages, original);
});

test("近期超长工具结果保留首尾和调用标识，不修改原历史", () => {
  const content = "HEAD" + "x".repeat(5000) + "TAIL";
  const messages: Message[] = [
    { role: "user", content: "任务" },
    { role: "assistant", content: "", toolCalls: [{ id: "a", name: "read", arguments: "{}" }] },
    { role: "user", content, toolCallId: "a" },
  ];
  const original = structuredClone(messages);
  const compacted = new Compactor(1500, 1).compact(messages);
  assert.ok(compacted[2]!.content.startsWith("HEAD"));
  assert.ok(compacted[2]!.content.endsWith("TAIL"));
  assert.match(compacted[2]!.content, /已被系统截断/);
  assert.equal(compacted[2]!.toolCallId, "a");
  assert.deepEqual(messages, original);
});

test("不可截断字段超过估算预算时明确失败，且原上下文不变", () => {
  const cases: Message[][] = [
    [{ role: "system", content: "s".repeat(200) }],
    [{ role: "user", content: "u".repeat(200) }],
    [{ role: "assistant", content: "", reasoningContent: "r".repeat(200) }],
    [{ role: "assistant", content: "", toolCalls: [{ id: "a", name: "read", arguments: "a".repeat(200) }] }],
  ];
  for (const messages of cases) {
    const original = structuredClone(messages);
    assert.throws(() => new Compactor(100, 1).compact(messages), /上下文超出字符估算预算/);
    assert.deepEqual(messages, original);
  }
});

test("恰好等于预算不会折叠，预算配置错误使用中文报错", () => {
  const messages: Message[] = [{ role: "user", content: "12345" }];
  assert.deepEqual(new Compactor(5, 0).compact(messages), messages);
  for (const budget of [0, -1, Number.POSITIVE_INFINITY, 1.5]) {
    assert.throws(() => new Compactor(budget, 0), /字符预算必须是正整数/);
  }
  assert.throws(() => new Compactor(100, -1), /保护消息数量必须是非负整数/);
});

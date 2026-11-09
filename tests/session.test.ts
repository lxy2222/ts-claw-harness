import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Session, SessionManager } from "../src/engine/session";
import type { Message } from "../src/types/message";

function workspace(t: TestContext): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "tiny-claw-session-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function historyPath(directory: string, id = "test"): string {
  return path.join(directory, ".claw", "sessions", `${id}.jsonl`);
}

function seed(directory: string, messages: unknown[], id = "test", suffix = "\n"): string {
  const file = historyPath(directory, id);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, messages.map((message) => JSON.stringify(message)).join("\n") + suffix);
  return file;
}

const toolRequest: Message = {
  role: "assistant",
  content: "",
  toolCalls: [
    { id: "call_a", name: "read_file", arguments: '{"path":"example.txt"}' },
    { id: "call_b", name: "write_file", arguments: '{"path":"result.txt"}' },
  ],
};

test("拒绝危险或会发生净化碰撞的会话标识", (t) => {
  const directory = workspace(t);
  for (const id of ["", "../test", "a/b", "a?b", "含空格 id", "中文"]) {
    assert.throws(() => new Session(id, directory), /会话标识/);
  }
  assert.equal(new Session("a_b-123", directory).id, "a_b-123");
});

test("会话管理按真实工作区和标识隔离，同一路径别名复用", (t) => {
  const firstDirectory = workspace(t);
  const secondDirectory = workspace(t);
  const alias = path.join(secondDirectory, "workspace-alias");
  symlinkSync(firstDirectory, alias, "dir");
  const manager = new SessionManager();
  const first = manager.getOrCreate("shared", firstDirectory);
  assert.equal(manager.getOrCreate("shared", alias), first);
  const second = manager.getOrCreate("shared", secondDirectory);
  assert.notEqual(first, second);
  assert.equal(manager.get("shared", alias), first);
  assert.equal(manager.get("shared", secondDirectory), second);
  assert.throws(() => manager.get("shared"), /指定工作区/);
  first.append({ role: "user", content: "第一个工作区任务" });
  assert.equal(second.size(), 0);
});

test("追加消息持久化后可重载，输入和工作记忆不会污染内部历史", (t) => {
  const directory = workspace(t);
  const session = new Session("test", directory);
  const message: Message = { role: "user", content: "原始任务" };
  session.append(message);
  message.content = "外部修改";
  const returned = session.getWorkingMemory(20);
  returned[0]!.content = "返回值修改";
  assert.equal(session.getWorkingMemory(20)[0]!.content, "原始任务");
  assert.deepEqual(new Session("test", directory).getWorkingMemory(20), [
    { role: "user", content: "原始任务" },
  ]);
});

test("写入失败明确报错，内存历史和更新时间不提前变更", (t) => {
  const directory = workspace(t);
  mkdirSync(path.join(directory, ".claw"));
  const blocker = path.join(directory, ".claw", "sessions");
  writeFileSync(blocker, "保留此文件");
  const session = new Session("test", directory);
  const timestamp = session.updatedAt;
  assert.throws(() => session.append({ role: "user", content: "不会保存" }), /会话记录写入失败/);
  assert.equal(session.size(), 0);
  assert.equal(session.updatedAt, timestamp);
  assert.equal(readFileSync(blocker, "utf8"), "保留此文件");
});

test("坏 JSONL 不会静默丢弃后续记录，也不覆盖损坏文件", (t) => {
  const directory = workspace(t);
  const file = seed(directory, [{ role: "user", content: "有效前缀" }]);
  const raw = readFileSync(file, "utf8") + '{"role":"assistant","content":';
  writeFileSync(file, raw);
  assert.throws(() => new Session("test", directory), /会话历史恢复失败，原记录已保留/);
  assert.equal(readFileSync(file, "utf8"), raw);
});

test("恢复拒绝无效角色、错误工具结构和孤立结果，保持原记录", (t) => {
  const directory = workspace(t);
  const invalidHistories = [
    [{ role: "unknown", content: "无效角色" }],
    [{ role: "assistant", content: "", toolCalls: [{ id: "a", name: "read_file" }] }],
    [{ role: "user", content: "孤立结果", toolCallId: "missing" }],
    [toolRequest, { role: "user", content: "未配对时插入的新任务" }],
    [toolRequest, { role: "user", content: "结果", toolCallId: "call_a" },
      { role: "user", content: "重复结果", toolCallId: "call_a" }],
  ];
  invalidHistories.forEach((messages, index) => {
    const id = `invalid_${index}`;
    const file = seed(directory, messages, id);
    const raw = readFileSync(file, "utf8");
    assert.throws(() => new Session(id, directory), /会话历史恢复失败/);
    assert.equal(readFileSync(file, "utf8"), raw);
  });
});

test("恢复为未记录的工具调用补齐结果，提示检查副作用且重载不重复追加", (t) => {
  const directory = workspace(t);
  const file = seed(directory, [
    { role: "user", content: "演示任务" },
    toolRequest,
    { role: "user", content: "读取完成", toolCallId: "call_a" },
  ]);
  const session = new Session("test", directory);
  const history = session.getWorkingMemory(1);
  assert.equal(history.length, 4);
  assert.equal(history[3]!.toolCallId, "call_b");
  assert.match(history[3]!.content, /执行结果未记录，请先检查副作用，禁止自动重复执行/);
  const recoveredFile = readFileSync(file, "utf8");
  assert.deepEqual(new Session("test", directory).getWorkingMemory(1), history);
  assert.equal(readFileSync(file, "utf8"), recoveredFile);
});

test("没有末尾换行的合法记录可以继续追加", (t) => {
  const directory = workspace(t);
  const file = seed(directory, [{ role: "user", content: "原任务" }], "test", "");
  const session = new Session("test", directory);
  session.append({ role: "assistant", content: "完成" });
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 2);
  assert.equal(new Session("test", directory).size(), 2);
});

test("工作记忆软边界保留最新任务和整个并行工具组", (t) => {
  const directory = workspace(t);
  const session = new Session("test", directory);
  const latestTurn: Message[] = [
    { role: "user", content: "最新任务必须保留" },
    toolRequest,
    { role: "user", content: "第一个工具结果", toolCallId: "call_a" },
    { role: "user", content: "第二个工具结果", toolCallId: "call_b" },
  ];
  session.append(
    { role: "user", content: "旧任务" },
    { role: "assistant", content: "旧任务完成" },
    ...latestTurn,
  );
  assert.deepEqual(session.getWorkingMemory(1), latestTurn);
  assert.deepEqual(session.getWorkingMemory(2), latestTurn);
  assert.equal(session.getWorkingMemory(0).length, 6);
});

test("运行中拒绝孤立结果和未配对工具组之间的新输入，且不追加文件", (t) => {
  const directory = workspace(t);
  const session = new Session("test", directory);
  session.append({ role: "user", content: "任务" }, toolRequest);
  const before = readFileSync(historyPath(directory), "utf8");
  assert.throws(() => session.append({ role: "user", content: "插入任务" }), /工具调用顺序无效/);
  assert.equal(readFileSync(historyPath(directory), "utf8"), before);
});

test("会话锁在任务失败后释放，下一任务仍能执行", async (t) => {
  const session = new Session("test", workspace(t));
  await assert.rejects(session.withTurnLock(async () => { throw new Error("预期失败"); }), /预期失败/);
  assert.equal(await session.withTurnLock(async () => "后续执行"), "后续执行");
});

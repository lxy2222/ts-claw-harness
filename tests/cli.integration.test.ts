import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));

test("CLI 通过本地流式接口完成读取→编辑→读回，并跨进程恢复会话", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tiny-claw-integration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "sample.txt"), "before\n");
  let requests = 0;
  const snapshots: { role: string; content?: string; tool_call_id?: string }[][] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { stream?: boolean; messages: typeof snapshots[number] };
    snapshots.push(body.messages);
    requests++;
    assert.equal(body.stream, true);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta: unknown, finishReason: string | null) => {
      res.write(`data: ${JSON.stringify({ id: `local-${requests}`, object: "chat.completion.chunk", created: 1,
        model: "local-test", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
    };
    const tool = requests === 1
      ? { name: "read_file", args: { path: "sample.txt" } }
      : requests === 2
        ? { name: "edit_file", args: { path: "sample.txt", old_text: "before", new_text: "after" } }
        : requests === 3 ? { name: "read_file", args: { path: "sample.txt" } } : undefined;
    if (tool) {
      send({ tool_calls: [{ index: 0, id: `call-${requests}`, type: "function", function: {
        name: tool.name, arguments: JSON.stringify(tool.args),
      } }] }, null);
      send({}, "tool_calls");
    } else {
      send({ content: requests === 4 ? "已读回确认 after" : "会话历史已恢复" }, null);
      send({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const env = { ...process.env, LLM_API_KEY: "local-test-key", LLM_MODEL: "local-test",
    LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1` };
  const args = ["--import", import.meta.resolve("tsx/esm"), cli, "--session", "integration"];
  const first = await exec(process.execPath, [...args, "读取 sample.txt，将 before 改成 after，再读回确认"], {
    cwd: dir, env, timeout: 15_000,
  });
  assert.match(first.stdout, /已读回确认 after/);
  assert.equal(readFileSync(path.join(dir, "sample.txt"), "utf8"), "after\n");
  assert.equal(requests, 4);
  const second = await exec(process.execPath, [...args, "继续上次对话"], { cwd: dir, env, timeout: 15_000 });
  assert.match(second.stdout, /会话历史已恢复/);
  assert.ok(snapshots.at(-1)!.some((m) => m.role === "tool" && m.content === "after\n"));
  const messages = readFileSync(path.join(dir, ".claw/sessions/integration.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(messages.filter((m) => m.role === "user" && !m.toolCallId).length, 2);
});

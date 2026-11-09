import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";

import { OpenAIProvider } from "../src/provider/openai";
import { Role, type Message } from "../src/types/message";

const messages: Message[] = [{ role: Role.User, content: "你好" }];
const context = () => ({ signal: new AbortController().signal, requestId: "local-test" });

interface StubRequest {
  body: Record<string, unknown>;
  request: IncomingMessage;
  response: ServerResponse;
}

async function withStub(
  handler: (input: StubRequest) => void | Promise<void>,
  check: (provider: OpenAIProvider, requests: StubRequest[]) => Promise<void>,
): Promise<void> {
  const requests: StubRequest[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part.toString();
    const input = { body: JSON.parse(body) as Record<string, unknown>, request, response };
    requests.push(input);
    try {
      await handler(input);
    } catch {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 500, message: "本地测试服务处理失败" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const provider = new OpenAIProvider({
    apiKey: "local-test-placeholder",
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    model: "本地测试模型",
  });
  try {
    await check(provider, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function startStream(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
}

function chunk(
  response: ServerResponse,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): void {
  response.write(`data: ${JSON.stringify({
    id: "本地流",
    object: "chat.completion.chunk",
    created: 0,
    model: "本地测试模型",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`);
}

function endStream(response: ServerResponse): void {
  response.end("data: [DONE]\n\n");
}

function complete(response: ServerResponse, message: Record<string, unknown>, finishReason = "stop"): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id: "本地普通响应",
    object: "chat.completion",
    created: 0,
    model: "本地测试模型",
    choices: [{ index: 0, message, finish_reason: finishReason }],
  }));
}

test("正文增量在响应结束前送达，内部推理只在完整消息中保留", { timeout: 5_000 }, async () => {
  let firstDelta: (() => void) | undefined;
  const observed = new Promise<void>((resolve) => { firstDelta = resolve; });
  let serverFinished = false;
  await withStub(async ({ response }) => {
    startStream(response);
    chunk(response, { reasoning_content: "内部" });
    chunk(response, { content: "你" });
    await observed;
    chunk(response, { reasoning_content: "推理", content: "好" });
    chunk(response, {}, "stop");
    serverFinished = true;
    endStream(response);
  }, async (provider, requests) => {
    const deltas: string[] = [];
    const message = await provider.generate(context(), messages, [], {
      onTextDelta(text) {
        if (deltas.length === 0) {
          assert.equal(serverFinished, false);
          firstDelta?.();
        }
        deltas.push(text);
      },
    });
    assert.deepEqual(deltas, ["你", "好"]);
    assert.deepEqual(message, {
      role: Role.Assistant, content: "你好", reasoningContent: "内部推理", toolCalls: [],
    });
    assert.equal(requests[0]?.body.stream, true);
    assert.equal(requests[0]?.body.tools, undefined);
    assert.equal(requests[0]?.request.headers["x-request-id"], "local-test");
  });
});

test("按 index 组装交错的多工具调用，名称、标识和参数都支持分片", async () => {
  await withStub(({ response }) => {
    startStream(response);
    chunk(response, { content: "正在处理", tool_calls: [
      { index: 1, id: "call_2", type: "function", function: { name: "write_file", arguments: '{"content":' } },
      { index: 0, id: "call_", type: "function", function: { name: "read_", arguments: '{"pa' } },
    ] });
    chunk(response, { tool_calls: [
      { index: 0, id: "1", function: { name: "file", arguments: 'th":"说明.md"}' } },
      { index: 1, function: { arguments: '"你好"}' } },
    ] });
    chunk(response, {}, "tool_calls");
    response.write(`data: ${JSON.stringify({ choices: [], usage: { total_tokens: 20 } })}\n\n`);
    endStream(response);
  }, async (provider, requests) => {
    const deltas: string[] = [];
    const message = await provider.generate(context(), messages, [{
      name: "read_file", description: "读取文件", inputSchema: { type: "object" },
    }], { onTextDelta: (text) => deltas.push(text) });
    assert.deepEqual(deltas, ["正在处理"]);
    assert.deepEqual(message.toolCalls, [
      { id: "call_1", name: "read_file", arguments: '{"path":"说明.md"}' },
      { id: "call_2", name: "write_file", arguments: '{"content":"你好"}' },
    ]);
    assert.equal((requests[0]?.body.tools as unknown[])?.length, 1);
  });
});

test("不提供回调保持普通请求，消息、工具结果和 DeepSeek 推理按原协议转换", async () => {
  await withStub(({ response }) => complete(response, {
    role: "assistant", content: null, reasoning_content: "保留推理",
    tool_calls: [{ id: "call_new", type: "function", function: { name: "bash", arguments: '{"command":"pwd"}' } }],
  }, "tool_calls"), async (provider, requests) => {
    const message = await provider.generate(context(), [
      { role: Role.System, content: "系统要求" },
      ...messages,
      { role: Role.Assistant, content: "", reasoningContent: "前次推理", toolCalls: [{ id: "call_old", name: "bash", arguments: "{}" }] },
      { role: Role.User, toolCallId: "call_old", content: "工具结果" },
    ]);
    assert.deepEqual(message, {
      role: Role.Assistant, content: "", reasoningContent: "保留推理",
      toolCalls: [{ id: "call_new", name: "bash", arguments: '{"command":"pwd"}' }],
    });
    assert.equal(requests[0]?.body.stream, undefined);
    const sent = requests[0]?.body.messages as Record<string, unknown>[];
    assert.equal(sent[2]?.reasoning_content, "前次推理");
    assert.deepEqual(sent[3], { role: "tool", tool_call_id: "call_old", content: "工具结果" });
  });
});

test("请求前取消不会发送 HTTP，普通和流式模式均适用", async () => {
  await withStub(({ response }) => complete(response, { role: "assistant", content: "不应到达" }), async (provider, requests) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(provider.generate({ signal: controller.signal }, messages), /模型请求已取消/);
    await assert.rejects(provider.generate({ signal: controller.signal }, messages, [], { onTextDelta() {} }), /模型请求已取消/);
    assert.equal(requests.length, 0);
  });
});

test("流中取消返回中文错误，不返回部分工具调用", { timeout: 5_000 }, async () => {
  await withStub(({ response }) => {
    startStream(response);
    chunk(response, { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":' } }] });
    chunk(response, { content: "部分正文" });
    // 保持连接开启，直到客户端取消；不能提前发完成标记。
  }, async (provider) => {
    const controller = new AbortController();
    const deltas: string[] = [];
    await assert.rejects(provider.generate({ signal: controller.signal }, messages, [], {
      onTextDelta(text) { deltas.push(text); controller.abort(); },
    }), /模型请求已取消/);
    assert.deepEqual(deltas, ["部分正文"]);
  });
});

for (const doneMarker of [false, true]) {
  test(`缺少 finish_reason 的截断必须拒绝${doneMarker ? "，即使收到 DONE" : ""}`, async () => {
    await withStub(({ response }) => {
      startStream(response);
      chunk(response, { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":' } }] });
      if (doneMarker) endStream(response);
      else response.end();
    }, async (provider) => {
      await assert.rejects(provider.generate(context(), messages, [], { onTextDelta() {} }), /未收到完成标记/);
    });
  });
}

for (const reason of ["length", "content_filter"]) {
  test(`流式和普通响应均明确拒绝 ${reason}`, async () => {
    await withStub(({ body, response }) => {
      if (body.stream) {
        startStream(response);
        chunk(response, {}, reason);
        endStream(response);
      } else complete(response, { role: "assistant", content: "不完整输出" }, reason);
    }, async (provider) => {
      const expected = reason === "length" ? /长度上限/ : /内容过滤/;
      await assert.rejects(provider.generate(context(), messages, [], { onTextDelta() {} }), expected);
      await assert.rejects(provider.generate(context(), messages), expected);
    });
  });
}

test("有完成标记但工具参数仍不完整时也拒绝返回", async () => {
  await withStub(({ response }) => {
    startStream(response);
    chunk(response, { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":' } }] });
    chunk(response, {}, "tool_calls");
    endStream(response);
  }, async (provider) => {
    await assert.rejects(provider.generate(context(), messages, [], { onTextDelta() {} }), /不是完整的 JSON/);
  });
});

test("工具调用缺少名称时拒绝返回，避免执行不完整调用", async () => {
  await withStub(({ response }) => {
    startStream(response);
    chunk(response, { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { arguments: "{}" } }] });
    chunk(response, {}, "tool_calls");
    endStream(response);
  }, async (provider) => {
    await assert.rejects(provider.generate(context(), messages, [], { onTextDelta() {} }), /缺少标识或名称/);
  });
});

test("服务端英文错误转换为中文，原始错误通过 cause 保留", async () => {
  await withStub(({ response }) => {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Invalid request", type: "invalid_request_error" } }));
  }, async (provider) => {
    await assert.rejects(provider.generate(context(), messages), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "模型服务请求失败（HTTP 400）");
      assert.ok(error.cause instanceof Error);
      return true;
    });
  });
});

test("流式推理和完整工具调用可以原样进入下一次请求", async () => {
  await withStub(({ body, response }) => {
    if (body.stream) {
      startStream(response);
      chunk(response, { reasoning_content: "需要读取文件" });
      chunk(response, { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"说明.md"}' } }] });
      chunk(response, {}, "tool_calls");
      endStream(response);
    } else complete(response, { role: "assistant", content: "读取完毕" });
  }, async (provider, requests) => {
    const generated = await provider.generate(context(), messages, [], { onTextDelta() {} });
    await provider.generate(context(), [
      ...messages, generated, { role: Role.User, toolCallId: "call_1", content: "文件内容" },
    ]);
    const sent = requests[1]?.body.messages as Record<string, unknown>[];
    assert.equal(sent[1]?.reasoning_content, "需要读取文件");
    assert.deepEqual(sent[1]?.tool_calls, [{
      id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"说明.md"}' },
    }]);
  });
});

test("配置错误使用中文", () => {
  assert.throws(() => new OpenAIProvider({ apiKey: "" }), /密钥不能为空/);
  assert.throws(() => OpenAIProvider.fromEnv({}), /环境变量 LLM_API_KEY 未设置/);
});

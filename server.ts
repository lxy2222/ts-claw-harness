import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

/**
 * 统一响应体结构。
 * 依据工作区规范：所有 API 返回 JSON，且必须包含 code 与 message 字段。
 * 错误场景下 message 一律使用中文，禁止英文抛错。
 */
type ApiResponse = {
  code: number;
  message: string;
  data?: unknown;
};

type ApiResult = {
  httpStatus: number;
  body: ApiResponse;
};

const startedAt = Date.now();

/** 统一的 JSON 出口，避免各处手写响应头导致格式不一致。 */
const sendJson = (res: ServerResponse, httpStatus: number, body: ApiResponse): void => {
  const payload = JSON.stringify(body);
  res.statusCode = httpStatus;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.end(payload);
};

/** 健康检查：返回服务状态与已运行秒数。 */
const buildHealthResult = (): ApiResult => ({
  httpStatus: 200,
  body: {
    code: 0,
    message: "健康检查通过，服务运行正常",
    data: {
      status: "ok",
      uptime: Math.floor((Date.now() - startedAt) / 1000),
    },
  },
});

/** 模拟报错：用于验证统一错误返回格式与中文错误文案。 */
const buildMockErrorResult = (): ApiResult => ({
  httpStatus: 500,
  body: {
    code: 500,
    message: "服务器内部错误：这是一个模拟的异常响应",
  },
});

/** 路由分发：返回结果对象，由调用方统一写出响应，避免分支里漏写 end()。 */
const route = (method: string, pathname: string): ApiResult => {
  if (method !== "GET") {
    return {
      httpStatus: 405,
      body: { code: 405, message: "不支持的请求方法：仅允许 GET 请求" },
    };
  }

  // TODO: 鉴权逻辑待实现（沿用原 server.ts 的待办意图）。
  // 未通过鉴权时应返回：{ code: 401, message: "未提供有效的身份凭证，拒绝访问" }

  if (pathname === "/health") {
    return buildHealthResult();
  }

  if (pathname === "/error") {
    return buildMockErrorResult();
  }

  return {
    httpStatus: 404,
    body: { code: 404, message: `请求的接口不存在：${pathname}` },
  };
};

const handleRequest = (req: IncomingMessage, res: ServerResponse): void => {
  try {
    const method = req.method ?? "GET";
    const fullPath = req.url ?? "/";
    // noUncheckedIndexedAccess 开启，索引结果必须兜底
    const pathname = fullPath.split("?")[0] ?? "/";

    const result = route(method, pathname);
    sendJson(res, result.httpStatus, result.body);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "未知错误";
    sendJson(res, 500, {
      code: 500,
      message: `服务器内部错误：处理请求时发生异常（${reason}）`,
    });
  }
};

const server = createServer((req: IncomingMessage, res: ServerResponse): void => {
  handleRequest(req, res);
});

// 兜底：任何未被捕获的异常都以中文输出，避免出现英文错误栈文案。
process.on("uncaughtException", (error: Error): void => {
  console.error(`未捕获的异常，服务即将退出：${error.message}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason: unknown): void => {
  const detail = reason instanceof Error ? reason.message : "未知原因";
  console.error(`未处理的异步拒绝：${detail}`);
});

const port = Number(process.env.PORT ?? "3000");
if (Number.isNaN(port) || port <= 0 || port > 65535) {
  console.error("端口配置有误：环境变量 PORT 必须是 1-65535 之间的整数");
  process.exit(1);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  server.listen(port, (): void => {
    console.log(`服务已启动：http://127.0.0.1:${port}（健康检查 /health，模拟报错 /error）`);
  });
}

export { server, handleRequest, route };

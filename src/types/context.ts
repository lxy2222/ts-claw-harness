/** 对应 Go 的 context.Context:贯穿一次调用链的取消信号与请求元信息 */
export interface Context {
  signal: AbortSignal;
  requestId?: string;
}

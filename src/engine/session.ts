import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { Role, type Message } from "../types/message";

const UNRECORDED_TOOL_RESULT =
  "执行结果未记录，请先检查副作用，禁止自动重复执行。此记录仅补齐会话协议，不代表工具未执行。";

function validateSessionId(id: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error("会话标识不能为空，且只能包含英文字母、数字、下划线和短横线");
  }
}

function canonicalWorkspace(workDir: string): string {
  try {
    const resolved = realpathSync(path.resolve(workDir));
    if (!statSync(resolved).isDirectory()) {
      throw new Error("工作区不是目录");
    }
    return resolved;
  } catch (error) {
    throw new Error("无法访问会话工作区，请确认目录存在且可读取", { cause: error });
  }
}

function validateMessage(value: unknown): asserts value is Message {
  if (!value || typeof value !== "object") {
    throw new Error("消息必须是有效对象");
  }
  const msg = value as Record<string, unknown>;
  if (
    ![Role.System, Role.User, Role.Assistant].includes(msg.role as Message["role"]) ||
    typeof msg.content !== "string" ||
    (msg.reasoningContent !== undefined && typeof msg.reasoningContent !== "string")
  ) {
    throw new Error("消息角色、正文或推理字段格式无效");
  }
  if (
    msg.toolCallId !== undefined &&
    (msg.role !== Role.User || typeof msg.toolCallId !== "string" || !msg.toolCallId)
  ) {
    throw new Error("工具结果必须包含有效的调用标识，且使用用户消息角色");
  }
  if (msg.toolCalls !== undefined) {
    if (msg.role !== Role.Assistant || !Array.isArray(msg.toolCalls)) {
      throw new Error("工具调用列表必须属于助手消息");
    }
    const ids = new Set<string>();
    for (const call of msg.toolCalls) {
      if (
        !call || typeof call !== "object" ||
        typeof call.id !== "string" || !call.id || ids.has(call.id) ||
        typeof call.name !== "string" || !call.name ||
        typeof call.arguments !== "string"
      ) {
        throw new Error("工具调用的标识、名称或参数格式无效，或调用标识重复");
      }
      ids.add(call.id);
    }
  }
}

/** 尾部未完成的工具组允许稍后补齐；孤儿结果和穿插的普通消息不可发送给模型。 */
function pendingToolResults(messages: Message[]): string[] {
  const pending = new Set<string>();
  for (const message of messages) {
    validateMessage(message);
    if (message.toolCallId !== undefined) {
      if (!pending.delete(message.toolCallId)) {
        throw new Error("会话记录包含孤立或重复的工具结果");
      }
      continue;
    }
    if (pending.size > 0) {
      throw new Error("会话工具调用记录不连续：结果尚未补齐就出现了其他消息");
    }
    for (const call of message.toolCalls ?? []) {
      pending.add(call.id);
    }
  }
  return [...pending];
}

/**
 * 异步互斥锁（对应 Go 的 sync.Mutex / OpenClaw 的 Session Lane 串行化队列）。
 *
 * 为什么在单线程的 Node.js 中仍然需要锁？
 * 1. JS 同步代码不会发生多线程 CPU Data Race，但 Agent 的一轮对话（Turn）是跨多个 await 的异步过程；
 * 2. 如果同一个 sessionId 同时收到两条消息（例如飞书群聊连发、多终端并发调用），
 *    没有异步锁会导致两个 ReAct 循环交替往同一个 Session append 消息，造成上下文错乱。
 */
class AsyncMutex {
  private queue: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.queue;
    this.queue = prev.then(() => next);

    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * Session 代表了一次持续的人机交互过程，负责维护该会话的完整历史与物理落盘。
 */
export class Session {
  public readonly id: string;
  /** 该会话绑定的物理工作区 */
  public readonly workDir: string;
  public readonly createdAt: Date;
  public updatedAt: Date;

  /** 存放此 Session 中所有的用户输入、大模型回复和工具调用结果（不包含动态生成的 System Prompt） */
  private history: Message[] = [];
  /** 会话级异步串行锁（参考 OpenClaw Lane 设计，确保同一会话不会并发执行多个 Turn） */
  private readonly turnLock = new AsyncMutex();
  /** JSONL 物理持久化文件路径：workDir/.claw/sessions/<id>.jsonl */
  private readonly persistPath: string;
  private needsLineBreak = false;

  /** 可观测性统计：累计输入（Prompt）Token 数量 */
  public totalPromptTokens = 0;
  /** 可观测性统计：累计大模型输出（Completion）Token 数量 */
  public totalCompletionTokens = 0;
  /** 可观测性统计：累计输入提示词的 Token 费用（元/RMB 或 USD） */
  public totalInputCost = 0;
  /** 可观测性统计：累计大模型输出的 Token 费用（元/RMB 或 USD） */
  public totalOutputCost = 0;
  /** 可观测性统计：累计大模型推理总耗时（毫秒） */
  public totalDurationMs = 0;

  constructor(id: string, workDir: string) {
    validateSessionId(id);
    this.id = id;
    this.workDir = canonicalWorkspace(workDir);
    this.createdAt = new Date();
    this.updatedAt = new Date();

    this.persistPath = path.join(this.workDir, ".claw", "sessions", `${id}.jsonl`);
    this.loadFromDisk();
  }

  /**
   * 在会话专属的串行通道（Lane）中执行异步任务，防止同一 Session 并发跑 ReAct 循环
   */
  async withTurnLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.turnLock.runExclusive(fn);
  }

  /**
   * 向 Session 中追加消息，并实时以 JSONL 格式追加落盘（Append-only Log）
   */
  append(...msgs: Message[]): void {
    if (msgs.length === 0) {
      return;
    }
    // 深拷贝存入，防止外部持有引用后意外篡改历史
    let cloned: Message[];
    try {
      cloned = msgs.map((m) => structuredClone(m));
      pendingToolResults([...this.history, ...cloned]);
    } catch (error) {
      throw new Error("无法追加会话消息：消息格式或工具调用顺序无效", { cause: error });
    }
    // 写盘失败必须对调用方可见，不能先修改内存制造已保存的假象。
    this.appendToDisk(cloned);
    this.history.push(...cloned);
    this.updatedAt = new Date();
  }

  /**
   * limit 是消息数量的软目标：以完整用户回合为边界，至少保留最新任务及其后续工具组。
   * 单个回合过长时交给 Compactor 处理，不能直接切碎调用/结果协议。
   */
  getWorkingMemory(limit: number): Message[] {
    if (!Number.isFinite(limit) || !Number.isInteger(limit)) {
      throw new Error("工作记忆消息数量必须是有限整数");
    }
    let start = 0;
    if (limit > 0 && this.history.length > limit) {
      const target = this.history.length - limit;
      // 从目标位置向前寻找任务边界；找不到则保留完整历史。
      for (let i = target; i >= 0; i--) {
        const message = this.history[i];
        if (message?.role === Role.User && message.toolCallId === undefined) {
          start = i;
          break;
        }
      }
    }
    return this.history.slice(start).map((message) => structuredClone(message));
  }

  /** 获取当前会话历史总条数 */
  size(): number {
    return this.history.length;
  }

  /**
   * 累加一次大模型推理的 Token 消耗、费用与耗时统计
   */
  recordMetrics(
    promptTokens: number,
    completionTokens: number,
    inputCost: number,
    outputCost: number,
    durationMs: number = 0,
  ): void {
    this.totalPromptTokens += promptTokens;
    this.totalCompletionTokens += completionTokens;
    this.totalInputCost += inputCost;
    this.totalOutputCost += outputCost;
    this.totalDurationMs += durationMs;
    this.updatedAt = new Date();
  }

  /**
   * 获取当前 Session 的累计可观测性账单摘要
   */
  getMetricsSummary(): {
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    totalInputCost: number;
    totalOutputCost: number;
    totalCost: number;
    totalDurationMs: number;
  } {
    return {
      totalPromptTokens: this.totalPromptTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      totalTokens: this.totalPromptTokens + this.totalCompletionTokens,
      totalInputCost: this.totalInputCost,
      totalOutputCost: this.totalOutputCost,
      totalCost: this.totalInputCost + this.totalOutputCost,
      totalDurationMs: this.totalDurationMs,
    };
  }

  /**
   * 启动时从 .claw/sessions/<id>.jsonl 恢复已有会话历史
   */
  private loadFromDisk(): void {
    if (!existsSync(this.persistPath)) {
      return;
    }
    try {
      const raw = readFileSync(this.persistPath, "utf8");
      const messages: Message[] = [];
      const lines = raw.split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (!line.trim()) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          validateMessage(parsed);
          messages.push(parsed);
        } catch (error) {
          throw new Error(`会话记录第 ${index + 1} 行损坏或格式无效`, { cause: error });
        }
      }
      const missingResults = pendingToolResults(messages);
      this.needsLineBreak = raw.length > 0 && !raw.endsWith("\n");
      const recovered: Message[] = missingResults.map((toolCallId) => ({
        role: Role.User,
        content: UNRECORDED_TOOL_RESULT,
        toolCallId,
      }));
      if (recovered.length > 0) {
        // 只记录执行结果未知，绝不根据历史自动重新执行工具。
        this.appendToDisk(recovered);
      }
      this.history = [...messages, ...recovered];
      if (this.history.length > 0) {
        console.log(
          `[Session:${this.id}] 从物理磁盘恢复了 ${this.history.length} 条历史记录 (${this.persistPath})`,
        );
      }
    } catch (error) {
      throw new Error("会话历史恢复失败，原记录已保留；请检查损坏记录或读写权限后重试", {
        cause: error,
      });
    }
  }

  /**
   * 将新增消息以 JSONL (JSON Lines) 追加写入磁盘
   */
  private appendToDisk(msgs: Message[]): void {
    try {
      mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const lines = `${this.needsLineBreak ? "\n" : ""}${msgs.map((m) => JSON.stringify(m)).join("\n")}\n`;
      appendFileSync(this.persistPath, lines, "utf8");
      this.needsLineBreak = false;
    } catch (error) {
      throw new Error("会话记录写入失败，消息未保存；请检查磁盘空间和目录权限", { cause: error });
    }
  }
}

// ==========================================
// 全局 Session Manager: 用于多用户/多终端隔离
// ==========================================

export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  /**
   * 获取或创建一个会话
   */
  getOrCreate(id: string, workDir: string): Session {
    validateSessionId(id);
    const workspace = canonicalWorkspace(workDir);
    const key = `${workspace}\0${id}`;
    const existing = this.sessions.get(key);
    if (existing) {
      return existing;
    }
    const sess = new Session(id, workspace);
    this.sessions.set(key, sess);
    return sess;
  }

  /**
   * 获取已有会话
   */
  get(id: string, workDir?: string): Session | undefined {
    validateSessionId(id);
    if (workDir !== undefined) {
      return this.sessions.get(`${canonicalWorkspace(workDir)}\0${id}`);
    }
    const matches = [...this.sessions.values()].filter((session) => session.id === id);
    if (matches.length > 1) {
      throw new Error("多个工作区存在相同会话标识，请同时指定工作区");
    }
    return matches[0];
  }
}

export const globalSessionMgr = new SessionManager();

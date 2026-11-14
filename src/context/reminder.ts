import { Role, type Message, type ToolCall, type ToolResult } from "../types/message";

export const DEFAULT_MAX_REPEATED_FAILURES = 3;

/**
 * Reminder (行为干预与死循环检测器)
 * 负责监控 Agent 是否在同一个工具+相同参数上反复失败，并在达到阈值时注入高权重的 Role.User 元认知干预指令。
 */
export class Reminder {
  /** 记录 [工具调用唯一指纹 -> 连续失败次数] */
  private readonly failureCounts = new Map<string, number>();

  constructor(private readonly maxFailures: number = DEFAULT_MAX_REPEATED_FAILURES) {}

  /**
   * 1. 生成工具调用的唯一指纹（用来判断大模型是否在重复相同的工作）
   * 对 JSON 参数做 Key 排序归一化，防止模型仅因为多加了一个空格或调整了字段顺序而绕过死循环检测
   */
  buildFingerprint(call: ToolCall): string {
    const rawArgs = call.arguments.trim();
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const sortedKeys = Object.keys(parsed).sort();
        const normalized: Record<string, unknown> = {};
        for (const k of sortedKeys) {
          normalized[k] = (parsed as Record<string, unknown>)[k];
        }
        return `${call.name}:${JSON.stringify(normalized)}`;
      }
    } catch {
      // 非标准 JSON 时回退到原始字符串拼接
    }
    return `${call.name}:${rawArgs}`;
  }

  /**
   * 2 & 3 & 4. 分析本轮工具调用与执行结果：
   * - 如果 Agent 在这条路走通了（!result.isError），清空所有的失败计数器，返回 null
   * - 如果失败且未达阈值，累加该特征的失败次数，返回 null
   * - 如果失败达到或超过阈值，构造一条严厉的 Role.User 行动指南返回，利用近因效应强行唤醒模型元认知
   */
  analyzeAndRemind(call: ToolCall, result: ToolResult): Message | null {
    // 2. 如果 Agent 在当前工具路径上走通了，清除该工具的失败计数
    if (!result.isError) {
      const fingerprint = this.buildFingerprint(call);
      this.failureCounts.delete(fingerprint);
      return null;
    }

    // 3. 如果失败，生成唯一指纹并累加失败次数
    const fingerprint = this.buildFingerprint(call);
    const count = (this.failureCounts.get(fingerprint) ?? 0) + 1;
    this.failureCounts.set(fingerprint, count);

    console.log(`[Reminder] 监控到工具 ${call.name} 执行失败，该参数特征连续失败次数: ${count}`);

    // 失败次数尚未达到阈值时，暂不触发系统级死循环干预
    if (count < this.maxFailures) {
      return null;
    }

    console.log("[Reminder] ⚠️ 触发死循环干预！注入强力修正指令。");

    // 4. 达到或超过失败次数阈值，构造极其严厉的元认知行动指南，且 role 必须为 user 以保证近因效应权重
    const content = [
      "🚨 [系统级元认知干预 / 死循环警告]:",
      `你似乎陷入了死循环。你刚刚连续 ${count} 次使用相同的参数调用了 '${call.name}' 工具，并且都失败了。请立即停止这种无效的重试！你的注意力被当前的报错过度吸引了。你需要：`,
      "1. 停止猜测参数。跳出当前的局部思维。",
      "2. 彻底改变你的策略。",
      "3. 如果你确实无法通过系统工具解决当前问题，请直接结束任务并向用户说明你需要什么人工帮助，而不是继续盲目消耗 API 资源尝试。",
    ].join("\n");

    return {
      role: Role.User,
      content,
    };
  }

  /**
   * 重置所有失败计数器（在新会话或新一轮独立任务开始时调用）
   */
  reset(): void {
    this.failureCounts.clear();
  }
}

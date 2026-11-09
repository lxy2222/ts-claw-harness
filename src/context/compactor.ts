import { Role, type Message } from "../types/message";

/**
 * 按字符估算缩减可折叠的历史内容。这不是 token 计数，也不保证进程内存或模型窗口安全。
 */
export class Compactor {
  /**
   * @param maxChars 字符估算预算；保护字段本身超预算时明确拒绝请求
   * @param retainLastMsgs Working Memory 保护区：保留最近的 N 条消息不做全量掩码
   */
  constructor(
    public readonly maxChars: number,
    public readonly retainLastMsgs: number,
  ) {
    if (!Number.isInteger(maxChars) || maxChars <= 0) {
      throw new Error("上下文字符预算必须是正整数");
    }
    if (!Number.isInteger(retainLastMsgs) || retainLastMsgs < 0) {
      throw new Error("上下文保护消息数量必须是非负整数");
    }
  }

  /**
   * 接收准备发送给大模型的消息数组。
   * 如果总长度超标，对远期历史区进行全量掩码 (Full Masking)，对短期保护区进行超长局部掐头去尾截断 (Head-Tail Truncation)。
   */
  compact(msgs: Message[]): Message[] {
    const currentLength = this.estimateLength(msgs);

    // 如果没有超过水位线，直接返回原数组（大多数情况下的快速路径）
    if (currentLength <= this.maxChars) {
      return structuredClone(msgs);
    }

    console.log(
      `[Compactor] 当前上下文估算 ${currentLength} 字符，超过预算 ${this.maxChars}，开始折叠历史内容...`,
    );

    const compacted: Message[] = [];
    const msgCount = msgs.length;

    // 计算受保护的 Working Memory 起始索引
    const protectStartIndex = Math.max(0, msgCount - this.retainLastMsgs);

    for (let i = 0; i < msgCount; i++) {
      const msg = msgs[i];
      if (!msg) {
        continue;
      }

      // 系统提示词原样保留，仍复制以避免返回值与输入共享引用。
      if (msg.role === Role.System) {
        compacted.push(structuredClone(msg));
        continue;
      }

      // 深拷贝一份新消息，避免在并发环境中直接修改原引用污染 Session 内部历史
      const newMsg: Message = structuredClone(msg);
      const isInWorkingMemory = i >= protectStartIndex;

      // 【核心驾驭逻辑】：双重降级防线
      if (msg.role === Role.User && Boolean(msg.toolCallId)) {
        // 对于工具的返回结果 (Observation / ToolResult)
        if (!isInWorkingMemory) {
          // 【第一道防线：远期历史】如果是早期对话，执行无情替换 (Full Masking)
          if (msg.content.length > 200) {
            newMsg.content = `...[为了节省内存，早期的工具输出已被系统强制清理。原始长度: ${msg.content.length} 字符]...`;
          }
        } else {
          // 近期工具输出保留首尾，结构和关联标识不能截断。
          // 保留前 500 字符和后 500 字符（掐头去尾法，大模型通常只需要看开头报错和结尾总结）
          const maxKeep = 1000;
          if (msg.content.length > maxKeep) {
            const head = msg.content.slice(0, 500);
            const tail = msg.content.slice(msg.content.length - 500);
            newMsg.content = `${head}\n\n...[内容过长，中间 ${msg.content.length - maxKeep} 字符已被系统截断]...\n\n${tail}`;
          }
        }
      } else if (msg.role === Role.Assistant && msg.content !== "") {
        // 对于大模型的冗长推理过程 (Thinking Trace / 长回复)
        if (!isInWorkingMemory && msg.content.length > 200) {
          newMsg.content = "...[早期的推理思考过程已折叠]...";
        }
      }

      // 注意：我们绝不会去动 newMsg.toolCalls，因为这是模型行动的证据，也是维持 OpenAI/DeepSeek API tool_call_id 配对合法性的关键！
      compacted.push(newMsg);
    }

    const newLength = this.estimateLength(compacted);
    if (newLength > this.maxChars) {
      throw new Error(
        `上下文超出字符估算预算：折叠后仍为 ${newLength} 字符，预算为 ${this.maxChars}。` +
          "系统提示、用户任务、工具参数和推理协议必须保留，请缩短输入或调整预算。",
      );
    }
    console.log(
      `[Compactor] 历史折叠完成，字符估算从 ${currentLength} 降至 ${newLength}。`,
    );

    return compacted;
  }

  /**
   * 粗略计算当前上下文的总字符长度（涵盖 content、reasoningContent 以及 toolCalls 参数）
   */
  estimateLength(msgs: Message[]): number {
    let length = 0;
    for (const msg of msgs) {
      length += msg.content.length;
      if (msg.reasoningContent) {
        length += msg.reasoningContent.length;
      }
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          length += tc.name.length + tc.arguments.length;
        }
      }
    }
    return length;
  }
}

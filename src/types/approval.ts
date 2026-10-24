/** 一次需要人类确认的操作 */
export interface ApprovalRequest {
  /** 发起审批的工具名,例如 "bash" */
  toolName: string;
  /** 为什么需要审批,例如 "rm -rf 递归强制删除" */
  reason: string;
  /** 待执行操作的原文,例如完整的 bash 命令 */
  detail: string;
}

/** 审批通道:CLI 与飞书各自实现,tools 只依赖这个接口 */
export interface ApprovalChannel {
  /** 返回 true 表示用户允许执行 */
  ask(request: ApprovalRequest): Promise<boolean>;
}

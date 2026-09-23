import type { WorkflowRole, WorkflowTaskStatus } from "../../protocol";

export interface StatusMeta {
  label: string;
  color: string;
  /** 边（依赖线）使用的颜色。 */
  edge: string;
  /** 是否需要流动动画（running）。 */
  pulse: boolean;
}

const ROLE_LABEL: Record<WorkflowRole, string> = {
  planner: "规划",
  coder: "编码",
  tester: "测试",
  reviewer: "评审",
};

export function roleLabel(role: WorkflowRole): string {
  return ROLE_LABEL[role];
}

const STATUS_META: Record<WorkflowTaskStatus, StatusMeta> = {
  pending: { label: "等待", color: "#8b8fa3", edge: "#3d4152", pulse: false },
  running: { label: "运行中", color: "#3b82f6", edge: "#3b82f6", pulse: true },
  succeeded: { label: "成功", color: "#22c55e", edge: "#22c55e", pulse: false },
  failed: { label: "失败", color: "#ef4444", edge: "#ef4444", pulse: false },
  blocked: { label: "阻塞", color: "#f59e0b", edge: "#f59e0b", pulse: false },
  cancelled: { label: "已取消", color: "#a1a1aa", edge: "#52525b", pulse: false },
  timed_out: { label: "超时", color: "#f97316", edge: "#f97316", pulse: false },
  rejected: { label: "驳回", color: "#ec4899", edge: "#ec4899", pulse: false },
};

export function statusMeta(status: WorkflowTaskStatus): StatusMeta {
  return STATUS_META[status] ?? STATUS_META.pending;
}

/** 边按源节点状态着色；尚未运行（pending）时用目标节点状态。 */
export function edgeColor(from: WorkflowTaskStatus, to: WorkflowTaskStatus): StatusMeta {
  return from !== "pending" ? statusMeta(from) : statusMeta(to);
}

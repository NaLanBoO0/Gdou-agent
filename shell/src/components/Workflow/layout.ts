import type { WorkflowTask } from "../../protocol";

/** 节点卡片尺寸（与 WorkflowGraph.vue 样式保持一致）。 */
export const NODE_WIDTH = 232;
export const NODE_HEIGHT = 96;
export const H_GAP = 88;
export const V_GAP = 28;
const EDGE_BEND = 44;

export interface PlacedTask {
  task: WorkflowTask;
  /** 节点卡片左上角（未缩放的图坐标）。 */
  x: number;
  y: number;
  level: number;
}

export interface PlacedEdge {
  from: string;
  to: string;
  /** 边的 SVG path 描述，从源节点右侧到目标节点左侧。 */
  d: string;
  /** 边的中点（用于状态标签等装饰）。 */
  mid: { x: number; y: number };
}

export interface WorkflowLayout {
  placed: PlacedTask[];
  edges: PlacedEdge[];
  width: number;
  height: number;
}

/** 按依赖计算每层 level；图必须无环（协议侧 validateWorkflowGraph 保证）。 */
function computeLevels(tasks: WorkflowTask[]): Map<string, number> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const level = new Map<string, number>();
  const visit = (id: string): number => {
    const cached = level.get(id);
    if (cached !== undefined) return cached;
    const task = byId.get(id);
    if (!task) return 0;
    const deps = task.dependencies.map(visit);
    const next = deps.length ? Math.max(...deps) + 1 : 0;
    level.set(id, next);
    return next;
  };
  for (const task of tasks) visit(task.id);
  return level;
}

/**
 * 有向无环图的层次布局：同一依赖层级放同一列，列内按任务 id 稳定排序，
 * 避免同一图反复渲染时节点抖动。
 */
export function layoutWorkflow(tasks: WorkflowTask[]): WorkflowLayout {
  const level = computeLevels(tasks);
  const byLevel = new Map<number, WorkflowTask[]>();
  for (const task of tasks) {
    const list = byLevel.get(level.get(task.id) ?? 0) ?? [];
    list.push(task);
    byLevel.set(level.get(task.id) ?? 0, list);
  }
  const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);
  const placed: PlacedTask[] = [];
  const indexInLevel = new Map<string, number>();
  for (const [i, lvl] of sortedLevels.entries()) {
    const column = (byLevel.get(lvl) ?? []).slice().sort((a, b) => a.id.localeCompare(b.id));
    column.forEach((task, j) => {
      indexInLevel.set(task.id, j);
      placed.push({ task, x: i * (NODE_WIDTH + H_GAP), y: j * (NODE_HEIGHT + V_GAP), level: lvl });
    });
  }
  const byId = new Map(placed.map((p) => [p.task.id, p]));
  const edges: PlacedEdge[] = [];
  for (const source of placed) {
    for (const depId of source.task.dependencies) {
      const target = byId.get(depId);
      if (!target) continue;
      const sx = source.x;
      const sy = source.y + NODE_HEIGHT / 2;
      const tx = target.x + NODE_WIDTH;
      const ty = target.y + NODE_HEIGHT / 2;
      const bend = Math.max(EDGE_BEND, Math.abs(tx - sx) * 0.5);
      edges.push({
        from: depId,
        to: source.task.id,
        d: `M ${sx} ${sy} C ${sx - bend} ${sy}, ${tx + bend} ${ty}, ${tx} ${ty}`,
        mid: { x: (sx + tx) / 2, y: (sy + ty) / 2 },
      });
    }
  }
  const width = sortedLevels.length * NODE_WIDTH + (sortedLevels.length - 1) * H_GAP;
  const rowCount = Math.max(...[...byLevel.values()].map((l) => l.length), 1);
  const height = rowCount * NODE_HEIGHT + (rowCount - 1) * V_GAP;
  return { placed, edges, width, height };
}

/** 节点右侧输出端口与左侧输入端口坐标。 */
export function sourcePort(p: PlacedTask): { x: number; y: number } {
  return { x: p.x + NODE_WIDTH, y: p.y + NODE_HEIGHT / 2 };
}
export function targetPort(p: PlacedTask): { x: number; y: number } {
  return { x: p.x, y: p.y + NODE_HEIGHT / 2 };
}

/** 以中点为中心缩放时各坐标在缩放后的新位置（供 fitToView 使用）。 */
export function fitTransform(content: { width: number; height: number }, viewport: { width: number; height: number }): { x: number; y: number; k: number } {
  const pad = 48;
  const vw = Math.max(viewport.width - pad * 2, 1);
  const vh = Math.max(viewport.height - pad * 2, 1);
  const k = Math.min(vw / Math.max(content.width, 1), vh / Math.max(content.height, 1), 1.25);
  return { k, x: (viewport.width - content.width * k) / 2, y: (viewport.height - content.height * k) / 2 };
}

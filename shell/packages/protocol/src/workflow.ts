import type { WorkflowGraph, WorkflowTask, WorkflowTaskStatus } from "./index.js";

const taskPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function normalizeWorkflowPath(value: string): string {
  const raw = value.replace(/\\/g, "/").trim();
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw new Error(`path must stay inside the assigned workspace scope: ${value}`);
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new Error(`path must stay inside the assigned workspace scope: ${value}`);
    parts.push(part);
  }
  return parts.join("/") || ".";
}

export function validateWorkflowGraph(graph: WorkflowGraph): string[] {
  const errors: string[] = [];
  if (!graph.workflow_id || !graph.goal || !graph.planner_summary) errors.push("workflow metadata is required");
  if (!graph.tasks.length) errors.push("workflow must contain at least one task");
  const ids = new Set<string>();
  for (const task of graph.tasks) {
    if (!taskPattern.test(task.id)) errors.push(`invalid task id: ${task.id}`);
    if (ids.has(task.id)) errors.push(`duplicate task id: ${task.id}`);
    ids.add(task.id);
    if (task.completion_criteria.length === 0) errors.push(`task has no completion criteria: ${task.id}`);
    if (task.dependencies.includes(task.id)) errors.push(`task depends on itself: ${task.id}`);
    if (!Number.isInteger(task.depth) || task.depth < 0) errors.push(`invalid depth in ${task.id}`);
    if (!Number.isFinite(task.token_budget) || task.token_budget < 0) errors.push(`invalid token budget in ${task.id}`);
    if (!Number.isFinite(task.time_budget_s) || task.time_budget_s < 0) errors.push(`invalid time budget in ${task.id}`);
    if (task.max_retries !== null && (!Number.isInteger(task.max_retries) || task.max_retries < 0)) errors.push(`invalid max retries in ${task.id}`);
    if (task.owner === "coder" && task.allowed_paths.length === 0) errors.push(`coder task ${task.id} must declare allowed paths`);
    for (const allowedPath of task.allowed_paths) {
      try { normalizeWorkflowPath(allowedPath); } catch { errors.push(`invalid allowed path in ${task.id}: ${allowedPath}`); }
    }
    for (const dependency of task.dependencies) if (!graph.tasks.some((candidate) => candidate.id === dependency)) errors.push(`unknown dependency ${dependency} in ${task.id}`);
  }
  if (errors.length === 0 && hasCycle(graph.tasks)) errors.push("workflow graph contains a cycle");
  return errors;
}

function hasCycle(tasks: WorkflowTask[]): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) if (visit(dependency)) return true;
    visiting.delete(id); visited.add(id); return false;
  };
  return tasks.some((task) => visit(task.id));
}

export function readyTaskIds(tasks: Array<{ id: string; dependencies: string[]; status: WorkflowTaskStatus }>): string[] {
  const status = new Map(tasks.map((task) => [task.id, task.status]));
  return tasks.filter((task) => task.status === "pending" && task.dependencies.every((id) => status.get(id) === "succeeded")).map((task) => task.id);
}

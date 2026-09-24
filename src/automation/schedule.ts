/**
 * Scheduled tasks ("automations").
 *
 * An automation is the recipe the shell's Automation page stores: a name, a
 * prompt, and a time expression. It is deliberately a *concept* of its own, not
 * a session — its runs do not enter the conversation history, and its result is
 * recorded on the task (last_run_at / last_result), so an automation reads as
 * "did the thing at 09:00", not "spawned a chat".
 *
 * Only the storage and the due-time arithmetic live here. The *execution* is
 * the bridge's job: the bridge owns the agent sessions, so it decides when to
 * spawn one, with what permission, and writes the outcome back through
 * `updateTaskResult`. This module stays transport-free so a CLI or a future
 * daemon can reuse the same schedule without dragging in the WebSocket layer.
 *
 * Honesty rules:
 *
 * - **Runtime only.** There is no persistence of "next run" across process
 *   restarts beyond the stored time expression itself. When the bridge is not
 *   running, nothing fires — the UI says this, because a silently-missed
 *   schedule is worse than one that says it did not run.
 * - **Unattended means read-only.** An automation runs with
 *   `{ tier: "read-only", approval: "never" }` unless the caller overrides it.
 *   "Do not ask" must mean "do not do", and an unattended run is exactly the
 *   case where a wide-open gate becomes remote code execution.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_HOME } from "../paths.ts";

/** One stored automation, in the shape the shell's Automation page renders. */
export interface ScheduledTask {
	id: string;
	name: string;
	prompt: string;
	timezone: string;
	schedule_type?: "daily" | "weekly" | "monthly";
	day_of_week: number;
	day_of_month?: number;
	hour: number;
	minute: number;
	status: "active" | "paused" | "failed" | "waiting_authorization";
	missed_run_policy: "run_once" | "skip";
	workspace_id?: string;
	budget?: number;
	next_run_at: string;
	last_run_at?: string;
	last_result?: "completed" | "failed" | "cancelled" | "needs_attention";
	updated_at: string;
}

export type ScheduledTaskDraft = Omit<ScheduledTask, "id" | "updated_at" | "last_run_at" | "last_result"> & { id?: string };

function taskPath(): string {
	return join(AGENT_HOME, "automations.json");
}

/** Read the file; every kind of damage reads as an empty schedule. */
function loadFile(): ScheduledTask[] {
	try {
		const parsed = JSON.parse(readFileSync(taskPath(), "utf-8"));
		if (!Array.isArray(parsed)) return [];
		return parsed as ScheduledTask[];
	} catch {
		return [];
	}
}

/** Write the file atomically (temp + rename), so a crash never halves it. */
function writeFile(tasks: ScheduledTask[]): void {
	const path = taskPath();
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp`;
	writeFileSync(temp, JSON.stringify(tasks, null, 2), "utf-8");
	renameSync(temp, path);
}

/** Every task, unsorted — the caller decides ordering. */
export function listTasks(): ScheduledTask[] {
	return loadFile();
}

export function getTask(id: string): ScheduledTask | undefined {
	return loadFile().find((task) => task.id === id);
}

/**
 * Insert or replace a task.
 *
 * `id` is generated when absent; `updated_at` is always stamped here, so a
 * caller cannot hand in a stale timestamp. The `next_run_at` field is the
 * caller's to compute — it knows the timezone arithmetic — but it is stored
 * verbatim.
 */
export function upsertTask(input: ScheduledTaskDraft): ScheduledTask {
	const tasks = loadFile();
	const existing = input.id ? tasks.find((task) => task.id === input.id) : undefined;
	const task: ScheduledTask = {
		...input,
		id: existing?.id ?? input.id ?? randomUUID(),
		updated_at: new Date().toISOString(),
		last_run_at: existing?.last_run_at,
		last_result: existing?.last_result,
	};
	if (existing) tasks.splice(tasks.indexOf(existing), 1, task);
	else tasks.push(task);
	writeFile(tasks);
	return task;
}

export function deleteTask(id: string): boolean {
	const tasks = loadFile();
	const index = tasks.findIndex((task) => task.id === id);
	if (index < 0) return false;
	tasks.splice(index, 1);
	writeFile(tasks);
	return true;
}

/**
 * Record the outcome of a run.
 *
 * `last_result` is the summary the card shows; the transcript of the run is
 * deliberately *not* stored here — an automation's product is its result, not
 * a chat the user is invited to reopen.
 */
export function updateTaskResult(
	id: string,
	result: NonNullable<ScheduledTask["last_result"]>,
	nextRunAt: string,
): ScheduledTask | undefined {
	const tasks = loadFile();
	const task = tasks.find((item) => item.id === id);
	if (!task) return undefined;
	task.last_result = result;
	task.last_run_at = new Date().toISOString();
	task.next_run_at = nextRunAt;
	task.updated_at = new Date().toISOString();
	writeFile(tasks);
	return task;
}

/**
 * Tasks whose `next_run_at` has passed.
 *
 * The timezone arithmetic happened at save time (the shell computed
 * `next_run_at`); here we only compare instants, so there is no timezone to get
 * wrong. A paused task never fires.
 */
export function dueTasks(now: Date = new Date()): ScheduledTask[] {
	return loadFile().filter((task) => task.status === "active" && task.next_run_at <= now.toISOString());
}

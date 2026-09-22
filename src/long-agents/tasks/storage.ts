import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertFileWithin,
  atomicWriteJson,
  withFileLock,
} from "../../persistence/versioned-file.js";
import { longAgentConfigRoot } from "../storage.js";
import {
  record,
  exact,
  parseTask,
  parseOccurrence,
  type FriendTask,
  type TaskOccurrence,
} from "./contract.js";
export interface TaskState {
  schemaVersion: 1;
  tasks: FriendTask[];
  revisions: FriendTask[];
  occurrences: TaskOccurrence[];
  migration: "pending" | "complete";
}
export function taskFile(home: string, agent: string) {
  return resolve(longAgentConfigRoot(home, agent), "tasks.json");
}
export async function readTaskState(
  home: string,
  agent: string,
): Promise<TaskState> {
  const file = taskFile(home, agent);
  await assertFileWithin(file, home);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT")
      return {
        schemaVersion: 1,
        tasks: [],
        revisions: [],
        occurrences: [],
        migration: "pending",
      };
    throw e;
  }
  record(value);
  exact(value, [
    "schemaVersion",
    "tasks",
    "revisions",
    "occurrences",
    "migration",
  ]);
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.tasks) ||
    !Array.isArray(value.revisions) ||
    !Array.isArray(value.occurrences) ||
    !["pending", "complete"].includes(String(value.migration))
  )
    throw new Error("任务存储格式无效");
  const tasks = value.tasks.map(parseTask),
    revisions = value.revisions.map(parseTask),
    occurrences = value.occurrences.map(parseOccurrence);
  if (
    revisions.some((t) => t.longAgentId !== agent) ||
    new Set(revisions.map((t) => `${t.id}:${t.revision}`)).size !==
      revisions.length ||
    tasks.some(
      (t) =>
        !revisions.some(
          (r) =>
            r.id === t.id &&
            r.revision === t.revision &&
            JSON.stringify(r) === JSON.stringify(t),
        ),
    ) ||
    tasks.some((t) => t.longAgentId !== agent) ||
    new Set(tasks.map((t) => t.id)).size !== tasks.length ||
    new Set(occurrences.map((o) => o.id)).size !== occurrences.length ||
    occurrences.some(
      (o) =>
        o.definition.longAgentId !== agent ||
        !tasks.some((t) => t.id === o.taskId),
    )
  )
    throw new Error("任务存储归属冲突");
  return {
    schemaVersion: 1,
    tasks,
    revisions,
    occurrences,
    migration: value.migration as TaskState["migration"],
  };
}
export async function changeTaskState<T>(
  home: string,
  agent: string,
  change: (state: TaskState) => Promise<T> | T,
): Promise<T> {
  return withFileLock(taskFile(home, agent), async () => {
    const state = await readTaskState(home, agent);
    const result = await change(state);
    await atomicWriteJson(taskFile(home, agent), state);
    return result;
  });
}

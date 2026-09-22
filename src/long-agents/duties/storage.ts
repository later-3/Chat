import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertFileWithin, atomicWriteJson, withFileLock } from "../../persistence/versioned-file.js";
import { longAgentConfigRoot } from "../storage.js";
import { exact, parseDuty, record, type FriendDuty } from "./contract.js";
export interface DutyState {
  schemaVersion: 1;
  duties: FriendDuty[];
  revisions: FriendDuty[];
}
export function dutyFile(home: string, agent: string) {
  return resolve(longAgentConfigRoot(home, agent), "duties.json");
}
export async function readDutyState(home: string, agent: string): Promise<DutyState> {
  const file = dutyFile(home, agent);
  await assertFileWithin(file, home);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return { schemaVersion: 1, duties: [], revisions: [] };
    throw e;
  }
  record(value);
  exact(value, ["schemaVersion", "duties", "revisions"]);
  if (value.schemaVersion !== 1 || !Array.isArray(value.duties) || !Array.isArray(value.revisions))
    throw new Error("职责存储格式无效");
  const duties = value.duties.map(parseDuty);
  const revisions = value.revisions.map(parseDuty);
  const definitionOf = (d: FriendDuty) => JSON.stringify([
    d.id, d.longAgentId, d.name, d.objective, d.materials, d.contextProjectId, d.outcome, d.timeZone,
    d.cadence, d.allowedHours, d.budget, d.totalUnits, d.status, d.createdAt, d.endedAt, d.taskId,
  ]);
  if (
    revisions.some((d) => d.longAgentId !== agent) ||
    new Set(revisions.map((d) => `${d.id}:${d.revision}`)).size !== revisions.length ||
    duties.some((d) => d.longAgentId !== agent) ||
    new Set(duties.map((d) => d.id)).size !== duties.length ||
    duties.some((d) => {
      const latest = revisions.filter((r) => r.id === d.id).sort((a, b) => b.revision - a.revision)[0];
      // Progress, next step and receipts live on the current duty only; revisions own definitions.
      return latest === undefined || latest.revision !== d.revision || definitionOf(latest) !== definitionOf(d);
    })
  )
    throw new Error("职责存储归属冲突");
  return { schemaVersion: 1, duties, revisions };
}
export async function changeDutyState<T>(home: string, agent: string, change: (state: DutyState) => Promise<T> | T): Promise<T> {
  return withFileLock(dutyFile(home, agent), async () => {
    const state = await readDutyState(home, agent);
    const result = await change(state);
    await atomicWriteJson(dutyFile(home, agent), state);
    return result;
  });
}

import { readLongAgentRegistry, readLongAgentState } from "./storage.js";
import { ensureAgentCalendar } from "./project-agent.js";
import { agentDate } from "./calendar.js";
import { retryDailySummary } from "./daily-maintenance.js";
import { controlQueuedRequest } from "./turn-queue.js";

/** Safe read projection: no frozen prompts, pending message bodies or channel credentials. */
export async function readFriendDays(home: string, longAgentId: string) {
  const found = (await readLongAgentRegistry(home)).agents.find((agent) => agent.id === longAgentId);
  if (found === undefined) throw new Error("Friend不存在");
  const agent = await ensureAgentCalendar(found, home);
  const state = await readLongAgentState(home);
  return { schemaVersion: 1 as const, longAgentId, timeZone: agent.timeZone, today: agentDate(agent.timeZone),
    days: state.dailySessions.filter((day) => day.longAgentId === longAgentId).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 60),
    requests: state.turns.filter((turn) => turn.longAgentId === longAgentId && turn.workId === undefined).slice(-100).map((turn) => ({
      turnId: turn.turnId, requestId: turn.requestId, sessionId: turn.sessionId, date: turn.date, acceptedAt: turn.acceptedAt,
      sequence: turn.sequence, source: turn.source, contextProjectId: turn.contextProjectId, status: turn.status, error: turn.error,
    })) };
}
export async function actOnFriendDay(home: string, longAgentId: string, value: unknown) {
  await readFriendDays(home, longAgentId);
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("action" in value)) throw new Error("无效日历操作");
  if (value.action === "retry-summary" && "date" in value && typeof value.date === "string" && Object.keys(value).every((key) => ["action", "date"].includes(key))) {
    await retryDailySummary(home, longAgentId, value.date);
  } else if ((value.action === "cancel-request" || value.action === "retry-request") && "turnId" in value && typeof value.turnId === "string" && Object.keys(value).every((key) => ["action", "turnId"].includes(key))) {
    await controlQueuedRequest(home, longAgentId, value.turnId, value.action === "cancel-request" ? "cancel" : "retry");
  } else throw new Error("不支持的日历操作");
  return readFriendDays(home, longAgentId);
}

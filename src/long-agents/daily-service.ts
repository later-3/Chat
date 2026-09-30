import { readLongAgentRegistry, readLongAgentState } from "./storage.js";
import { ensureAgentCalendar } from "./project-agent.js";
import { agentDate } from "./calendar.js";
import { requestDailySummary } from "./daily-summary-task.js";
import { controlQueuedRequest } from "./turn-queue.js";
import { resolveProjectContext } from "../projects/registry.js";
import { firstSessionUtterance, listActiveSessionFiles, sessionMessageDates } from "../session-files.js";

/** Safe read projection: no frozen prompts, pending message bodies or channel credentials. */
export async function readFriendDays(home: string, longAgentId: string, year?: number) {
  if (year !== undefined && (!Number.isInteger(year) || year < 1970 || year > 9999)) throw new Error("日历年份无效");
  const found = (await readLongAgentRegistry(home)).agents.find((agent) => agent.id === longAgentId);
  if (found === undefined) throw new Error("Friend不存在");
  const agent = await ensureAgentCalendar(found, home);
  const state = await readLongAgentState(home);
  const days = state.dailySessions.filter((day) => day.longAgentId === longAgentId
    && (year === undefined || day.date.startsWith(`${year}-`))).sort((a, b) => b.date.localeCompare(a.date));
  // Daily bindings are lifecycle records, not an activity list: work, topic and child Sessions already
  // live in the same Agent Home. Reuse native discovery (including removal and stat invalidation).
  const sessions = year === undefined ? undefined : (await listActiveSessionFiles(await resolveProjectContext(agent.id, home)))
    .flatMap(info => {
      const dates = sessionMessageDates(info, agent.timeZone).filter(date => date.startsWith(`${year}-`));
      const direct = state.additionalSessions.find(session => session.longAgentId === agent.id && session.sessionId === info.id);
      if (dates.length === 0 && !direct?.date.startsWith(`${year}-`)) return [];
      const work = state.works.find(item => item.longAgentId === agent.id && item.sessionId === info.id);
      const kind = state.dailySessions.some(day => day.longAgentId === agent.id && day.sessionId === info.id) ? "daily" as const
        : direct !== undefined ? "direct" as const
        : work !== undefined ? "work" as const
        : state.nodeSessions.some(node => node.longAgentId === agent.id && node.sessionId === info.id) ? "topic" as const : "session" as const;
      return [{ sessionId: info.id, projectId: agent.id, dates, kind,
        ...(direct === undefined ? {} : { creationDate: direct.date }),
        title: info.name ?? work?.title ?? firstSessionUtterance(info).slice(0, 120), createdAt: info.created.toISOString() }];
    });
  // Future token heatmap: aggregate native assistant usage for each Agent-local date across its
  // Sessions, then map higher token totals to darker green. Do not use Session/turn count or file
  // size as a token estimate; define cache-token accounting and deduplicate inherited fork entries
  // before enabling intensity. Keep this a rebuildable read projection, not another usage store.
  return { schemaVersion: 1 as const, longAgentId, timeZone: agent.timeZone, today: agentDate(agent.timeZone),
    // The status panel keeps its compact response; the calendar must not silently lose older dates.
    days: year === undefined ? days.slice(0, 60) : days,
    ...(sessions === undefined ? {} : { sessions }),
    requests: state.turns.filter((turn) => turn.longAgentId === longAgentId && turn.workId === undefined).slice(-100).map((turn) => ({
      turnId: turn.turnId, requestId: turn.requestId, sessionId: turn.sessionId, date: turn.date, acceptedAt: turn.acceptedAt,
      sequence: turn.sequence, source: turn.source, contextProjectId: turn.contextProjectId, status: turn.status, error: turn.error,
    })) };
}
export async function actOnFriendDay(home: string, longAgentId: string, value: unknown) {
  await readFriendDays(home, longAgentId);
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("action" in value)) throw new Error("无效日历操作");
  if (value.action === "retry-summary" && "date" in value && typeof value.date === "string" && Object.keys(value).every((key) => ["action", "date"].includes(key))) {
    await requestDailySummary(home, longAgentId, value.date);
  } else if ((value.action === "cancel-request" || value.action === "retry-request") && "turnId" in value && typeof value.turnId === "string" && Object.keys(value).every((key) => ["action", "turnId"].includes(key))) {
    await controlQueuedRequest(home, longAgentId, value.turnId, value.action === "cancel-request" ? "cancel" : "retry");
  } else throw new Error("不支持的日历操作");
  return readFriendDays(home, longAgentId);
}

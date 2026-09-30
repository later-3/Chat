import { listConversationWorks } from "./conversations/work-store.js";
import { ensureAgentCalendar } from "./project-agent.js";
import { openChatSession } from "../chat-session.js";
import { firstSessionUtterance, listActiveSessionFiles, sessionMessageDates } from "../session-files.js";
import { resolveProjectContext } from "../projects/registry.js";
import { agentDate, validateTimeZone } from "./calendar.js";
import { readLongAgentRegistry, readLongAgentState } from "./storage.js";
import { readTaskState } from "./tasks/storage.js";
import { assertSummaryDate, readLongAgentSummary, summaryMarkdown } from "./summaries.js";
import { listConversationsForMember } from "./conversations/storage.js";
import { assertParticipantSessionReadable } from "./conversations/access.js";

async function archiveOwner(home: string, id: string) {
  const agent = (await readLongAgentRegistry(home)).agents.find(item => item.id === id);
  if (!agent) throw new Error("找不到 Long Agent");
  return ensureAgentCalendar(agent, home);
}

/** Stable IDs into native stores, shared by the archive UI and summary_manage. No copied transcript. */
export async function readAgentDaySources(home: string, id: string, date: string, frozenTimeZone?: string) {
  assertSummaryDate(date);
  const agent = await archiveOwner(home, id);
  const timeZone = frozenTimeZone === undefined ? agent.timeZone : validateTimeZone(frozenTimeZone);
  const [state, tasks, ownSessions, groups] = await Promise.all([
    readLongAgentState(home), readTaskState(home, id),
    resolveProjectContext(id, home).then(listActiveSessionFiles), listConversationsForMember(home, id),
  ]);
  const sessions = ownSessions.filter(info => sessionMessageDates(info, timeZone).includes(date)).map(info => {
    const work = state.works.find(work => work.longAgentId === id && work.sessionId === info.id);
    return { sessionId: info.id, projectId: id, kind: work ? "work" : state.dailySessions.some(day => day.sessionId === info.id) ? "daily" : "session",
      title: info.name ?? work?.title ?? firstSessionUtterance(info).slice(0, 120), readable: true };
  });
  const usedGroups = new Set<string>();
  // Reuse group membership authorization; this does not grant access to another participant or
  // to private group work sessions, whose existing generic-read contract is owner-only.
  for (const { conversation, storageProjectId } of groups) {
    const member = conversation.members.find(member => member.longAgentId === id && member.revokedAt === null);
    if (!member?.sessionId) continue;
    const infos = await listActiveSessionFiles(await resolveProjectContext(storageProjectId, home));
    const info = infos.find(info => info.id === member.sessionId);
    if (!info || !sessionMessageDates(info, timeZone).includes(date)) continue;
    await assertParticipantSessionReadable({ chatHome: home, storageProjectId, sessionId: info.id, requester: { kind: "friend", longAgentId: id } });
    sessions.push({ sessionId: info.id, projectId: storageProjectId, kind: "group", title: conversation.title, readable: true });
    usedGroups.add(conversation.id);
  }
  const inDay = (at: string | null | undefined) => !!at && agentDate(timeZone, new Date(at)) === date;
  const works: { workId: string; sessionId: string | null; title: string; contextProjectId: string | null; status: string; error: string | null; createdAt: string }[] = state.works.filter(work => work.longAgentId === id).flatMap(work => {
    const turns = state.turns.filter(turn => turn.workId === work.id);
    const spansDay = agentDate(timeZone, new Date(work.createdAt)) <= date
      && (latestStatusOpen(turns.at(-1)?.status) || (turns.at(-1)?.settledAt != null && agentDate(timeZone, new Date(turns.at(-1)!.settledAt!)) >= date));
    if (!spansDay && !tasks.occurrences.some(item => item.workId === work.id && item.summaryDate === date) && !inDay(work.createdAt) && !turns.some(turn => inDay(turn.acceptedAt) || inDay(turn.settledAt)) && !sessions.some(session => session.sessionId === work.sessionId)) return [];
    const latest = turns.at(-1);
    return [{ workId: work.id, sessionId: work.sessionId, title: work.title, contextProjectId: work.contextProjectId,
      status: latest?.status ?? "queued", error: latest?.error ?? null, createdAt: work.createdAt }];
  });
  for (const { conversation, storageProjectId } of groups) {
    const member = conversation.members.find(member => member.longAgentId === id && member.revokedAt === null);
    if (!member) continue;
    for (const work of await listConversationWorks(home, storageProjectId, conversation.id)) {
      const spansDay = agentDate(timeZone, new Date(work.createdAt)) <= date
        && (latestStatusOpen(work.status) || agentDate(timeZone, new Date(work.updatedAt)) >= date);
      if (work.longAgentId !== id || work.participationEpoch !== member.participationEpoch || !spansDay) continue;
      works.push({ workId: work.workId, sessionId: null, title: `${conversation.title} · ${work.title}`,
        contextProjectId: storageProjectId, status: work.status, error: work.error, createdAt: work.createdAt });
      usedGroups.add(conversation.id);
    }
  }
  const occurrences = tasks.occurrences.filter(item => item.summaryDate === date || inDay(item.scheduledAt) || inDay(item.receivedAt) || works.some(work => work.workId === item.workId)).map(item => ({
    occurrenceId: item.id, taskId: item.taskId, revision: item.revision, title: item.definition.name,
    kind: item.definition.purpose ?? (item.definition.dutyId ? "duty" : "task"), dutyId: item.definition.dutyId ?? null,
    scheduledAt: item.scheduledAt, state: item.state, reason: item.reason, workId: item.workId,
    summaryDate: item.summaryDate ?? null, contextProjectId: item.definition.contextProjectId,
  }));
  return { date, timeZone, sessions, works, occurrences,
    groups: groups.flatMap(({ conversation, storageProjectId }) => {
      const member = conversation.members.find(member => member.longAgentId === id && member.revokedAt === null);
      return member && usedGroups.has(conversation.id) ? [{ conversationId: conversation.id, storageProjectId, participationEpoch: member.participationEpoch }] : [];
    }) };
}

export async function readAgentDayArchive(home: string, id: string, date: string) {
  const summary = await readLongAgentSummary(home, id, date);
  const savedSources = summary?.archive?.sources;
  const timeZone = savedSources && typeof savedSources === "object" && "timeZone" in savedSources && typeof savedSources.timeZone === "string"
    ? savedSources.timeZone : undefined;
  const { groups: _groups, ...sources } = await readAgentDaySources(home, id, date, timeZone);
  return { schemaVersion: 1 as const, longAgentId: id, ...sources,
    summary: summary ? { date, markdown: summary.markdown ?? summaryMarkdown(summary), updatedAt: summary.updatedAt,
      revision: summary.revision ?? null, fileName: "summary.md" } : null };
}

/** Bounded pages preserve oversized messages using a character cursor; never silently truncate. */
export async function readAgentArchiveSession(home: string, id: string, sessionId: string, cursor = "0:0", date?: string, frozenTimeZone?: string) {
  const agent = await archiveOwner(home, id);
  const timeZone = frozenTimeZone === undefined ? agent.timeZone : validateTimeZone(frozenTimeZone);
  if (!/^(?:[a-zA-Z0-9_-]+\|)?\d+:\d+$/.test(cursor)) throw new Error("无效历史游标");
  if (date !== undefined) assertSummaryDate(date);
  const own = await listActiveSessionFiles(await resolveProjectContext(id, home));
  let projectId = own.some(info => info.id === sessionId) ? id : undefined;
  if (projectId === undefined) {
    const groups = await listConversationsForMember(home, id);
    projectId = groups.find(({ conversation }) => conversation.members.some(member => member.longAgentId === id && member.revokedAt === null && member.sessionId === sessionId))?.storageProjectId;
    if (!projectId) throw new Error("该会话不属于当前 Agent 的可读历史");
    await assertParticipantSessionReadable({ chatHome: home, storageProjectId: projectId, sessionId, requester: { kind: "friend", longAgentId: id } });
  }
  const session = await openChatSession({ chatHome: home, projectId, sessionId });
  const [frozenLeaf, position] = cursor.includes("|") ? cursor.split("|") : [session.manager.getLeafId(), cursor];
  if (frozenLeaf && !session.manager.getEntries().some(entry => entry.id === frozenLeaf)) throw new Error("历史游标已失效，请重新读取");
  const entries = session.manager.getBranch(frozenLeaf ?? undefined).filter(entry => entry.type === "message"
    && (date === undefined || agentDate(timeZone, new Date(typeof entry.message.timestamp === "number" ? entry.message.timestamp : entry.timestamp)) === date));
  let [index, offset] = position!.split(":").map(Number) as [number, number];
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(offset) || index > entries.length) throw new Error("历史游标超出范围");
  let remaining = 24_000;
  const messages: { entryId: string; timestamp: string; content: string; continued: boolean }[] = [];
  while (index < entries.length && remaining > 0 && messages.length < 40) {
    const entry = entries[index]!;
    const text = JSON.stringify(entry.type === "message" ? entry.message : null);
    if (offset > text.length) throw new Error("历史游标超出消息范围");
    const content = text.slice(offset, offset + remaining);
    messages.push({ entryId: entry.id, timestamp: entry.timestamp, content, continued: offset > 0 });
    offset += content.length; remaining -= content.length;
    if (offset === text.length) { index++; offset = 0; }
  }
  return { sessionId, projectId, messages, nextCursor: index < entries.length ? `${frozenLeaf}|${index}:${offset}` : null };
}

function latestStatusOpen(status: string | undefined): boolean { return status === undefined || status === "queued" || status === "running"; }

import { atomicWriteText, assertFileWithin, withFileLock } from "../persistence/versioned-file.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { ensureChatHome } from "../chat-home.js";
import { longAgentConfigRoot } from "./storage.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_FIELD_CHARS = 20_000;

export interface LongAgentSummary {
  readonly markdown?: string;
  readonly revision?: string;
  readonly archive?: { readonly sessionId: string; readonly workId: string | null; readonly occurrenceId: string | null; readonly sources: unknown };
  readonly date: string;
  readonly did: readonly string[];
  readonly reflections: readonly string[];
  readonly handoff: string;
  readonly socialPost: string | null;
  readonly updatedAt: string;
  readonly source?: { readonly sessionId: string; readonly cutoff: string; readonly entryId: string; readonly revision: string };
}

export class LongAgentSummaryError extends Error {}

export function assertSummaryDate(value: unknown): string {
  if (typeof value !== "string" || (!DATE_PATTERN.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) {
    throw new LongAgentSummaryError(`date必须是YYYY-MM-DD: ${String(value)}`);
  }
  return value;
}

function assertLines(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new LongAgentSummaryError(`${field}必须是字符串数组`);
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item !== "")
    .map((item) => item.slice(0, MAX_FIELD_CHARS));
}

function assertText(value: unknown, field: string, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new LongAgentSummaryError(`${field}不能为空`);
    return "";
  }
  if (typeof value !== "string") throw new LongAgentSummaryError(`${field}必须是字符串`);
  const trimmed = value.trim();
  if (required && trimmed === "") throw new LongAgentSummaryError(`${field}不能为空`);
  return trimmed.slice(0, MAX_FIELD_CHARS);
}

async function rootFor(chatHome: string, longAgentId: string): Promise<string> {
  const home = await ensureChatHome(chatHome);
  const dir = resolve(longAgentConfigRoot(home.root, longAgentId), "summaries");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function summaryMarkdown(summary: LongAgentSummary): string {
  const lines = [
    `# ${summary.date} 每日总结`,
    "",
    "## 做了什么",
    ...(summary.did.length === 0 ? ["- （无）"] : summary.did.map((item) => `- ${item}`)),
    "",
    "## 反思与改进",
    ...(summary.reflections.length === 0 ? ["- （无）"] : summary.reflections.map((item) => `- ${item}`)),
    "",
    "## 交接上下文",
    summary.handoff === "" ? "（无）" : summary.handoff,
    "",
  ];
  if (summary.socialPost !== null) {
    lines.push("## 朋友圈", "", summary.socialPost, "");
  }
  return lines.join("\n");
}

function parseJson(content: string, path: string): LongAgentSummary {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new LongAgentSummaryError(`总结不是有效JSON: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof value !== "object" || value === null) throw new LongAgentSummaryError(`总结必须是对象: ${path}`);
  const record = value as Record<string, unknown>;
  return {
    ...(record.source === undefined ? {} : { source: parseSummarySource(record.source) }),
    date: assertSummaryDate(record.date),
    did: assertLines(record.did, "did"),
    reflections: assertLines(record.reflections, "reflections"),
    handoff: assertText(record.handoff, "handoff"),
    socialPost: record.socialPost === undefined || record.socialPost === null ? null : assertText(record.socialPost, "socialPost"),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
  };
}

/** One atomic Markdown artifact, with provenance in a non-rendered header. Legacy JSON is read-only. */
export async function writeLongAgentSummary(input: {
  readonly chatHome: string; readonly longAgentId: string; readonly date: string;
  readonly did?: unknown; readonly reflections?: unknown; readonly handoff?: unknown; readonly socialPost?: unknown;
  readonly source?: LongAgentSummary["source"]; readonly archive?: LongAgentSummary["archive"];
  readonly expectedRevision?: string | null;
}): Promise<LongAgentSummary> {
  const date = assertSummaryDate(input.date);
  const file = await summaryFile(input.chatHome, input.longAgentId, date);
  return withFileLock(file, async () => {
    const previous = await readLongAgentSummary(input.chatHome, input.longAgentId, date);
    if (input.expectedRevision !== undefined && input.expectedRevision !== (previous?.revision ?? null))
      throw new LongAgentSummaryError("总结已改变，请重新读取后再写入");
    const summary: LongAgentSummary = {
      date, did: assertLines(input.did, "did"), reflections: assertLines(input.reflections, "reflections"),
      handoff: assertText(input.handoff, "handoff"),
      socialPost: input.socialPost == null ? null : assertText(input.socialPost, "socialPost"),
      updatedAt: new Date().toISOString(), ...(input.source ? { source: input.source } : {}),
      ...(input.archive ? { archive: input.archive } : {}),
    };
    const markdown = summaryMarkdown(summary);
    const revision = createHash("sha256").update(JSON.stringify(summary)).digest("hex");
    const metadata = { schemaVersion: 2, date, updatedAt: summary.updatedAt, revision,
      ...(summary.source ? { source: summary.source } : {}), ...(summary.archive ? { archive: summary.archive } : {}) };
    const artifact = `<!-- chat.daily-summary ${JSON.stringify(metadata)} -->\n${markdown}`;
    await atomicWriteText(file, artifact);
    return { ...summary, markdown, revision: createHash("sha256").update(artifact).digest("hex") };
  });
}
async function summaryFile(home: string, id: string, date: string): Promise<string> {
  const file = resolve(longAgentConfigRoot((await ensureChatHome(home)).root, id), "days", assertSummaryDate(date), "summary.md");
  await assertFileWithin(file, home);
  return file;
}
function markdownSection(markdown: string, heading: string): string {
  const marker = `## ${heading}\n`;
  const start = markdown.indexOf(marker);
  if (start < 0) return "";
  return markdown.slice(start + marker.length).split(/\n## /)[0]!.trim();
}
export async function readLongAgentSummary(home: string, id: string, date: string): Promise<LongAgentSummary | undefined> {
  const file = await summaryFile(home, id, date);
  try {
    const text = await readFile(file, "utf8");
    const match = /^<!-- chat\.daily-summary (.+) -->\n/.exec(text);
    if (!match) throw new LongAgentSummaryError("总结 Markdown 来源头损坏");
    const metadata: unknown = JSON.parse(match[1]!);
    if (typeof metadata !== "object" || !metadata || !("schemaVersion" in metadata) || metadata.schemaVersion !== 2
      || !("date" in metadata) || metadata.date !== date || !("revision" in metadata) || typeof metadata.revision !== "string"
      || !("updatedAt" in metadata) || typeof metadata.updatedAt !== "string") throw new LongAgentSummaryError("总结 Markdown 元数据损坏");
    const markdown = text.slice(match[0].length);
    const lines = (heading: string) => markdownSection(markdown, heading).split("\n").filter(line => line.startsWith("- ") && line !== "- （无）").map(line => line.slice(2));
    const handoff = markdownSection(markdown, "交接上下文");
    const result: LongAgentSummary = { date, did: lines("做了什么"), reflections: lines("反思与改进"), handoff: handoff === "（无）" ? "" : handoff,
      socialPost: markdownSection(markdown, "朋友圈") || null, updatedAt: metadata.updatedAt, markdown,
      // Include the actual artifact bytes: a manual Markdown edit also invalidates the writer's CAS.
      revision: createHash("sha256").update(text).digest("hex"),
      ...("archive" in metadata ? { archive: parseArchiveSource(metadata.archive) } : {}),
      ...("source" in metadata ? { source: parseSummarySource(metadata.source) } : {}),
    };
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const text = await readFile(resolve(await rootFor(home, id), `${date}.json`), "utf8");
    return { ...parseJson(text, `${date}.json`), revision: createHash("sha256").update(text).digest("hex") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** 列出总结（按日期倒序）；from/to 为闭区间。 */
export async function listLongAgentSummaries(input: {
  readonly chatHome: string;
  readonly longAgentId: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
}): Promise<LongAgentSummary[]> {
  if (input.from !== undefined) assertSummaryDate(input.from);
  if (input.to !== undefined) assertSummaryDate(input.to);
  const dir = await rootFor(input.chatHome, input.longAgentId);
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json"));
  let archived: string[];
  try { archived = await readdir(resolve(longAgentConfigRoot(input.chatHome, input.longAgentId), "days")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; archived = []; }
  const dates = [...new Set([...archived, ...files.map((file) => file.slice(0, -".json".length))])].filter((date) => DATE_PATTERN.test(date));
  const filtered = dates
    .filter((date) => (input.from === undefined || date >= input.from) && (input.to === undefined || date <= input.to))
    .sort()
    .reverse()
    .slice(0, input.limit ?? 30);
  const summaries: LongAgentSummary[] = [];
  for (const date of filtered) {
    const summary = await readLongAgentSummary(input.chatHome, input.longAgentId, date);
    if (summary !== undefined) summaries.push(summary);
  }
  return summaries;
}

/** 按关键词搜索总结正文。 */
export async function searchLongAgentSummaries(input: {
  readonly chatHome: string;
  readonly longAgentId: string;
  readonly query: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
}): Promise<LongAgentSummary[]> {
  const query = input.query.trim().toLowerCase();
  const all = await listLongAgentSummaries({ ...input, limit: Number.MAX_SAFE_INTEGER });
  if (query === "") return all.slice(0, input.limit ?? 20);
  return all
    .filter((summary) => JSON.stringify(summary).toLowerCase().includes(query))
    .slice(0, input.limit ?? 20);
}

/** 前一天（UTC 安全的纯日期运算，避免时区把日期挪一天）。 */
export function previousDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

function localDate(now = new Date()): string {
  return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * 换日交接：把最近 N 天的"交接上下文"组装成一段注入文本。
 * 程序直接注入（不调用模型），因此换日后的第一个 turn 就知道此前发生了什么。
 */
export async function buildLongAgentHandoff(input: {
  readonly chatHome: string;
  readonly longAgentId: string;
  readonly days?: number;
  readonly today?: string;
}): Promise<string | null> {
  const today = input.today ?? localDate();
  const days = input.days ?? 1;
  // 只取"今天之前"的 days 天：先算 to=昨天，避免把今天自己的总结当历史。
  let summaries: LongAgentSummary[];
  try {
    summaries = await listLongAgentSummaries({
    chatHome: input.chatHome,
    longAgentId: input.longAgentId,
    from: previousDate(new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * 86400_000).toISOString().slice(0, 10)),
    to: previousDate(today),
    limit: days,
    });
    for (const summary of summaries) await assertSummarySourcesReadable(input.chatHome, input.longAgentId, summary);
  } catch {
    return `<daily_handoff_unavailable>昨天（${previousDate(today)}）的总结暂不可读取；请核对日归档文件和来源权限，正常交流不受影响，不得虚构交接内容。</daily_handoff_unavailable>`;
  }
  const pending = summaries.length === 0 ? [`昨天（${previousDate(today)}）的每日总结尚未生成，可通过 summary_manage 读取原始日目录；不要把计划当完成。`] : [];
  const blocks = summaries.map((summary) => summary.markdown ?? [
    `### ${summary.date}`,
    "做了什么：",
    ...(summary.did.length === 0 ? ["- （无）"] : summary.did.map((item) => `- ${item}`)),
    summary.reflections.length === 0 ? "" : "反思与改进：",
    ...summary.reflections.map((item) => `- ${item}`),
    summary.handoff === "" ? "" : `交接：${summary.handoff}`,
  ].filter((line) => line !== "").join("\n"));
  return [
    `<recent_daily_summaries days="${String(summaries.length)}">`,
    "以下是按日期读取的每日总结与交接上下文（程序注入，不是用户本轮说的话）：",
    ...pending,
    ...blocks,
    "</recent_daily_summaries>",
  ].join("\n");
}

function parseSummarySource(value: unknown): NonNullable<LongAgentSummary["source"]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("总结来源无效");
  const source = value as Record<string, unknown>;
  for (const key of ["sessionId", "cutoff", "entryId", "revision"]) if (typeof source[key] !== "string" || !source[key]) throw new Error("总结来源字段无效");
  return source as unknown as NonNullable<LongAgentSummary["source"]>;
}

function parseArchiveSource(value: unknown): NonNullable<LongAgentSummary["archive"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LongAgentSummaryError("归档来源无效");
  const source = value as Record<string, unknown>;
  if (typeof source.sessionId !== "string" || !source.sessionId
    || !(source.workId === null || typeof source.workId === "string")
    || !(source.occurrenceId === null || typeof source.occurrenceId === "string") || !("sources" in source)) throw new LongAgentSummaryError("归档来源字段无效");
  return { sessionId: source.sessionId, workId: source.workId, occurrenceId: source.occurrenceId, sources: source.sources };
}

/** Recheck group grants before an Agent consumes a derived memory; the owner's archive can still inspect it. */
export async function assertSummarySourcesReadable(home: string, id: string, summary: LongAgentSummary): Promise<void> {
  if (!summary.archive) return; // Old summaries only covered the Agent's direct Session.
  const sources = summary.archive.sources;
  if (!sources || typeof sources !== "object" || !("sessions" in sources) || !Array.isArray(sources.sessions)) throw new LongAgentSummaryError("总结来源目录损坏");
  if ("groups" in sources) {
    if (!Array.isArray(sources.groups)) throw new LongAgentSummaryError("总结群来源无效");
    const { readConversation } = await import("./conversations/service.js");
    for (const raw of sources.groups) {
      if (!raw || typeof raw !== "object" || typeof raw.conversationId !== "string" || typeof raw.storageProjectId !== "string" || !Number.isSafeInteger(raw.participationEpoch)) throw new LongAgentSummaryError("总结群来源无效");
      const conversation = await readConversation(home, raw.storageProjectId, raw.conversationId);
      if (!conversation.members.some(member => member.longAgentId === id && member.revokedAt === null && member.participationEpoch === raw.participationEpoch)) throw new LongAgentSummaryError("总结群来源权限已变化");
    }
  }
  const { assertParticipantSessionReadable } = await import("./conversations/access.js");
  for (const item of sources.sessions) {
    if (!item || typeof item !== "object" || !("projectId" in item) || typeof item.projectId !== "string" || !("sessionId" in item) || typeof item.sessionId !== "string") throw new LongAgentSummaryError("总结来源 Session 无效");
    if (item.projectId === id) continue;
    const result = await assertParticipantSessionReadable({ chatHome: home, storageProjectId: item.projectId,
      sessionId: item.sessionId, requester: { kind: "friend", longAgentId: id } });
    if (!result.participation) throw new LongAgentSummaryError("总结来源不属于授权群参与历史");
  }
}

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ensureChatHome } from "../chat-home.js";
import { longAgentConfigRoot } from "./storage.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_FIELD_CHARS = 20_000;

export interface LongAgentSummary {
  readonly date: string;
  readonly did: readonly string[];
  readonly reflections: readonly string[];
  readonly handoff: string;
  readonly socialPost: string | null;
  readonly updatedAt: string;
}

export class LongAgentSummaryError extends Error {}

function assertDate(value: unknown): string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
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

function toMarkdown(summary: LongAgentSummary): string {
  const lines = [
    `---`,
    `date: ${summary.date}`,
    `updatedAt: ${summary.updatedAt}`,
    `---`,
    "",
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
    date: assertDate(record.date),
    did: assertLines(record.did, "did"),
    reflections: assertLines(record.reflections, "reflections"),
    handoff: assertText(record.handoff, "handoff"),
    socialPost: record.socialPost === undefined || record.socialPost === null ? null : assertText(record.socialPost, "socialPost"),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
  };
}

/** 写入一天的总结（<date>.json 为事实源，<date>.md 供人读）。 */
export async function writeLongAgentSummary(input: {
  readonly chatHome: string;
  readonly longAgentId: string;
  readonly date: string;
  readonly did?: unknown;
  readonly reflections?: unknown;
  readonly handoff?: unknown;
  readonly socialPost?: unknown;
}): Promise<LongAgentSummary> {
  const date = assertDate(input.date);
  const dir = await rootFor(input.chatHome, input.longAgentId);
  const summary: LongAgentSummary = {
    date,
    did: assertLines(input.did, "did"),
    reflections: assertLines(input.reflections, "reflections"),
    handoff: assertText(input.handoff, "handoff"),
    socialPost: input.socialPost === undefined || input.socialPost === null
      ? null
      : assertText(input.socialPost, "socialPost"),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(resolve(dir, `${date}.json`), `${JSON.stringify(summary, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await writeFile(resolve(dir, `${date}.md`), toMarkdown(summary), { encoding: "utf8", mode: 0o600 });
  return summary;
}

/** 读取一天的总结；不存在返回 undefined。 */
export async function readLongAgentSummary(
  chatHome: string,
  longAgentId: string,
  date: string,
): Promise<LongAgentSummary | undefined> {
  const dir = await rootFor(chatHome, longAgentId);
  try {
    return parseJson(await readFile(resolve(dir, `${assertDate(date)}.json`), "utf8"), `${date}.json`);
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
  const dir = await rootFor(input.chatHome, input.longAgentId);
  const files = (await readdir(dir).catch(() => [] as string[])).filter((file) => file.endsWith(".json"));
  const dates = files.map((file) => file.slice(0, -".json".length)).filter((date) => DATE_PATTERN.test(date));
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
  readonly limit?: number;
}): Promise<LongAgentSummary[]> {
  const query = input.query.trim().toLowerCase();
  const all = await listLongAgentSummaries({ chatHome: input.chatHome, longAgentId: input.longAgentId, limit: 180 });
  if (query === "") return all.slice(0, input.limit ?? 20);
  return all
    .filter((summary) => JSON.stringify(summary).toLowerCase().includes(query))
    .slice(0, input.limit ?? 20);
}

/** 前一天（UTC 安全的纯日期运算，避免时区把日期挪一天）。 */
function previousDate(date: string): string {
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
  const days = input.days ?? 3;
  // 只取"今天之前"的 days 天：先算 to=昨天，避免把今天自己的总结当历史。
  const summaries = await listLongAgentSummaries({
    chatHome: input.chatHome,
    longAgentId: input.longAgentId,
    to: previousDate(today),
    limit: days,
  });
  if (summaries.length === 0) return null;
  const blocks = summaries.map((summary) => [
    `### ${summary.date}`,
    "做了什么：",
    ...(summary.did.length === 0 ? ["- （无）"] : summary.did.map((item) => `- ${item}`)),
    summary.reflections.length === 0 ? "" : "反思与改进：",
    ...summary.reflections.map((item) => `- ${item}`),
    summary.handoff === "" ? "" : `交接：${summary.handoff}`,
  ].filter((line) => line !== "").join("\n"));
  return [
    `<recent_daily_summaries days="${String(summaries.length)}">`,
    "以下是此前几天的每日总结与交接上下文（程序注入，不是用户本轮说的话）：",
    ...blocks,
    "</recent_daily_summaries>",
  ].join("\n");
}

import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { ensureChatHome } from "../chat-home.js";
import { longAgentConfigRoot } from "./storage.js";

export interface LongAgentActivityDay {
  readonly date: string;
  readonly sessions: number;
  readonly turns: number;
  readonly tokens: { readonly input: number; readonly output: number; readonly total: number };
  readonly tools: readonly { readonly name: string; readonly count: number }[];
  readonly models: readonly string[];
}

export interface LongAgentActivity {
  readonly longAgentId: string;
  readonly from: string;
  readonly to: string;
  readonly days: readonly LongAgentActivityDay[];
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function dateOfLocal(timestamp: string): string | null {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${String(parsed.getFullYear())}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
}

/**
 * 活动索引（A4/C2）：从 Agent 自己的 Session JSONL 派生"每天做了什么"。
 * Session 是事实源，这里只是可重建的派生视图（token/工具/轮次）。
 */
export async function buildLongAgentActivity(input: {
  readonly chatHome?: string;
  readonly longAgentId: string;
  readonly from: string;
  readonly to: string;
}): Promise<LongAgentActivity> {
  const home = await ensureChatHome(input.chatHome);
  for (const [field, value] of [["from", input.from], ["to", input.to]] as const) {
    if (!DATE_PATTERN.test(value)) throw new Error(`${field}必须是YYYY-MM-DD`);
  }
  const sessionDir = resolve(longAgentConfigRoot(home.root, input.longAgentId), "sessions");
  const files = (await readdir(sessionDir).catch(() => [] as string[])).filter((file) => file.endsWith(".jsonl"));

  const days = new Map<string, {
    sessions: Set<string>;
    turns: Set<string>;
    input: number;
    output: number;
    total: number;
    tools: Map<string, number>;
    models: Set<string>;
  }>();

  for (const file of files) {
    const sessionId = file.replace(/\.jsonl$/, "");
    let content: string;
    try {
      content = await readFile(resolve(sessionDir, file), "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let entry: unknown;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const timestamp = typeof record.timestamp === "string" ? record.timestamp : null;
      const date = timestamp === null ? null : dateOfLocal(timestamp);
      if (date === null || date < input.from || date > input.to) continue;

      // 轮次标记：与执行同一来源（Chat 自己写的 custom 条目）。
      if (record.type === "custom") {
        const payload = (record.data ?? record.details) as Record<string, unknown> | undefined;
        const turnId = payload !== undefined && typeof payload.turnId === "string" ? payload.turnId : undefined;
        if (turnId === undefined) continue;
        const day = days.get(date) ?? { sessions: new Set(), turns: new Set(), input: 0, output: 0, total: 0, tools: new Map(), models: new Set() };
        day.sessions.add(sessionId);
        day.turns.add(turnId);
        days.set(date, day);
        continue;
      }

      const message = record.type === "message" ? (record.message as Record<string, unknown> | undefined) : undefined;
      if (message === undefined || typeof message !== "object" || message === null) continue;
      const day = days.get(date) ?? { sessions: new Set(), turns: new Set(), input: 0, output: 0, total: 0, tools: new Map(), models: new Set() };
      day.sessions.add(sessionId);
      if (message.role === "assistant") {
        const usage = message.usage as Record<string, unknown> | undefined;
        if (usage !== undefined && typeof usage === "object" && usage !== null) {
          const asNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
          day.input += asNumber(usage.input);
          day.output += asNumber(usage.output);
          day.total += asNumber(usage.totalTokens ?? usage.total);
        }
        if (typeof message.provider === "string" && typeof message.model === "string") {
          day.models.add(`${message.provider}/${message.model}`);
        }
      }
      if (message.role === "toolResult" || message.role === "tool") {
        const name = typeof message.toolName === "string" ? message.toolName : undefined;
        if (name !== undefined) day.tools.set(name, (day.tools.get(name) ?? 0) + 1);
      }
      days.set(date, day);
    }
  }

  const result: LongAgentActivityDay[] = [...days.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, day]) => ({
      date,
      sessions: day.sessions.size,
      turns: day.turns.size,
      tokens: { input: day.input, output: day.output, total: day.total },
      tools: [...day.tools.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      models: [...day.models],
    }));
  return { longAgentId: input.longAgentId, from: input.from, to: input.to, days: result };
}

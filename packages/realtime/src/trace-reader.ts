import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { traceEventSchema, type TraceEvent } from "@chat/contracts";
import { z } from "zod";
import { TRACE_FILE_PATTERN, resolveTraceDir } from "./trace-paths.js";

const retiredProjectTraceEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: z.string().regex(/^[a-z][a-z0-9]*_[A-Za-z0-9-]{1,80}$/u),
    timestamp: z.string().datetime({ offset: true }),
    level: z.enum(["debug", "info", "warn", "error"]),
    traceId: z.string().regex(/^[a-z][a-z0-9]*_[A-Za-z0-9-]{1,80}$/u),
    spanId: z.string().regex(/^[a-z][a-z0-9]*_[A-Za-z0-9-]{1,80}$/u),
    outcome: z.enum(["success", "failure", "rejected", "unknown"]),
    eventName: z.enum([
      "project.intake.started",
      "project.intake.candidate_published",
      "project.intake.confirmed",
      "project.intake.rejected",
      "project.advancement.started",
      "project.advancement.candidate_published",
      "project.advancement.confirmed",
      "project.advancement.rejected",
      "project.lifecycle.transitioned",
      "project.stage.transitioned",
      "project.milestone.transitioned",
      "project.update.published",
      "project.understanding.started",
      "project.understanding.completed",
      "project.understanding.failed",
      "project.resource.observe.started",
      "project.resource.observe.completed",
      "project.resource.observe.failed",
      "project.action.created",
      "project.action.assigned",
      "project.action.transitioned",
      "project.decision.candidate",
      "project.decision.committed",
      "project.decision.rejected",
      "project.contribution.candidate",
      "project.contribution.committed",
      "project.contribution.rejected",
    ]),
  })
  .passthrough();

/**
 * Trace Reader（任务书§7.4）。
 *
 * 只读语义：
 * - 只打开文件读取，绝不修改、重排或清理原始JSONL；
 * - 任一行JSON解析失败或严格联合校验失败（包括旧版任意attributes事件）
 *   即失败关闭并报告文件与行号；
 * - Trace不含Prompt、Provider正文、密钥或隐藏推理；Pi工具显示证据已在写入前
 *   完成脱敏和长度限制，Reader不做事后清洗。
 */
export interface TraceQuery {
  dir?: string;
  productRunId?: string;
  memoryImportIntentId?: string;
  requestId?: string;
  commandId?: string;
}

export class TraceReadError extends Error {
  readonly file: string;
  readonly line: number;

  constructor(file: string, line: number, message: string) {
    super(`${file}:${line}: ${message}`);
    this.name = "TraceReadError";
    this.file = file;
    this.line = line;
  }
}

interface CollectedEvent {
  event: TraceEvent;
  fileIndex: number;
  lineIndex: number;
}

/**
 * 读取并按时间排序Trace事件。文件名按日期排序后逐行解析；
 * 排序键为(timestamp, fileIndex, lineIndex)，保证同毫秒事件的稳定顺序。
 */
export function readTraceEvents(query: TraceQuery): TraceEvent[] {
  const dir = resolveTraceDir({ ...(query.dir !== undefined ? { dir: query.dir } : {}) });
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter((name) => TRACE_FILE_PATTERN.test(name))
    .sort();

  const collected: CollectedEvent[] = [];
  files.forEach((name, fileIndex) => {
    const path = join(dir, name);
    const content = readFileSync(path, "utf8");
    const lines = content.split("\n");
    lines.forEach((line, index) => {
      if (line.trim() === "") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new TraceReadError(name, index + 1, "JSON解析失败，原始文件保持未修改");
      }
      // 已退役事件只作为原始JSONL历史证据保留，不再投影为当前Trace事件。
      if (retiredProjectTraceEnvelopeSchema.safeParse(parsed).success) {
        return;
      }
      const result = traceEventSchema.safeParse(parsed);
      if (!result.success) {
        throw new TraceReadError(
          name,
          index + 1,
          `Trace事件严格合同校验失败：${result.error.issues[0]?.message ?? "unknown"}`,
        );
      }
      const event = result.data;
      // 关联字段按事件族必填/可选分布，用in窄化后过滤
      const productRunId = "productRunId" in event ? event.productRunId : undefined;
      const requestId = "requestId" in event ? event.requestId : undefined;
      const commandId = "commandId" in event ? event.commandId : undefined;
      const memoryImportIntentId =
        "memoryImportIntentId" in event ? event.memoryImportIntentId : undefined;
      if (query.productRunId !== undefined && productRunId !== query.productRunId) return;
      if (
        query.memoryImportIntentId !== undefined &&
        memoryImportIntentId !== query.memoryImportIntentId
      )
        return;
      if (query.requestId !== undefined && requestId !== query.requestId) return;
      if (query.commandId !== undefined && commandId !== query.commandId) return;
      collected.push({ event, fileIndex, lineIndex: index });
    });
  });

  collected.sort((a, b) => {
    const byTime = a.event.timestamp.localeCompare(b.event.timestamp);
    if (byTime !== 0) return byTime;
    if (a.fileIndex !== b.fileIndex) return a.fileIndex - b.fileIndex;
    return a.lineIndex - b.lineIndex;
  });

  return collected.map(({ event }) => event);
}

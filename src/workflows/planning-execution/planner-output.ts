import type { PlanReviewReadiness } from "./review.js";

const METADATA_PREFIX = "<!-- chat-planner-output ";
const METADATA_SUFFIX = " -->";
const MAX_BLOCKING_QUESTIONS = 20;
const MAX_BLOCKING_QUESTION_CHARS = 2_000;

export interface ParsedPlannerOutput {
  readonly readiness: PlanReviewReadiness;
  readonly blockingQuestions: readonly string[];
  readonly document: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses the hidden planning contract from the first line and returns only the
 * user-facing review document. The strict envelope prevents an incomplete
 * clarification request from being mistaken for an executable plan.
 */
export function parsePlannerOutput(text: string): ParsedPlannerOutput {
  const normalized = text.trim();
  const firstNewline = normalized.indexOf("\n");
  const firstLine = (firstNewline === -1 ? normalized : normalized.slice(0, firstNewline)).trim();
  if (!firstLine.startsWith(METADATA_PREFIX) || !firstLine.endsWith(METADATA_SUFFIX)) {
    throw new Error("Planner输出缺少chat-planner-output元数据");
  }

  const metadataText = firstLine.slice(METADATA_PREFIX.length, -METADATA_SUFFIX.length);
  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataText) as unknown;
  } catch {
    throw new Error("Planner输出元数据不是有效JSON");
  }
  if (!isRecord(metadata) || metadata.schemaVersion !== 1
    || (metadata.readiness !== "ready_for_review" && metadata.readiness !== "needs_clarification")
    || !Array.isArray(metadata.blockingQuestions)) {
    throw new Error("Planner输出元数据结构无效");
  }
  const unknownFields = Object.keys(metadata)
    .filter((field) => !["schemaVersion", "readiness", "blockingQuestions"].includes(field));
  if (unknownFields.length > 0) {
    throw new Error(`Planner输出元数据包含未知字段: ${unknownFields.join(", ")}`);
  }
  if (metadata.blockingQuestions.length > MAX_BLOCKING_QUESTIONS) {
    throw new Error(`Planner阻塞问题不能超过${MAX_BLOCKING_QUESTIONS}个`);
  }
  const blockingQuestions = metadata.blockingQuestions.map((question, index) => {
    if (typeof question !== "string" || question.trim() === "") {
      throw new Error(`Planner阻塞问题${String(index + 1)}必须是非空字符串`);
    }
    const normalizedQuestion = question.trim();
    if (normalizedQuestion.length > MAX_BLOCKING_QUESTION_CHARS) {
      throw new Error(`Planner阻塞问题${String(index + 1)}不能超过${MAX_BLOCKING_QUESTION_CHARS}个字符`);
    }
    return normalizedQuestion;
  });
  const readiness = metadata.readiness as PlanReviewReadiness;
  if (readiness === "ready_for_review" && blockingQuestions.length > 0) {
    throw new Error("可审核执行的计划不能包含阻塞问题");
  }
  if (readiness === "needs_clarification" && blockingQuestions.length === 0) {
    throw new Error("等待澄清的计划必须包含至少一个阻塞问题");
  }

  const document = (firstNewline === -1 ? "" : normalized.slice(firstNewline + 1)).trim();
  if (document === "") throw new Error("Planner没有返回可审核文档");
  return { readiness, blockingQuestions, document };
}

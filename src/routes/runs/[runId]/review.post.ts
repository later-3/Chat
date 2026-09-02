import { createError, defineEventHandler, getRouterParam, readBody, setResponseStatus } from "nitro/h3";
import { getRun } from "workflow/api";
import { resolveProjectContext } from "../../../projects/registry.js";
import { openChatSession } from "../../../chat-session.js";
import { SessionLifecycleError } from "../../../session-errors.js";
import { toSessionLifecycleHttpError } from "../../../session-removal-http.js";
import {
  assertPlanReviewDecisionMatches,
  parsePlanReviewDecision,
  planReviewDecisionHook,
  planReviewHookToken,
} from "../../../workflows/planning-execution/review.js";
import {
  collectPlanReviewDecisions,
  getPlanningExecutionRun,
  type PlanningExecutionRunRecord,
} from "../../../workflows/planning-execution/review-state.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function isAlreadyAccepted(
  record: PlanningExecutionRunRecord,
  decision: ReturnType<typeof parsePlanReviewDecision>,
): Promise<boolean> {
  if (record.sessionId === undefined) return false;
  const chatSession = await openChatSession({
    projectId: record.projectId,
    sessionId: record.sessionId,
  });
  const existing = collectPlanReviewDecisions(chatSession.manager.getEntries())
    .find((candidate) => candidate.reviewId === decision.reviewId);
  if (existing === undefined) return false;
  assertPlanReviewDecisionMatches(existing, decision);
  return existing.kind === decision.kind
    && (existing.kind === "approve"
      || (decision.kind === "request_revision" && existing.feedback === decision.feedback));
}

/** Validates and resumes the exact pending plan review for one Workflow Run. */
export default defineEventHandler(async (event) => {
  const runId = getRouterParam(event, "runId");
  if (!runId) throw createError({ statusCode: 400, statusMessage: "缺少runId" });

  try {
    const body = await readBody<unknown>(event);
    if (!isRecord(body) || typeof body.projectId !== "string" || body.projectId.trim() === "") {
      throw new Error("projectId必须是非空字符串");
    }
    const decision = parsePlanReviewDecision(body.decision);
    const project = await resolveProjectContext(body.projectId);
    const record = await getPlanningExecutionRun(project.projectDataDir, decision.workflowInvocationId);
    if (record === undefined || record.runId !== runId) throw new Error("审核决定不属于当前Workflow Run");
    if (record.phase !== "waiting_review" || record.currentReview === undefined) {
      if (await isAlreadyAccepted(record, decision)) {
        setResponseStatus(event, 202);
        return { runId, status: "accepted" as const, decision: decision.kind, replayed: true };
      }
      throw new Error("当前Workflow没有等待审核的计划");
    }
    assertPlanReviewDecisionMatches(decision, record.currentReview);
    if (await getRun(runId).status !== "running") throw new Error("Workflow Run已不在运行中");
    try {
      await planReviewDecisionHook.resume(
        planReviewHookToken(decision.workflowInvocationId, decision.planRevision),
        decision,
      );
    } catch (error) {
      const latest = await getPlanningExecutionRun(project.projectDataDir, decision.workflowInvocationId);
      if (latest !== undefined && await isAlreadyAccepted(latest, decision)) {
        setResponseStatus(event, 202);
        return { runId, status: "accepted" as const, decision: decision.kind, replayed: true };
      }
      throw error;
    }
    setResponseStatus(event, 202);
    return { runId, status: "accepted" as const, decision: decision.kind };
  } catch (error) {
    if (error instanceof SessionLifecycleError) throw toSessionLifecycleHttpError(error);
    throw createError({
      statusCode: 409,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});

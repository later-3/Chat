import { PROVIDER_MODEL, PROVIDER_NAME, type RunActivityEventInput } from "@chat/contracts";
import type { PiDirectExecutorEvent } from "@chat/pi-runtime";
import { getWorkflowRuntimeContext } from "./runtime-context.js";

interface DirectActivityScope {
  readonly productRunId: string;
  readonly directAgentAttemptId: string;
}

/** Pi Direct Operation Journal -> Chat Run Activity；正文仍留在Pi原生Session。 */
export function piDirectExecutorActivities(
  scope: DirectActivityScope,
  event: PiDirectExecutorEvent,
): readonly RunActivityEventInput[] {
  const activities: RunActivityEventInput[] = [];
  const common = {
    productRunId: scope.productRunId as never,
    attemptId: scope.directAgentAttemptId as never,
    timestamp: event.timestamp,
    sourceKind: "pi_direct_executor" as const,
    sourceOperationId: event.operationId,
    sourceSequence: event.sequence,
  };
  const emit = (suffix: string, value: Record<string, unknown>) => {
    activities.push({
      ...common,
      sourceKey: `pi-direct:${event.operationId}:${String(event.sequence)}:${suffix}`,
      ...value,
    } as unknown as RunActivityEventInput);
  };

  switch (event.type) {
    case "operation.accepted":
      emit("lifecycle", {
        activityType: "lifecycle",
        name: "operation.accepted",
        outcome: "unknown",
      });
      break;
    case "operation.started":
      emit("lifecycle", {
        activityType: "lifecycle",
        name: "operation.started",
        outcome: "unknown",
      });
      emit("agent", { activityType: "agent", phase: "started", nodeKind: "direct_agent" });
      break;
    case "session.started":
      emit("lifecycle", {
        activityType: "lifecycle",
        name: "session.started",
        outcome: "unknown",
      });
      break;
    case "session.resumed":
      emit("lifecycle", {
        activityType: "lifecycle",
        name: "session.resumed",
        outcome: "unknown",
      });
      break;
    case "prompt_review.preparing":
    case "prompt_review.waiting":
    case "prompt_review.decided":
      emit("lifecycle", {
        activityType: "lifecycle",
        name: event.type,
        outcome: event.type === "prompt_review.decided" ? "success" : "unknown",
      });
      break;
    case "provider.started":
      emit("model", {
        activityType: "model",
        phase: "started",
        nodeKind: "direct_agent",
        provider: PROVIDER_NAME,
        model: PROVIDER_MODEL,
        requestIndex: event.requestIndex,
      });
      break;
    case "provider.completed":
      emit("model", {
        activityType: "model",
        phase: "completed",
        nodeKind: "direct_agent",
        provider: PROVIDER_NAME,
        model: PROVIDER_MODEL,
        requestIndex: event.requestIndex,
      });
      break;
    case "tool.intent_persisted":
      emit("tool", {
        activityType: "tool",
        phase: "started",
        nodeKind: "direct_agent",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        inputDisplay: JSON.stringify({ sha256: event.inputSha256 }),
        inputDisplayTruncated: false,
      });
      break;
    case "tool.completed":
    case "tool.failed":
    case "tool.outcome_unknown":
      emit("tool", {
        activityType: "tool",
        phase:
          event.type === "tool.completed"
            ? "completed"
            : event.type === "tool.outcome_unknown"
              ? "outcome_unknown"
              : "failed",
        nodeKind: "direct_agent",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...(event.resultSha256 === undefined
          ? {}
          : {
              resultDisplay: JSON.stringify({ sha256: event.resultSha256 }),
              resultDisplayTruncated: false,
            }),
        ...(event.type === "tool.failed"
          ? { errorCode: "direct_executor.tool_failed" }
          : event.type === "tool.outcome_unknown"
            ? { errorCode: "direct_executor.tool_outcome_unknown" }
            : {}),
      });
      break;
    case "operation.completed":
      emit("agent", { activityType: "agent", phase: "completed", nodeKind: "direct_agent" });
      emit("lifecycle", {
        activityType: "lifecycle",
        name: "operation.completed",
        outcome: "success",
      });
      break;
    case "operation.cancelled":
    case "operation.failed":
    case "operation.outcome_unknown": {
      const outcome =
        event.type === "operation.cancelled"
          ? "cancelled"
          : event.type === "operation.failed"
            ? "failure"
            : "unknown";
      emit("agent", {
        activityType: "agent",
        phase:
          event.type === "operation.cancelled"
            ? "cancelled"
            : event.type === "operation.outcome_unknown"
              ? "outcome_unknown"
              : "failed",
        nodeKind: "direct_agent",
        errorCode: event.errorCode,
      });
      emit("lifecycle", {
        activityType: "lifecycle",
        name: event.type,
        outcome,
        errorCode: event.errorCode,
      });
      break;
    }
  }
  return activities;
}

/** 实时路径只负责把纯映射结果交给Workflow上下文中的唯一Journal Writer。 */
export function emitPiDirectExecutorActivity(
  scope: DirectActivityScope,
  event: PiDirectExecutorEvent,
): void {
  const ctx = getWorkflowRuntimeContext();
  for (const activity of piDirectExecutorActivities(scope, event)) {
    ctx.activity?.(activity);
  }
}

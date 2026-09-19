import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { projectAgentSessionEvent } from "../agents/session-events.js";
export { projectAgentSessionEvent } from "../agents/session-events.js";
import { getWritable } from "workflow";
import { localTimestamp } from "../runtime-log.js";

export interface ChatRunStage {
  readonly workflowId: string;
  readonly stageId: string;
  readonly nodeKind: "agent" | "task";
  readonly agentId?: string;
}

export interface ChatRunPlanReview {
  readonly reviewId: string;
  readonly workflowInvocationId: string;
  readonly sessionId: string;
  readonly planRevision: number;
  readonly planSha256: string;
  readonly plan: string;
  readonly readiness: "ready_for_review" | "needs_clarification";
  readonly blockingQuestions: readonly string[];
}

export type ChatRunEvent =
  | { readonly type: "stage_start"; readonly stage: ChatRunStage }
  | { readonly type: "review_required"; readonly stage: ChatRunStage; readonly review: ChatRunPlanReview }
  | {
      readonly type: "agent_event";
      readonly stage: ChatRunStage;
      readonly event: Readonly<Record<string, unknown>>;
    };

export interface ChatRunEventPublisher {
  readonly publishAgentEvent: (event: AgentSessionEvent) => void;
  readonly publishPlanReview: (review: ChatRunPlanReview) => void;
  readonly finish: (closeStream: boolean) => Promise<void>;
}

/** Publishes ordered NDJSON chunks through the Workflow run's durable stream. */
export function createChatRunEventPublisher(stage: ChatRunStage): ChatRunEventPublisher {
  let writer: WritableStreamDefaultWriter<string>;
  try {
    writer = getWritable<string>().getWriter();
  } catch {
    // Unit tests call Step functions directly, outside a Workflow runtime.
    return {
      publishAgentEvent: () => {},
      publishPlanReview: () => {},
      finish: async () => {},
    };
  }

  let failed = false;
  let pending = Promise.resolve();
  const publish = (event: ChatRunEvent) => {
    pending = pending
      .then(async () => {
        if (!failed) await writer.write(`${JSON.stringify(event)}\n`);
      })
      .catch((error: unknown) => {
        if (!failed) {
          failed = true;
          console.error(
            `${localTimestamp()} [workflow-stream] write failed error=${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
  };

  publish({ type: "stage_start", stage });
  return {
    publishAgentEvent: (event) => {
      const projected = projectAgentSessionEvent(event);
      if (projected !== null) publish({ type: "agent_event", stage, event: projected });
    },
    publishPlanReview: (review) => publish({ type: "review_required", stage, review }),
    finish: async (closeStream) => {
      await pending;
      if (closeStream && !failed) {
        try {
          await writer.close();
        } catch (error) {
          console.error(
            `${localTimestamp()} [workflow-stream] close failed error=${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      writer.releaseLock();
    },
  };
}

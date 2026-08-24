import { DomainInvariantError } from "./plan-state.js";

export type DirectAgentRunLifecycle =
  | { readonly status: "pending"; readonly phase: "queued" }
  | { readonly status: "running"; readonly phase: "executing" }
  | { readonly status: "waiting_human"; readonly phase: "prompt_review" | "tool_review" }
  | { readonly status: "succeeded"; readonly phase: "completed" }
  | {
      readonly status: "cancelled";
      readonly phase: "queued" | "executing" | "prompt_review" | "tool_review" | "rejected";
    }
  | {
      readonly status: "failed";
      readonly phase: "queued" | "executing" | "prompt_review" | "tool_review";
    }
  | {
      readonly status: "outcome_unknown";
      readonly phase: "queued" | "executing" | "prompt_review" | "tool_review";
    };

const key = (state: DirectAgentRunLifecycle): string => `${state.status}/${state.phase}`;

const allowedTransitions: Readonly<Record<string, readonly string[]>> = {
  "pending/queued": [
    "running/executing",
    "cancelled/queued",
    "failed/queued",
    "outcome_unknown/queued",
  ],
  "running/executing": [
    "waiting_human/prompt_review",
    "waiting_human/tool_review",
    "succeeded/completed",
    "cancelled/executing",
    "failed/executing",
    "outcome_unknown/executing",
  ],
  "waiting_human/prompt_review": [
    "running/executing",
    "cancelled/rejected",
    "failed/prompt_review",
    "outcome_unknown/prompt_review",
  ],
  "waiting_human/tool_review": [
    "running/executing",
    "cancelled/tool_review",
    "failed/tool_review",
    "outcome_unknown/tool_review",
  ],
};

export function canTransitionDirectAgentRunLifecycle(
  from: DirectAgentRunLifecycle,
  to: DirectAgentRunLifecycle,
): boolean {
  return (allowedTransitions[key(from)] ?? []).includes(key(to));
}

export function transitionDirectAgentRunLifecycle(
  from: DirectAgentRunLifecycle,
  to: DirectAgentRunLifecycle,
): DirectAgentRunLifecycle {
  if (!canTransitionDirectAgentRunLifecycle(from, to)) {
    throw new DomainInvariantError(
      "direct_agent_run_transition_invalid",
      `非法Direct Agent Run转换:${key(from)}->${key(to)}`,
    );
  }
  return to;
}

export function isTerminalDirectAgentRunLifecycle(state: DirectAgentRunLifecycle): boolean {
  return (
    state.status === "succeeded" ||
    state.status === "failed" ||
    state.status === "cancelled" ||
    state.status === "outcome_unknown"
  );
}

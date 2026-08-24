import { describe, expect, it } from "vitest";
import { DomainInvariantError } from "./plan-state.js";
import {
  isTerminalDirectAgentRunLifecycle,
  transitionDirectAgentRunLifecycle,
} from "./direct-agent-run-lifecycle.js";

describe("Direct Agent Run生命周期", () => {
  it("允许执行与Prompt Review反复往返后成功", () => {
    const executing = transitionDirectAgentRunLifecycle(
      { status: "pending", phase: "queued" },
      { status: "running", phase: "executing" },
    );
    const waiting = transitionDirectAgentRunLifecycle(executing, {
      status: "waiting_human",
      phase: "prompt_review",
    });
    expect(
      transitionDirectAgentRunLifecycle(waiting, {
        status: "running",
        phase: "executing",
      }),
    ).toEqual(executing);
    const completed = transitionDirectAgentRunLifecycle(executing, {
      status: "succeeded",
      phase: "completed",
    });
    expect(isTerminalDirectAgentRunLifecycle(completed)).toBe(true);
  });

  it("reject进入cancelled/rejected且非法跳转失败关闭", () => {
    expect(
      transitionDirectAgentRunLifecycle(
        { status: "waiting_human", phase: "prompt_review" },
        { status: "cancelled", phase: "rejected" },
      ),
    ).toEqual({ status: "cancelled", phase: "rejected" });
    expect(() =>
      transitionDirectAgentRunLifecycle(
        { status: "pending", phase: "queued" },
        { status: "waiting_human", phase: "prompt_review" },
      ),
    ).toThrow(DomainInvariantError);
  });

  it("Tool Review是合法等待态，并能恢复执行或保守收敛unknown", () => {
    const waiting = transitionDirectAgentRunLifecycle(
      { status: "running", phase: "executing" },
      { status: "waiting_human", phase: "tool_review" },
    );
    expect(
      transitionDirectAgentRunLifecycle(waiting, {
        status: "running",
        phase: "executing",
      }),
    ).toEqual({ status: "running", phase: "executing" });
    expect(
      transitionDirectAgentRunLifecycle(waiting, {
        status: "outcome_unknown",
        phase: "tool_review",
      }),
    ).toEqual({ status: "outcome_unknown", phase: "tool_review" });
  });
});

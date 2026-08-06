import { describe, expect, it } from "vitest";
import { canTransitionRunStatus, isTerminalRunStatus, productRunStatuses } from "./run-state.js";

describe("product run state machine", () => {
  it("终态集合与技术合同一致", () => {
    expect(isTerminalRunStatus("succeeded")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
    expect(isTerminalRunStatus("cancelled")).toBe(true);
    expect(isTerminalRunStatus("outcome_unknown")).toBe(true);
    expect(isTerminalRunStatus("running")).toBe(false);
  });

  it("允许合法转换", () => {
    expect(canTransitionRunStatus("pending", "running")).toBe(true);
    expect(canTransitionRunStatus("running", "waiting_human")).toBe(true);
    expect(canTransitionRunStatus("waiting_human", "running")).toBe(true);
    expect(canTransitionRunStatus("running", "outcome_unknown")).toBe(true);
  });

  it("拒绝非法转换：终态不可再转换、不可跳过等待", () => {
    for (const terminal of ["succeeded", "failed", "cancelled", "outcome_unknown"] as const) {
      for (const target of productRunStatuses) {
        expect(canTransitionRunStatus(terminal, target)).toBe(false);
      }
    }
    expect(canTransitionRunStatus("pending", "succeeded")).toBe(false);
    expect(canTransitionRunStatus("pending", "waiting_human")).toBe(false);
  });
});

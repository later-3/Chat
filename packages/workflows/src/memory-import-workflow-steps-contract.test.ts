import { describe, expect, it } from "vitest";
import { callMemoryImportStep, reconcileMemoryImportStep } from "./memory-import-workflow-steps.js";

describe("Memory Import外部副作用Step重试合同", () => {
  it("外部write和原生幂等对账都禁用Workflow自动重试", () => {
    expect(callMemoryImportStep.maxRetries).toBe(0);
    expect(reconcileMemoryImportStep.maxRetries).toBe(0);
  });
});

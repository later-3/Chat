import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("workflow", async (importOriginal) => {
  const original = await importOriginal<typeof import("workflow")>();
  return { ...original, getStepMetadata: () => ({ attempt: 1 }) };
});

import { setWorkflowRuntimeContext } from "./runtime-context.js";
import { validateExecutionStep } from "./workflow-result-steps.js";

afterEach(() => setWorkflowRuntimeContext(undefined));

describe("Configurable validation策略", () => {
  it.each([true, false])("strictEvidence=%s原样交给Application权威验证", async (strictEvidence) => {
    const persistValidationResult = vi.fn(async () => ({
      outcome: "pass" as const,
      validationResultId: `val_${strictEvidence ? "strict" : "relaxed"}`,
      failures: [],
    }));
    setWorkflowRuntimeContext({
      api: { persistValidationResult } as never,
      bindings: {} as never,
      memoryBackends: { list: () => [], get: () => undefined },
      workflowMemoryProviders: {
        list: () => [],
        getQuery: () => undefined,
        getWrite: () => undefined,
      },
      trace: vi.fn(),
      now: () => "2026-08-10T00:00:00.000Z",
      bailian: {} as never,
      planner: vi.fn() as never,
      noteCapture: vi.fn() as never,
      executor: vi.fn() as never,
    });

    await validateExecutionStep({
      productRunId: "run_validation1",
      executionContractId: "exc_validation1",
      executionCandidateId: "xcd_validation1",
      workflowAttemptId: "att_validation1",
      strictEvidence,
    });

    expect(persistValidationResult).toHaveBeenCalledWith(
      expect.objectContaining({ strictEvidence }),
    );
  });
});

import { describe, expect, it } from "vitest";
import { validatePlanSemantics } from "./plan-validation.js";

const options = {
  maxSteps: 8,
  allowedCapabilities: new Set(["markdown_text_compose"]),
  allowedContextRefs: new Set([`ctx_1:1:${"a".repeat(64)}`]),
};

describe("Plan语义校验", () => {
  it("接受按拓扑顺序声明的步骤、白名单Capability与精确Context Ref", () => {
    expect(
      validatePlanSemantics(
        [
          {
            stepId: "collect",
            dependsOn: [],
            requestedCapabilities: [],
            inputRefs: [{ refId: "ctx_1", revision: 1, sha256: "a".repeat(64) }],
          },
          {
            stepId: "compose",
            dependsOn: ["collect"],
            requestedCapabilities: ["markdown_text_compose"],
            inputRefs: [],
          },
        ],
        options,
      ),
    ).toEqual([]);
  });

  it.each([
    [
      "重复stepId",
      [
        { stepId: "a", dependsOn: [], requestedCapabilities: [], inputRefs: [] },
        { stepId: "a", dependsOn: [], requestedCapabilities: [], inputRefs: [] },
      ],
    ],
    ["自依赖", [{ stepId: "a", dependsOn: ["a"], requestedCapabilities: [], inputRefs: [] }]],
    [
      "向后或悬空依赖",
      [
        { stepId: "a", dependsOn: ["b"], requestedCapabilities: [], inputRefs: [] },
        { stepId: "b", dependsOn: [], requestedCapabilities: [], inputRefs: [] },
      ],
    ],
    [
      "能力扩大",
      [{ stepId: "a", dependsOn: [], requestedCapabilities: ["shell_exec"], inputRefs: [] }],
    ],
    [
      "Context Ref篡改",
      [
        {
          stepId: "a",
          dependsOn: [],
          requestedCapabilities: [],
          inputRefs: [{ refId: "ctx_1", revision: 2, sha256: "a".repeat(64) }],
        },
      ],
    ],
  ])("拒绝%s", (_label, steps) => {
    expect(validatePlanSemantics(steps, options)).not.toEqual([]);
  });

  it("拒绝超过8步的计划", () => {
    const steps = Array.from({ length: 9 }, (_, index) => ({
      stepId: `s${String(index + 1)}`,
      dependsOn: [],
      requestedCapabilities: [],
      inputRefs: [],
    }));
    expect(validatePlanSemantics(steps, options)).toContainEqual(
      expect.objectContaining({ code: "step_limit_exceeded" }),
    );
  });
});

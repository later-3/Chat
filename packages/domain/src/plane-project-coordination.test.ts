import { describe, expect, it } from "vitest";
import {
  assertPlaneProjectOperationIntegrity,
  assertPlaneProjectOperationTransition,
  computePlaneProjectOperationRequestSha256,
  normalizePlaneProjectOperationIntent,
  type PlaneProjectOperationIntentShape,
  type PlaneProjectOperationShape,
} from "./plane-project-coordination.js";

const NOW = "2026-08-24T00:00:00.000Z";

const rawIntent: PlaneProjectOperationIntentShape = {
  kind: "ensure_work_item",
  externalSource: "later-agent",
  externalId: "content-xhs-sample",
  taskKey: "content-xhs-sample",
  name: "  交付内容样例  ",
  description: "从 Chat Work 投影。\r\n不制造第二事实。  ",
  priority: "medium",
  stateName: "  Selected  ",
  stateGroup: "unstarted",
};

function queued(): PlaneProjectOperationShape {
  const intent = normalizePlaneProjectOperationIntent(rawIntent);
  const identity = {
    planeProjectOperationId: "pco_domain1",
    planeProjectBindingId: "pvb_domain1",
    projectId: "prj_domain1",
    projectWorkId: "pwk_domain1",
    boundWorkRevision: 3,
    ownerPrincipalId: "usr_domain1",
    actorParticipantId: "ppt_domain1",
    kind: intent.kind,
    intent,
    providerExternalId: "chat-work:content-lab:content-xhs-sample",
  } as const;
  return {
    ...identity,
    requestSha256: computePlaneProjectOperationRequestSha256(identity),
    status: "queued",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("Plane项目协调Operation领域门", () => {
  it("先规范化Chat Work投影意图，再冻结Work revision和Provider外部身份", () => {
    const operation = queued();
    expect(operation.intent).toMatchObject({
      name: "交付内容样例",
      description: "从 Chat Work 投影。\n不制造第二事实。",
    });
    expect(() => assertPlaneProjectOperationIntegrity(operation)).not.toThrow();
    expect(() =>
      assertPlaneProjectOperationIntegrity({
        ...operation,
        providerExternalId: "content-xhs-sample",
      }),
    ).toThrow("requestSha256");
  });

  it("outcome_unknown没有回到dispatching的写重试边，只能只读对账收敛", () => {
    const prepared = queued();
    const dispatching = {
      ...prepared,
      status: "dispatching" as const,
      revision: 2,
      updatedAt: "2026-08-24T00:01:00.000Z",
    };
    expect(() =>
      assertPlaneProjectOperationTransition({ current: prepared, next: dispatching }),
    ).not.toThrow();

    const unknown = {
      ...dispatching,
      status: "outcome_unknown" as const,
      errorCode: "plane_operation_dispatch_unknown",
      revision: 3,
      updatedAt: "2026-08-24T00:02:00.000Z",
    };
    expect(() =>
      assertPlaneProjectOperationTransition({ current: dispatching, next: unknown }),
    ).not.toThrow();
    expect(() =>
      assertPlaneProjectOperationTransition({
        current: unknown,
        next: {
          ...unknown,
          status: "dispatching",
          errorCode: undefined,
          revision: 4,
          updatedAt: "2026-08-24T00:03:00.000Z",
        },
      }),
    ).toThrow("outcome_unknown -> dispatching");

    expect(() =>
      assertPlaneProjectOperationTransition({
        current: unknown,
        next: {
          ...unknown,
          status: "completed",
          errorCode: undefined,
          planeWorkItemId: "33333333-3333-4333-8333-333333333333",
          providerFingerprint: "a".repeat(64),
          revision: 4,
          updatedAt: "2026-08-24T00:03:00.000Z",
        },
      }),
    ).not.toThrow();
  });

  it("Operation转换不能偷换绑定的Chat Work revision或Provider身份", () => {
    const prepared = queued();
    const dispatching = {
      ...prepared,
      status: "dispatching" as const,
      revision: 2,
      updatedAt: "2026-08-24T00:01:00.000Z",
    };
    expect(() =>
      assertPlaneProjectOperationTransition({
        current: prepared,
        next: { ...dispatching, boundWorkRevision: 4 },
      }),
    ).toThrow("requestSha256");
    expect(() =>
      assertPlaneProjectOperationTransition({
        current: prepared,
        next: { ...dispatching, providerExternalId: "chat-work:other:content-xhs-sample" },
      }),
    ).toThrow("requestSha256");
  });
});

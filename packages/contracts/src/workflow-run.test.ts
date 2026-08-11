import { describe, expect, it } from "vitest";
import {
  nodeProductRefSchema,
  nodeRunTransitionSchema,
  nodeValueManifestSchema,
  workflowNodeRunSchema,
  workflowViewDefinitionSchema,
} from "./workflow-run.js";

const NOW = "2026-08-10T00:00:00.000Z";
const HASH = "a".repeat(64);

const viewFixture = {
  schemaVersion: "workflow-view-definition.v1",
  workflowViewDefinitionId: "wvd_test1",
  title: "测试工作流",
  source: {
    kind: "legacy_code",
    blueprintKey: "test",
    blueprintVersion: "1",
  },
  nodes: [
    {
      definitionNodeId: "start",
      nodeType: "test.start",
      nodeSchemaVersion: "1",
      title: "开始",
      kind: "task",
      optional: false,
    },
  ],
  edges: [],
  sha256: HASH,
  revision: 1,
  createdAt: NOW,
  updatedAt: NOW,
} as const;

describe("workflow projection contracts", () => {
  it("Workflow View及每层对象都strict，空图和非法身份失败关闭", () => {
    expect(workflowViewDefinitionSchema.parse(viewFixture)).toEqual(viewFixture);
    expect(() =>
      workflowViewDefinitionSchema.parse({ ...viewFixture, executor: "runStep" }),
    ).toThrow();
    expect(() =>
      workflowViewDefinitionSchema.parse({
        ...viewFixture,
        source: { ...viewFixture.source, hookToken: "secret" },
      }),
    ).toThrow();
    expect(() => workflowViewDefinitionSchema.parse({ ...viewFixture, nodes: [] })).toThrow();
    expect(() =>
      workflowViewDefinitionSchema.parse({
        ...viewFixture,
        nodes: [{ ...viewFixture.nodes[0], definitionNodeId: "0-array-index" }],
      }),
    ).toThrow();
  });

  it("Node Run、Transition和Manifest拒绝未知字段及正文口袋", () => {
    const nodeRun = workflowNodeRunSchema.parse({
      schemaVersion: "workflow-node-run.v1",
      workflowNodeRunId: "wnr_test1",
      productRunId: "run_test1",
      workflowViewDefinitionId: "wvd_test1",
      definitionNodeId: "start",
      nodeType: "test.start",
      nodeSchemaVersion: "1",
      executionPath: [],
      attemptNumber: 1,
      status: "queued",
      projectionSource: "runtime",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(() => workflowNodeRunSchema.parse({ ...nodeRun, workflowRunId: "private" })).toThrow();

    const transition = nodeRunTransitionSchema.parse({
      schemaVersion: "node-run-transition.v1",
      nodeRunTransitionId: "wnt_test1",
      workflowNodeRunId: nodeRun.workflowNodeRunId,
      nodeSequence: 1,
      toStatus: "queued",
      reasonKind: "queued",
      projectionSource: "runtime",
      occurredAt: NOW,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(() => nodeRunTransitionSchema.parse({ ...transition, stack: "private" })).toThrow();

    const manifest = nodeValueManifestSchema.parse({
      schemaVersion: "node-value-manifest.v1",
      nodeValueManifestId: "wvm_test1",
      workflowNodeRunId: nodeRun.workflowNodeRunId,
      direction: "input",
      slots: [
        {
          name: "source",
          refs: [{ kind: "message", id: "msg_test1", revision: 1, sha256: HASH, label: "输入" }],
        },
      ],
      sha256: HASH,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(() =>
      nodeValueManifestSchema.parse({
        ...manifest,
        slots: [{ ...manifest.slots[0], prompt: "不应进入Manifest" }],
      }),
    ).toThrow();
  });

  it.each([
    ["message", "msg_1"],
    ["context_package", "ctxp_1"],
    ["plan_revision", "plr_1"],
    ["approval_request", "apr_1"],
    ["decision", "dec_1"],
    ["execution_contract", "exc_1"],
    ["execution_candidate", "xcd_1"],
    ["validation_result", "val_1"],
    ["artifact", "art_1"],
  ] as const)("接受有限Product Ref %s并校验ID前缀", (kind, id) => {
    const ref = { kind, id, revision: 1, sha256: HASH, label: "安全标签" };
    expect(nodeProductRefSchema.parse(ref)).toEqual(ref);
    expect(() => nodeProductRefSchema.parse({ ...ref, id: "bad_1" })).toThrow();
    expect(() => nodeProductRefSchema.parse({ ...ref, content: "正文" })).toThrow();
  });
});

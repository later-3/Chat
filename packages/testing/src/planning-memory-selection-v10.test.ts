import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  CommandId,
  MemoryBackendId,
  PrincipalId,
  ProductRunId,
  WorkflowRunSpec,
} from "@chat/contracts";
import {
  beginPlanningContext,
  createProductSession,
  normalizeMemoryQueryResult,
  persistPlanningContextResult,
  preparePlanningMemoryContext,
  submitUserMessage,
  type ApplicationDeps,
  type IdFactory,
  type MemoryBackendPort,
} from "@chat/application";
import { SYSTEM_PLANNING_WORKFLOW_REVISION_ID } from "@chat/application/workflow-system-definitions";
import { hashCanonical } from "@chat/domain";
import { JsonProductStore } from "@chat/product-store-json";
import { createApiApp } from "@chat/api";
import { auditProductIntegrity } from "./product-integrity-auditor.js";

const NOW = "2026-08-10T12:00:00.000Z";
const OWNER = "usr_memoryselection" as PrincipalId;

function ids(): IdFactory {
  let sequence = 0;
  const next = (prefix: string) => `${prefix}_pmslv10${(++sequence).toString(36)}`;
  return {
    session: () => next("psn") as ReturnType<IdFactory["session"]>,
    message: () => next("msg") as ReturnType<IdFactory["message"]>,
    run: () => next("run") as ReturnType<IdFactory["run"]>,
    attempt: () => next("att") as ReturnType<IdFactory["attempt"]>,
    plan: () => next("pln") as ReturnType<IdFactory["plan"]>,
    planRevision: () => next("plr") as ReturnType<IdFactory["planRevision"]>,
    revisionInput: () => next("rin") as ReturnType<IdFactory["revisionInput"]>,
    approval: () => next("apr") as ReturnType<IdFactory["approval"]>,
    decision: () => next("dec") as ReturnType<IdFactory["decision"]>,
    executionContract: () => next("exc") as ReturnType<IdFactory["executionContract"]>,
    executionCandidate: () => next("xcd") as ReturnType<IdFactory["executionCandidate"]>,
    validationResult: () => next("val") as ReturnType<IdFactory["validationResult"]>,
    artifact: () => next("art") as ReturnType<IdFactory["artifact"]>,
    outbox: () => next("obx") as ReturnType<IdFactory["outbox"]>,
  };
}

function backend(): MemoryBackendPort {
  return {
    describe: () => ({
      backendId: "mbk_pmslv10" as MemoryBackendId,
      displayName: "v10 Memory Selection Fixture",
      kind: "memmy",
      adapterContractVersion: "memmy-http-query.v1",
      configured: true,
      authMode: "none",
      credentialRevision: "none",
      configurationFingerprint: "a".repeat(64),
      capabilities: {
        query: true,
        tags: true,
        layers: ["L1", "L2", "L3", "Skill"],
        maxLimit: 20,
        maxContextBudget: 8192,
      },
    }),
    health: async () => ({ status: "ready" }),
    query: async () => ({
      externalQueryId: "query-pmsl-v10",
      hitCount: 9,
      tokenEstimate: 90,
      sections: Array.from({ length: 9 }, (_, index) => ({
        externalObjectIds: [`memory-pmsl-${String(index + 1)}`],
        title: `Memory ${String(index + 1)}`,
        kind: "trace" as const,
        memoryLayer: "L2" as const,
        content: `MEMORY_SELECTION_CANARY_${String(index + 1)}`,
        tags: ["v10"],
        tokenEstimate: 10,
      })),
    }),
  };
}

function runSpecWithSha(runSpec: WorkflowRunSpec): WorkflowRunSpec {
  const payload = {
    definitionRef: runSpec.definitionRef,
    runner: runSpec.runner,
    semanticRoot: runSpec.semanticRoot,
    nodeResolutions: runSpec.nodeResolutions,
    resourceResolutions: runSpec.resourceResolutions,
    reviewResolutions: runSpec.reviewResolutions,
    ...(runSpec.businessInput !== undefined ? { businessInput: runSpec.businessInput } : {}),
    limits: runSpec.limits,
    executorManifest: runSpec.executorManifest,
  };
  return { ...runSpec, sha256: hashCanonical("workflow-run-spec.v1", payload) };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "chat-pmsl-v10-"));
  let tick = 0;
  let commandSequence = 0;
  const now = () => new Date(Date.parse(NOW) + tick++ * 1_000).toISOString();
  const store = await JsonProductStore.open({ filePath: join(directory, "product.json"), now });
  const memory = backend();
  const deps: ApplicationDeps = {
    store,
    now,
    ids: ids(),
    memoryBackends: {
      list: () => [memory],
      get: (backendId) => (backendId === "mbk_pmslv10" ? memory : undefined),
    },
  };
  const command = () => `cmd_pmslv10${(++commandSequence).toString(36)}` as CommandId;
  const { session } = await createProductSession(deps, {
    principalId: OWNER,
    commandId: command(),
    payload: {},
  });
  const source = await submitUserMessage(deps, {
    principalId: OWNER,
    sessionId: session.sessionId,
    commandId: command(),
    payload: {
      text: "先生成一组可复用Memory Snapshot。",
      context: {
        memory: {
          backendId: "mbk_pmslv10" as MemoryBackendId,
          requirement: "required",
          tags: ["v10"],
          layers: ["L2"],
          limit: 9,
          contextBudget: 1024,
        },
      },
    },
  });
  const sourceSnapshot = (await store.read({ kind: "committedSnapshot" })).snapshot;
  const attempt = Object.values(sourceSnapshot.entities.attempts).find(
    (item) => item.productRunId === source.run.productRunId && item.kind === "workflow",
  );
  if (attempt === undefined) throw new Error("fixture缺少Workflow Attempt");
  const begun = await beginPlanningContext(deps, {
    commandId: command(),
    productRunId: source.run.productRunId,
    attemptId: attempt.attemptId,
    planRevision: 1,
  });
  if (begun.status !== "dispatch_required") throw new Error("fixture缺少Memory dispatch");
  const result = normalizeMemoryQueryResult(
    begun.query,
    await memory.query({
      operationId: begun.query.memoryQueryId,
      productRunId: begun.query.productRunId,
      productSessionId: begun.query.productSessionId,
      query: begun.query.queryText,
      tags: begun.query.tags,
      layers: begun.query.layers,
      limit: begun.query.limit,
      contextBudget: begun.query.contextBudget,
    }),
  );
  await persistPlanningContextResult(deps, {
    commandId: command(),
    productRunId: source.run.productRunId,
    attemptId: attempt.attemptId,
    memoryQueryId: begun.query.memoryQueryId,
    result,
  });
  const prepared = (await store.read({ kind: "committedSnapshot" })).snapshot;
  const memories = Object.values(prepared.entities.memoryResultSnapshots).sort((left, right) =>
    left.memoryResultSnapshotId.localeCompare(right.memoryResultSnapshotId),
  );
  if (memories.length !== 9) throw new Error("fixture未生成9条Memory Snapshot");
  const definition =
    prepared.entities.workflowDefinitionRevisions[SYSTEM_PLANNING_WORKFLOW_REVISION_ID];
  if (definition === undefined) throw new Error("fixture缺少Planning Definition");

  const submitTarget = async (selectedCount: number) => {
    return submitUserMessage(deps, {
      principalId: OWNER,
      sessionId: session.sessionId,
      commandId: command(),
      payload: {
        text: `使用${String(selectedCount)}条冻结Memory规划。`,
        workflowSelection: {
          kind: "published_revision",
          workflowDefinitionRevisionId: definition.workflowDefinitionRevisionId,
          definitionSha256: definition.definitionSha256,
          runConfiguration: {
            schemaVersion: "workflow-run-configuration.v1",
            overrides: [
              {
                kind: "resource_selection",
                definitionNodeId: "planning.memory",
                resourceKind: "memory",
                required: false,
                selections: memories.slice(0, selectedCount).map((item) => ({
                  resourceId: item.memoryResultSnapshotId,
                  expectedRevision: item.revision,
                  expectedSha256: item.sha256,
                })),
              },
            ],
          },
        },
      },
    });
  };
  return { deps, store, command, memories, submitTarget };
}

function runSpecIdFor(
  snapshot: Awaited<ReturnType<ApplicationDeps["store"]["read"]>>["snapshot"],
  productRunId: ProductRunId,
) {
  const run = snapshot.entities.runs[productRunId];
  if (run?.workflowRunSpecId === undefined) throw new Error("target缺少RunSpec");
  return run.workflowRunSpecId;
}

describe("Store v10 Planning Memory Selection", () => {
  it("ready原子写Selection+Node+Manifest且command replay不重复", async () => {
    const test = await fixture();
    const target = await test.submitTarget(2);
    const before = (await test.store.read({ kind: "committedSnapshot" })).snapshot;
    const workflowRunSpecId = runSpecIdFor(before, target.run.productRunId);
    const commandId = test.command();
    const input = {
      schemaVersion: "chat-internal-runtime.v1" as const,
      commandId,
      productRunId: target.run.productRunId,
      workflowRunSpecId,
      definitionNodeId: "planning.memory",
      executionPath: [],
      attemptNumber: 1,
    };
    const prepared = await preparePlanningMemoryContext(test.deps, input);
    expect(prepared).toMatchObject({ status: "ready", totalContentCharacters: 50 });
    if (prepared.status !== "ready") throw new Error("Selection未ready");
    expect(prepared.snapshots.map((item) => item.content)).toEqual(
      test.memories.slice(0, 2).map((item) => item.content),
    );
    expect(await preparePlanningMemoryContext(test.deps, input)).toEqual(prepared);

    const snapshot = (await test.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(Object.values(snapshot.entities.planningMemorySelections)).toHaveLength(1);
    expect(auditProductIntegrity(snapshot)).toMatchObject({ ok: true, issues: [] });
    const node = Object.values(snapshot.entities.workflowNodeRuns).find(
      (item) =>
        item.productRunId === target.run.productRunId &&
        item.definitionNodeId === "planning.memory",
    );
    expect(node).toMatchObject({ status: "succeeded", executionPath: [], attemptNumber: 1 });
    const inputManifest =
      node?.inputManifestId === undefined
        ? undefined
        : snapshot.entities.nodeValueManifests[node.inputManifestId];
    const outputManifest =
      node?.outputManifestId === undefined
        ? undefined
        : snapshot.entities.nodeValueManifests[node.outputManifestId];
    expect(inputManifest?.slots[0]?.refs.map((ref) => ref.kind)).toEqual([
      "memory_result_snapshot",
      "memory_result_snapshot",
    ]);
    expect(outputManifest?.slots[0]?.refs[0]).toMatchObject({
      kind: "planning_memory_selection",
      id: prepared.selectionRef.planningMemorySelectionId,
      sha256: prepared.selectionRef.sha256,
    });
    const damaged = structuredClone(snapshot);
    const selection =
      damaged.entities.planningMemorySelections[prepared.selectionRef.planningMemorySelectionId];
    if (selection === undefined) throw new Error("fixture缺少Selection");
    selection.workflowRunSpecSha256 = "0".repeat(64);
    expect(auditProductIntegrity(damaged).issues.map((item) => item.code)).toContain(
      "planning_memory_selection.binding_invalid",
    );
  });

  it("未选择资源时不创建Selection并原子skipped", async () => {
    const test = await fixture();
    const target = await test.submitTarget(0);
    const snapshot = (await test.store.read({ kind: "committedSnapshot" })).snapshot;
    const workflowRunSpecId = runSpecIdFor(snapshot, target.run.productRunId);
    const result = await preparePlanningMemoryContext(test.deps, {
      schemaVersion: "chat-internal-runtime.v1",
      commandId: test.command(),
      productRunId: target.run.productRunId,
      workflowRunSpecId,
      definitionNodeId: "planning.memory",
      executionPath: [],
      attemptNumber: 1,
    });
    expect(result.status).toBe("none");
    const committed = (await test.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(Object.values(committed.entities.planningMemorySelections)).toHaveLength(0);
    expect(
      Object.values(committed.entities.workflowNodeRuns).find(
        (node) =>
          node.productRunId === target.run.productRunId &&
          node.definitionNodeId === "planning.memory",
      ),
    ).toMatchObject({ status: "skipped", outcomeCode: "optional_unavailable" });
  });

  it("Definition maxItems+1在编译期零写入拒绝", async () => {
    const test = await fixture();
    const before = (await test.store.read({ kind: "committedSnapshot" })).snapshot;
    await expect(test.submitTarget(9)).rejects.toMatchObject({ code: "policy_denied" });
    const after = (await test.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(after.storeRevision).toBe(before.storeRevision);
    expect(Object.keys(after.entities.runs)).toEqual(Object.keys(before.entities.runs));
    expect(Object.values(after.entities.planningMemorySelections)).toHaveLength(0);
  });

  it("RunSpec Memory hash被篡改后prepare失败且Selection/Node不半提交", async () => {
    const test = await fixture();
    const target = await test.submitTarget(1);
    const before = (await test.store.read({ kind: "committedSnapshot" })).snapshot;
    const workflowRunSpecId = runSpecIdFor(before, target.run.productRunId);
    await test.store.transact({
      commandId: test.command(),
      commandType: "SubmitUserMessage",
      requestSha256: hashCanonical("pmsl-v10-tamper.v1", { workflowRunSpecId }),
      mutate: (draft) => {
        const current = draft.entities.workflowRunSpecs[workflowRunSpecId];
        const run = draft.entities.runs[target.run.productRunId];
        if (current === undefined || run === undefined) throw new Error("tamper fixture missing");
        draft.entities.workflowRunSpecs[workflowRunSpecId] = runSpecWithSha({
          ...current,
          resourceResolutions: current.resourceResolutions.map((resource) =>
            resource.definitionNodeId === "planning.memory" && resource.resolution === "included"
              ? { ...resource, expectedSha256: "f".repeat(64) }
              : resource,
          ),
        });
        return {
          resultRefs: {
            messageId: run.sourceMessageId,
            productRunId: run.productRunId,
            workflowRunSpecId,
          },
        };
      },
    });
    const tampered = (await test.store.read({ kind: "committedSnapshot" })).snapshot;
    const nodeBefore = Object.values(tampered.entities.workflowNodeRuns).find(
      (node) =>
        node.productRunId === target.run.productRunId &&
        node.definitionNodeId === "planning.memory",
    );
    await expect(
      preparePlanningMemoryContext(test.deps, {
        schemaVersion: "chat-internal-runtime.v1",
        commandId: test.command(),
        productRunId: target.run.productRunId,
        workflowRunSpecId,
        definitionNodeId: "planning.memory",
        executionPath: [],
        attemptNumber: 1,
      }),
    ).rejects.toMatchObject({ code: "resource_stale" });
    const after = (await test.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(after.storeRevision).toBe(tampered.storeRevision);
    expect(Object.values(after.entities.planningMemorySelections)).toHaveLength(0);
    expect(after.entities.workflowNodeRuns[nodeBefore?.workflowNodeRunId ?? ""]).toEqual(
      nodeBefore,
    );
  });

  it("跨Owner Memory ref即使被私下塞入RunSpec也失败关闭", async () => {
    const test = await fixture();
    const attacker = "usr_memoryattacker" as PrincipalId;
    const { session } = await createProductSession(test.deps, {
      principalId: attacker,
      commandId: test.command(),
      payload: {},
    });
    const seeded = (await test.store.read({ kind: "committedSnapshot" })).snapshot;
    const definition =
      seeded.entities.workflowDefinitionRevisions[SYSTEM_PLANNING_WORKFLOW_REVISION_ID];
    if (definition === undefined) throw new Error("fixture缺少完整Planning Definition");
    const target = await submitUserMessage(test.deps, {
      principalId: attacker,
      sessionId: session.sessionId,
      commandId: test.command(),
      payload: {
        text: "攻击者自己的Planning Run。",
        workflowSelection: {
          kind: "published_revision",
          workflowDefinitionRevisionId: definition.workflowDefinitionRevisionId,
          definitionSha256: definition.definitionSha256,
          runConfiguration: {
            schemaVersion: "workflow-run-configuration.v1",
            overrides: [],
          },
        },
      },
    });
    const before = (await test.store.read({ kind: "committedSnapshot" })).snapshot;
    const workflowRunSpecId = runSpecIdFor(before, target.run.productRunId);
    const memory = test.memories[0];
    if (memory === undefined) throw new Error("fixture缺少Memory");
    await test.store.transact({
      commandId: test.command(),
      commandType: "SubmitUserMessage",
      requestSha256: hashCanonical("pmsl-v10-owner-tamper.v1", { workflowRunSpecId }),
      mutate: (draft) => {
        const current = draft.entities.workflowRunSpecs[workflowRunSpecId];
        const run = draft.entities.runs[target.run.productRunId];
        if (current === undefined || run === undefined) throw new Error("tamper fixture missing");
        draft.entities.workflowRunSpecs[workflowRunSpecId] = runSpecWithSha({
          ...current,
          resourceResolutions: current.resourceResolutions.map((resource) =>
            resource.definitionNodeId === "planning.memory" && resource.resourceKind === "memory"
              ? {
                  definitionNodeId: resource.definitionNodeId,
                  resourceKind: "memory" as const,
                  resourceId: memory.memoryResultSnapshotId,
                  expectedRevision: memory.revision,
                  expectedSha256: memory.sha256,
                  resolution: "included" as const,
                }
              : resource,
          ),
        });
        return {
          resultRefs: {
            messageId: run.sourceMessageId,
            productRunId: run.productRunId,
            workflowRunSpecId,
          },
        };
      },
    });
    const tampered = (await test.store.read({ kind: "committedSnapshot" })).snapshot;
    await expect(
      preparePlanningMemoryContext(test.deps, {
        schemaVersion: "chat-internal-runtime.v1",
        commandId: test.command(),
        productRunId: target.run.productRunId,
        workflowRunSpecId,
        definitionNodeId: "planning.memory",
        executionPath: [],
        attemptNumber: 1,
      }),
    ).rejects.toMatchObject({ code: "resource_stale" });
    const after = (await test.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(after.storeRevision).toBe(tampered.storeRevision);
    expect(Object.values(after.entities.planningMemorySelections)).toHaveLength(0);
  });

  it("私有HTTP边界要求Runtime凭据并strict拒绝浏览器伪造Selection", async () => {
    const test = await fixture();
    const target = await test.submitTarget(1);
    const snapshot = (await test.store.read({ kind: "committedSnapshot" })).snapshot;
    const workflowRunSpecId = runSpecIdFor(snapshot, target.run.productRunId);
    const app = createApiApp({
      traceSink: null,
      product: { deps: test.deps, principalId: OWNER },
      internalRuntime: { credential: "rtk_pmsl_v10" },
    });
    const body = {
      schemaVersion: "chat-internal-runtime.v1",
      commandId: test.command(),
      productRunId: target.run.productRunId,
      workflowRunSpecId,
      definitionNodeId: "planning.memory",
      executionPath: [],
      attemptNumber: 1,
    };
    const forbidden = await app.request("/internal/runtime/v1/prepare-planning-memory-context", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(forbidden.status).toBe(403);
    const invalid = await app.request("/internal/runtime/v1/prepare-planning-memory-context", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-chat-runtime-key": "rtk_pmsl_v10",
      },
      body: JSON.stringify({
        ...body,
        snapshots: [{ content: "浏览器不得传入正文" }],
      }),
    });
    expect(invalid.status).toBe(400);
    const ready = await app.request("/internal/runtime/v1/prepare-planning-memory-context", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-chat-runtime-key": "rtk_pmsl_v10",
      },
      body: JSON.stringify(body),
    });
    expect(ready.status, await ready.clone().text()).toBe(200);
    expect(await ready.json()).toMatchObject({
      status: "ready",
      productRunId: target.run.productRunId,
    });
  });
});

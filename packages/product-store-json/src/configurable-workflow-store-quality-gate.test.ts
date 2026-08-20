import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmptySnapshot, type CommandId, type ProductSnapshot } from "@chat/contracts";
import {
  createProductSession,
  submitUserMessage,
  StoreCorruptedError,
  type ApplicationDeps,
  type IdFactory,
} from "@chat/application";
import {
  createSystemNoteDefinition,
  LEGACY_SYSTEM_PLANNING_WORKFLOW_REVISION_ID,
  LEGACY_SYSTEM_PLANNING_WORKFLOW_VIEW_ID,
  SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID,
  SYSTEM_PLANNING_WORKFLOW_REVISION_ID,
  SYSTEM_PLANNING_WORKFLOW_VIEW_ID,
  SYSTEM_SIMPLE_PLANNING_WORKFLOW_DEFINITION_ID,
  SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID,
  SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID,
  SYSTEM_MEMORY_PLANNING_WORKFLOW_DEFINITION_ID,
  SYSTEM_MEMORY_PLANNING_WORKFLOW_REVISION_ID,
  SYSTEM_MEMORY_PLANNING_WORKFLOW_VIEW_ID,
  SYSTEM_NOTE_WORKFLOW_DEFINITION_ID,
  SYSTEM_NOTE_WORKFLOW_REVISION_ID,
  SYSTEM_NOTE_WORKFLOW_VIEW_ID,
  SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID,
  SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID,
  SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID,
  createSystemDirectAgentDefinition,
} from "@chat/application/workflow-system-definitions";
import { JsonProductStore } from "./json-product-store.js";
import { productSnapshotV6Schema } from "./legacy-v6.js";
import { migrateProductSnapshotV6ToV7 } from "./migrate-v6-to-v7.js";
import { migrateProductSnapshotV7ToV8 } from "./migrate-v7-to-v8.js";
import { migrateProductSnapshotV8ToV9 } from "./migrate-v8-to-v9.js";
import { migrateProductSnapshotV9ToV10 } from "./migrate-v9-to-v10.js";
import { migrateProductSnapshotV10ToV11 } from "./migrate-v10-to-v11.js";
import { migrateProductSnapshotV11ToV12 } from "./migrate-v11-to-v12.js";
import { migrateProductSnapshotV12ToV13 } from "./migrate-v12-to-v13.js";
import { migrateProductSnapshotV13ToV14 } from "./migrate-v13-to-v14.js";
import { migrateProductSnapshotV14ToV15 } from "./migrate-v14-to-v15.js";
import { migrateProductSnapshotV15ToV16 } from "./migrate-v15-to-v16.js";
import { productSnapshotV13Schema } from "./legacy-v13.js";
import { assertSnapshotIntegrity } from "./snapshot-integrity.js";
import { computePromptFragmentRevisionSha256 } from "@chat/domain";

const NOW = "2026-08-10T12:00:00.000Z";

function ids(): IdFactory {
  let sequence = 0;
  const next = (prefix: string) => `${prefix}_storequality${(++sequence).toString(36)}`;
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

function emptyV6() {
  const current = createEmptySnapshot(NOW);
  const entities = structuredClone(current.entities) as unknown as Record<string, unknown>;
  for (const key of [
    "workflowDefinitions",
    "workflowDefinitionRevisions",
    "workflowRunSpecs",
    "notes",
    "noteRevisions",
    "noteCandidates",
    "noteDecisions",
    "rules",
    "ruleRevisions",
    "ruleTags",
    "ruleDecisions",
    "ruleSelections",
    "planningProjectContexts",
    "planningMemorySelections",
    "workflowPolicyResolutions",
    "workflowMemoryQueries",
    "workflowMemorySnapshots",
    "workflowMemoryContexts",
    "memoryWriteIntents",
    "memoryWriteResults",
    "directAgentCandidates",
    "promptReviewRequests",
    "promptReviewDecisions",
    "promptFragments",
    "promptFragmentRevisions",
    "promptAssemblies",
  ]) {
    delete entities[key];
  }
  return productSnapshotV6Schema.parse({
    schemaVersion: "chat-product-store.v6",
    storeRevision: 0,
    committedAt: NOW,
    entities,
    commandReceipts: {},
    outbox: {},
  });
}

async function configurableSnapshot(): Promise<ProductSnapshot> {
  const directory = await mkdtemp(join(tmpdir(), "chat-store-s4-quality-"));
  let clock = 0;
  const now = () => new Date(Date.parse(NOW) + clock++ * 1_000).toISOString();
  const store = await JsonProductStore.open({ filePath: join(directory, "product.json"), now });
  const deps: ApplicationDeps = { store, now, ids: ids() };
  const { session } = await createProductSession(deps, {
    principalId: "usr_storequality" as never,
    commandId: "cmd_storequalitysession" as CommandId,
    payload: {},
  });
  await submitUserMessage(deps, {
    principalId: "usr_storequality" as never,
    sessionId: session.sessionId,
    commandId: "cmd_storequalitymessage" as CommandId,
    payload: { text: "验证S4持久事实损坏时失败关闭" },
  });
  return structuredClone(
    (await store.read({ kind: "committedSnapshot" })).snapshot,
  ) as ProductSnapshot;
}

describe("S4 v6→v7迁移与持久事实损坏质量门", () => {
  it("空v6迁移确定、Seed ID/Hash稳定，并可继续进入当前Store版本", () => {
    const legacy = emptyV6();
    const first = migrateProductSnapshotV6ToV7(legacy);
    const second = migrateProductSnapshotV6ToV7(structuredClone(legacy));
    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe("chat-product-store.v7");
    expect(first.storeRevision).toBe(legacy.storeRevision);
    expect(first.committedAt).toBe(legacy.committedAt);
    expect(
      first.entities.workflowDefinitionRevisions[LEGACY_SYSTEM_PLANNING_WORKFLOW_REVISION_ID],
    ).toEqual(
      second.entities.workflowDefinitionRevisions[LEGACY_SYSTEM_PLANNING_WORKFLOW_REVISION_ID],
    );
    expect(first.entities.workflowViewDefinitions[LEGACY_SYSTEM_PLANNING_WORKFLOW_VIEW_ID]).toEqual(
      second.entities.workflowViewDefinitions[LEGACY_SYSTEM_PLANNING_WORKFLOW_VIEW_ID],
    );
    const current = migrateProductSnapshotV15ToV16(
      migrateProductSnapshotV14ToV15(
        migrateProductSnapshotV13ToV14(
          migrateProductSnapshotV12ToV13(
            migrateProductSnapshotV11ToV12(
              migrateProductSnapshotV10ToV11(
                migrateProductSnapshotV9ToV10(
                  migrateProductSnapshotV8ToV9(migrateProductSnapshotV7ToV8(first)),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    expect(
      current.entities.workflowDefinitionRevisions[SYSTEM_NOTE_WORKFLOW_REVISION_ID]?.state,
    ).toBe("published");
    expect(
      current.entities.workflowViewDefinitions[SYSTEM_NOTE_WORKFLOW_VIEW_ID]?.source,
    ).toMatchObject({
      blueprintKey: "note",
      workflowDefinitionId: SYSTEM_NOTE_WORKFLOW_DEFINITION_ID,
    });
    const noteRevision =
      current.entities.workflowDefinitionRevisions[SYSTEM_NOTE_WORKFLOW_REVISION_ID];
    const noteLoop = noteRevision?.semanticRoot.elements[0];
    expect(noteLoop).toMatchObject({
      kind: "bounded_loop",
      outcomeFromDefinitionNodeId: "note.review",
      continueOutcomes: ["request_revision"],
      exitOutcomes: ["approved", "rejected"],
      maxIterations: 2,
      exceededPolicy: "fail",
    });
    expect(
      current.entities.workflowViewDefinitions[SYSTEM_NOTE_WORKFLOW_VIEW_ID]?.edges,
    ).toContainEqual({
      from: "note.review",
      to: "note.extract",
      kind: "loop_back",
      outcomeCode: "request_revision",
    });
    expect(() => assertSnapshotIntegrity(current)).not.toThrow();
  });

  it("v7→v8遇到system Note固定ID异语义对象时失败关闭", () => {
    const legacy = migrateProductSnapshotV6ToV7(emptyV6());
    const conflicting = structuredClone(legacy);
    const seed = createSystemNoteDefinition(NOW);
    conflicting.entities.workflowDefinitions[SYSTEM_NOTE_WORKFLOW_DEFINITION_ID] = {
      ...seed.definition,
      title: "伪造的系统笔记流程",
    };
    expect(() => migrateProductSnapshotV7ToV8(conflicting)).toThrow("固定ID已被异语义对象占用");
  });

  it("v9→v11保留完整Planning并新增独立无Memory的Simple Planning", () => {
    const v7 = migrateProductSnapshotV6ToV7(emptyV6());
    const v9 = migrateProductSnapshotV8ToV9(migrateProductSnapshotV7ToV8(v7));
    expect(
      v9.entities.workflowDefinitionRevisions[LEGACY_SYSTEM_PLANNING_WORKFLOW_REVISION_ID],
    ).toMatchObject({ definitionRevision: 1, state: "published" });
    const v10 = migrateProductSnapshotV9ToV10(v9);
    const first = migrateProductSnapshotV10ToV11(v10);
    const second = migrateProductSnapshotV10ToV11(
      migrateProductSnapshotV9ToV10(structuredClone(v9)),
    );
    expect(first).toEqual(second);
    expect(v10.schemaVersion).toBe("chat-product-store.v10");
    expect(first.schemaVersion).toBe("chat-product-store.v11");
    expect(first.entities.planningMemorySelections).toEqual({});
    expect(first.entities.workflowPolicyResolutions).toEqual({});
    expect(
      first.entities.workflowDefinitionRevisions[LEGACY_SYSTEM_PLANNING_WORKFLOW_REVISION_ID],
    ).toMatchObject({ definitionRevision: 1, state: "superseded" });
    expect(
      first.entities.workflowDefinitionRevisions[SYSTEM_PLANNING_WORKFLOW_REVISION_ID],
    ).toMatchObject({ definitionRevision: 2, state: "published" });
    expect(
      first.entities.workflowDefinitionRevisions[SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID],
    ).toMatchObject({ definitionRevision: 1, state: "published" });
    expect(
      first.entities.workflowDefinitionRevisions[
        SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID
      ]?.semanticRoot.elements.some(
        (element) => element.kind === "task" && element.nodeType === "context.memory",
      ),
    ).toBe(false);
    expect(
      first.entities.workflowDefinitions[SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID]
        ?.publishedRevisionId,
    ).toBe(SYSTEM_PLANNING_WORKFLOW_REVISION_ID);
    expect(
      first.entities.workflowDefinitions[SYSTEM_SIMPLE_PLANNING_WORKFLOW_DEFINITION_ID]
        ?.publishedRevisionId,
    ).toBe(SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID);
    expect(first.entities.workflowViewDefinitions[LEGACY_SYSTEM_PLANNING_WORKFLOW_VIEW_ID]).toEqual(
      v9.entities.workflowViewDefinitions[LEGACY_SYSTEM_PLANNING_WORKFLOW_VIEW_ID],
    );
    expect(
      first.entities.workflowViewDefinitions[SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID]?.nodes.map(
        (node) => node.nodeType,
      ),
    ).toEqual([
      "agent.plan",
      "human.plan_review",
      "execute.plan",
      "result.validate",
      "product.commit",
    ]);
    expect(() =>
      assertSnapshotIntegrity(
        migrateProductSnapshotV15ToV16(
          migrateProductSnapshotV14ToV15(
            migrateProductSnapshotV13ToV14(
              migrateProductSnapshotV12ToV13(migrateProductSnapshotV11ToV12(first)),
            ),
          ),
        ),
      ),
    ).not.toThrow();
  });

  it("v11→v12保留Simple Planning并新增完全独立的Memory Planning和空Memory事实", () => {
    const v7 = migrateProductSnapshotV6ToV7(emptyV6());
    const v9 = migrateProductSnapshotV8ToV9(migrateProductSnapshotV7ToV8(v7));
    const v11 = migrateProductSnapshotV10ToV11(migrateProductSnapshotV9ToV10(v9));
    const first = migrateProductSnapshotV11ToV12(v11);
    const second = migrateProductSnapshotV11ToV12(structuredClone(v11));

    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe("chat-product-store.v12");
    expect(
      first.entities.workflowDefinitions[SYSTEM_MEMORY_PLANNING_WORKFLOW_DEFINITION_ID],
    ).toMatchObject({
      key: "system.memory-planning",
      publishedRevisionId: SYSTEM_MEMORY_PLANNING_WORKFLOW_REVISION_ID,
    });
    expect(
      first.entities.workflowDefinitionRevisions[
        SYSTEM_MEMORY_PLANNING_WORKFLOW_REVISION_ID
      ]?.semanticRoot.elements.slice(0, 2),
    ).toMatchObject([
      { kind: "task", nodeType: "memory.query" },
      { kind: "task", nodeType: "memory.write" },
    ]);
    expect(
      first.entities.workflowViewDefinitions[SYSTEM_MEMORY_PLANNING_WORKFLOW_VIEW_ID],
    ).toBeDefined();
    expect(first.entities.workflowMemoryQueries).toEqual({});
    expect(first.entities.workflowMemorySnapshots).toEqual({});
    expect(first.entities.workflowMemoryContexts).toEqual({});
    expect(first.entities.memoryWriteIntents).toEqual({});
    expect(first.entities.memoryWriteResults).toEqual({});
    expect(
      first.entities.workflowDefinitionRevisions[SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID],
    ).toEqual(
      v11.entities.workflowDefinitionRevisions[SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID],
    );
    expect(() =>
      assertSnapshotIntegrity(
        migrateProductSnapshotV15ToV16(
          migrateProductSnapshotV14ToV15(
            migrateProductSnapshotV13ToV14(migrateProductSnapshotV12ToV13(first)),
          ),
        ),
      ),
    ).not.toThrow();
  });

  it("v12→v13保留旧事实、种入单节点/16次审核预算的Direct Agent并只新增空集合", () => {
    const v7 = migrateProductSnapshotV6ToV7(emptyV6());
    const v9 = migrateProductSnapshotV8ToV9(migrateProductSnapshotV7ToV8(v7));
    const v11 = migrateProductSnapshotV10ToV11(migrateProductSnapshotV9ToV10(v9));
    const v12 = migrateProductSnapshotV11ToV12(v11);
    const first = migrateProductSnapshotV12ToV13(v12);
    const second = migrateProductSnapshotV12ToV13(structuredClone(v12));

    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe("chat-product-store.v13");
    expect(first.entities.directAgentCandidates).toEqual({});
    expect(first.entities.promptReviewRequests).toEqual({});
    expect(first.entities.promptReviewDecisions).toEqual({});
    expect(
      first.entities.workflowDefinitions[SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID],
    ).toMatchObject({
      key: "system.direct-agent",
      blueprintKey: "direct",
      publishedRevisionId: SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID,
    });
    expect(
      first.entities.workflowViewDefinitions[SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID]?.nodes.map(
        (node) => node.nodeType,
      ),
    ).toEqual(["agent.direct"]);
    const directNode =
      first.entities.workflowDefinitionRevisions[SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID]
        ?.semanticRoot.elements[0];
    expect(directNode).toMatchObject({
      kind: "composite",
      nodeType: "agent.direct",
      config: { capabilityMode: "read_only", promptReviewMode: "manual" },
    });
    expect(() =>
      assertSnapshotIntegrity(
        migrateProductSnapshotV15ToV16(
          migrateProductSnapshotV14ToV15(migrateProductSnapshotV13ToV14(first)),
        ),
      ),
    ).not.toThrow();
  });

  it("v12→v13遇到Direct系统固定ID异语义对象时失败关闭", () => {
    const v7 = migrateProductSnapshotV6ToV7(emptyV6());
    const v9 = migrateProductSnapshotV8ToV9(migrateProductSnapshotV7ToV8(v7));
    const v11 = migrateProductSnapshotV10ToV11(migrateProductSnapshotV9ToV10(v9));
    const v12 = migrateProductSnapshotV11ToV12(v11);
    const conflicting = structuredClone(v12);
    const seed = createSystemDirectAgentDefinition(NOW);
    conflicting.entities.workflowDefinitions[SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID] = {
      ...seed.definition,
      title: "伪造Direct Agent流程",
    };
    expect(() => migrateProductSnapshotV12ToV13(conflicting)).toThrow("固定ID已被异语义对象占用");
  });

  it("v13→v14只新增空Prompt Studio集合并保持全部旧事实逐项不变", () => {
    const v7 = migrateProductSnapshotV6ToV7(emptyV6());
    const v9 = migrateProductSnapshotV8ToV9(migrateProductSnapshotV7ToV8(v7));
    const v11 = migrateProductSnapshotV10ToV11(migrateProductSnapshotV9ToV10(v9));
    const v13 = productSnapshotV13Schema.parse(
      migrateProductSnapshotV12ToV13(migrateProductSnapshotV11ToV12(v11)),
    );
    const migrated = migrateProductSnapshotV13ToV14(v13);
    expect(migrated.schemaVersion).toBe("chat-product-store.v14");
    expect(migrated.entities.promptFragments).toEqual({});
    expect(migrated.entities.promptFragmentRevisions).toEqual({});
    expect(migrated.entities).toEqual({
      ...v13.entities,
      promptFragments: {},
      promptFragmentRevisions: {},
    });
    expect(migrated.storeRevision).toBe(v13.storeRevision);
    expect(migrated.committedAt).toBe(v13.committedAt);
  });

  it("v14→v15把旧Prompt Fragment迁移为global并新增空Assembly集合", () => {
    const v7 = migrateProductSnapshotV6ToV7(emptyV6());
    const v9 = migrateProductSnapshotV8ToV9(migrateProductSnapshotV7ToV8(v7));
    const v11 = migrateProductSnapshotV10ToV11(migrateProductSnapshotV9ToV10(v9));
    const v14 = migrateProductSnapshotV13ToV14(
      migrateProductSnapshotV12ToV13(migrateProductSnapshotV11ToV12(v11)),
    );
    const revisionShape = {
      promptFragmentId: "pfg_migrationglobal1",
      revision: 1,
      regionKey: "experience",
      title: "历史全局经验",
      content: { kind: "markdown" as const, bodyMarkdown: "先验证，再提交。" },
      authoredByPrincipalId: "usr_migration",
    };
    const revisionSha256 = computePromptFragmentRevisionSha256(revisionShape);
    v14.entities.promptFragmentRevisions["pfr_migrationglobal1"] = {
      schemaVersion: "prompt-fragment-revision.v1",
      promptFragmentRevisionId: "pfr_migrationglobal1" as never,
      ...revisionShape,
      promptFragmentId: revisionShape.promptFragmentId as never,
      authoredByPrincipalId: revisionShape.authoredByPrincipalId as never,
      sha256: revisionSha256 as never,
      createdAt: NOW,
    };
    v14.entities.promptFragments["pfg_migrationglobal1"] = {
      schemaVersion: "prompt-fragment.v1",
      promptFragmentId: "pfg_migrationglobal1" as never,
      ownerPrincipalId: "usr_migration" as never,
      status: "active",
      currentRevisionId: "pfr_migrationglobal1" as never,
      currentRevisionNumber: 1,
      currentRevisionSha256: revisionSha256 as never,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };

    const migrated = migrateProductSnapshotV14ToV15(v14);
    expect(migrated.schemaVersion).toBe("chat-product-store.v15");
    expect(migrated.entities.promptFragments["pfg_migrationglobal1"]?.scope).toEqual({
      kind: "global",
    });
    expect(migrated.entities.promptFragmentRevisions).toEqual(v14.entities.promptFragmentRevisions);
    expect(migrated.entities.promptAssemblies).toEqual({});
    expect(() => assertSnapshotIntegrity(migrateProductSnapshotV15ToV16(migrated))).not.toThrow();

    const broken = structuredClone(migrated);
    broken.entities.promptFragments["pfg_migrationglobal1"]!.scope = {
      kind: "workspace",
      rootId: "not-a-root",
    } as never;
    expect(() => assertSnapshotIntegrity(migrateProductSnapshotV15ToV16(broken))).toThrow(
      /root_|Scope非法/u,
    );
  });

  it.each([
    [
      "Definition",
      (snapshot: ProductSnapshot) => {
        const revision =
          snapshot.entities.workflowDefinitionRevisions[SYSTEM_PLANNING_WORKFLOW_REVISION_ID];
        if (revision === undefined) throw new Error("fixture缺少Definition Revision");
        const firstElement = revision.semanticRoot.elements[0];
        if (firstElement === undefined || firstElement.kind !== "task") {
          throw new Error("fixture缺少首个Task");
        }
        firstElement.config = { required: true };
      },
    ],
    [
      "SystemNoteSeed",
      (snapshot: ProductSnapshot) => {
        const revision =
          snapshot.entities.workflowDefinitionRevisions[SYSTEM_NOTE_WORKFLOW_REVISION_ID];
        if (revision === undefined) throw new Error("fixture缺少Note Definition Revision");
        revision.title = "被篡改的Note系统流程";
      },
    ],
    [
      "RunSpec",
      (snapshot: ProductSnapshot) => {
        const runSpec = Object.values(snapshot.entities.workflowRunSpecs)[0];
        if (runSpec === undefined) throw new Error("fixture缺少RunSpec");
        runSpec.sha256 = "0".repeat(64);
      },
    ],
    [
      "View",
      (snapshot: ProductSnapshot) => {
        const view = snapshot.entities.workflowViewDefinitions[SYSTEM_PLANNING_WORKFLOW_VIEW_ID];
        if (view === undefined) throw new Error("fixture缺少View");
        view.title = "被篡改的系统图";
      },
    ],
    [
      "Runner",
      (snapshot: ProductSnapshot) => {
        const run = Object.values(snapshot.entities.runs)[0];
        if (run === undefined) throw new Error("fixture缺少Run");
        run.runnerBundleVersion = "configurable-planning.bundle.tampered";
      },
    ],
    [
      "Receipt",
      (snapshot: ProductSnapshot) => {
        const receipt = Object.values(snapshot.commandReceipts).find(
          (candidate) => candidate.commandType === "SubmitUserMessage",
        );
        if (receipt === undefined) throw new Error("fixture缺少Submit Receipt");
        receipt.resultRefs["workflowRunSpecId"] = "wrs_missingquality1";
      },
    ],
  ])("%s损坏后完整性校验失败关闭", async (_label, tamper) => {
    const snapshot = await configurableSnapshot();
    expect(() => assertSnapshotIntegrity(snapshot)).not.toThrow();
    tamper(snapshot);
    expect(() => assertSnapshotIntegrity(snapshot)).toThrow(StoreCorruptedError);
  });
});

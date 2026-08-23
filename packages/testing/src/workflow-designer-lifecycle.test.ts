import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  changeWorkflowDefinitionArchiveStatus,
  createWorkflowDefinitionCopy,
  getWorkflowDefinitionDetail,
  publishWorkflowDefinition,
  saveWorkflowAgentNodeConfiguration,
  saveWorkflowDefinitionDraft,
  validateWorkflowDefinition,
  type ApplicationDeps,
  type IdFactory,
} from "@chat/application";
import {
  SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID,
  SYSTEM_MEMORY_PLANNING_WORKFLOW_REVISION_ID,
  SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID,
  SYSTEM_PLANNING_WORKFLOW_REVISION_ID,
} from "@chat/application/workflow-system-definitions";
import {
  type CommandId,
  type PrincipalId,
  type WorkflowDefinitionId,
  type WorkflowDefinitionSequence,
} from "@chat/contracts";
import { hashCanonical } from "@chat/domain";
import { JsonProductStore } from "@chat/product-store-json";
import { createApiApp } from "@chat/api";

const NOW = "2026-08-10T14:00:00.000Z";
const OWNER = "usr_designerowner" as PrincipalId;
const OTHER = "usr_designerother" as PrincipalId;

function unusedIds(): IdFactory {
  const invalid = () => {
    throw new Error("designer lifecycle不应分配Product Run ID");
  };
  return {
    session: invalid,
    message: invalid,
    run: invalid,
    attempt: invalid,
    plan: invalid,
    planRevision: invalid,
    revisionInput: invalid,
    approval: invalid,
    decision: invalid,
    executionContract: invalid,
    executionCandidate: invalid,
    validationResult: invalid,
    artifact: invalid,
    outbox: invalid,
  } as IdFactory;
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "chat-designer-lifecycle-"));
  const filePath = join(directory, "product.json");
  let tick = 0;
  const now = () => new Date(Date.parse(NOW) + tick++ * 1_000).toISOString();
  const store = await JsonProductStore.open({ filePath, now });
  const deps: ApplicationDeps = { store, now, ids: unusedIds() };
  const app = createApiApp({ traceSink: null, product: { deps, principalId: OWNER } });
  const { snapshot } = await store.read({ kind: "committedSnapshot" });
  const system =
    snapshot.entities.workflowDefinitionRevisions[SYSTEM_PLANNING_WORKFLOW_REVISION_ID];
  const memorySystem =
    snapshot.entities.workflowDefinitionRevisions[SYSTEM_MEMORY_PLANNING_WORKFLOW_REVISION_ID];
  const directSystem =
    snapshot.entities.workflowDefinitionRevisions[SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID];
  if (system === undefined) throw new Error("system seed missing");
  if (memorySystem === undefined) throw new Error("memory system seed missing");
  if (directSystem === undefined) throw new Error("direct system seed missing");
  return { deps, store, filePath, system, memorySystem, directSystem, app };
}

const command = (value: string) => value as CommandId;

describe("S6 Workflow Definition生命周期", () => {
  it("Agent节点配置从系统Workflow派生个人版本，并在个人Workflow上发布下一Revision", async () => {
    const { deps, store, system } = await fixture();
    const beforeSystemNoop = (await store.read({ kind: "committedSnapshot" })).snapshot
      .storeRevision;
    await expect(
      saveWorkflowAgentNodeConfiguration(deps, {
        principalId: OWNER,
        commandId: command("cmd_designeragentsystemnoop1"),
        payload: {
          sourceWorkflowDefinitionRevisionId: system.workflowDefinitionRevisionId,
          sourceDefinitionSha256: system.definitionSha256,
          definitionNodeId: "planning.plan",
          agentKey: "planner",
        },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect((await store.read({ kind: "committedSnapshot" })).snapshot.storeRevision).toBe(
      beforeSystemNoop,
    );
    const first = await saveWorkflowAgentNodeConfiguration(deps, {
      principalId: OWNER,
      commandId: command("cmd_designeragentsystem1"),
      payload: {
        sourceWorkflowDefinitionRevisionId: system.workflowDefinitionRevisionId,
        sourceDefinitionSha256: system.definitionSha256,
        definitionNodeId: "planning.plan",
        agentKey: "planner",
        promptOverrideMarkdown: "你是这个Workflow专属的规划Agent。",
      },
    });
    expect(first.definition).toMatchObject({
      ownerKind: "principal",
      ownerPrincipalId: OWNER,
      revision: 1,
      publishedRevision: { state: "published", definitionRevision: 1 },
    });
    if (first.definition.compatibility !== "editable") throw new Error("个人Workflow不可读");
    expect(findNodeConfig(first.definition.semanticRoot, "planning.plan")).toMatchObject({
      agentKey: "planner",
      agentPromptOverride: "你是这个Workflow专属的规划Agent。",
    });

    const firstPublished = first.definition.publishedRevision!;
    const second = await saveWorkflowAgentNodeConfiguration(deps, {
      principalId: OWNER,
      commandId: command("cmd_designeragentpersonal2"),
      payload: {
        sourceWorkflowDefinitionRevisionId: firstPublished.workflowDefinitionRevisionId,
        sourceDefinitionSha256: firstPublished.definitionSha256,
        definitionNodeId: "planning.plan",
        agentKey: "planner",
        promptOverrideMarkdown: "你是第二版Workflow专属的规划Agent。",
      },
    });
    expect(second.definition.workflowDefinitionId).toBe(first.definition.workflowDefinitionId);
    expect(second.definition).toMatchObject({
      revision: 2,
      publishedRevision: { state: "published", definitionRevision: 2 },
    });
    if (second.definition.compatibility !== "editable") throw new Error("第二版Workflow不可读");
    expect(findNodeConfig(second.definition.semanticRoot, "planning.plan")).toMatchObject({
      agentKey: "planner",
      agentPromptOverride: "你是第二版Workflow专属的规划Agent。",
    });

    const snapshot = (await store.read({ kind: "committedSnapshot" })).snapshot;
    expect(
      snapshot.entities.workflowDefinitionRevisions[firstPublished.workflowDefinitionRevisionId],
    ).toMatchObject({ state: "superseded" });
    expect(
      snapshot.entities.workflowDefinitionRevisions[system.workflowDefinitionRevisionId],
    ).toMatchObject({
      state: "published",
      definitionSha256: system.definitionSha256,
    });

    const beforePersonalNoop = snapshot.storeRevision;
    await expect(
      saveWorkflowAgentNodeConfiguration(deps, {
        principalId: OWNER,
        commandId: command("cmd_designeragentpersonalnoop1"),
        payload: {
          sourceWorkflowDefinitionRevisionId:
            second.definition.publishedRevision!.workflowDefinitionRevisionId,
          sourceDefinitionSha256: second.definition.publishedRevision!.definitionSha256,
          definitionNodeId: "planning.plan",
          agentKey: "planner",
          promptOverrideMarkdown: "你是第二版Workflow专属的规划Agent。",
        },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect((await store.read({ kind: "committedSnapshot" })).snapshot.storeRevision).toBe(
      beforePersonalNoop,
    );
  });

  it("copy→save→validate→publish→archive/restore保留不可变Revision与Published View", async () => {
    const { deps, store, memorySystem } = await fixture();
    const copied = await createWorkflowDefinitionCopy(deps, {
      principalId: OWNER,
      commandId: command("cmd_designercopy1"),
      payload: {
        sourceWorkflowDefinitionRevisionId: memorySystem.workflowDefinitionRevisionId,
        sourceDefinitionSha256: memorySystem.definitionSha256,
        title: "我的规划流程",
        description: "受约束的个人Planning Definition",
      },
    });
    expect(copied.definition).toMatchObject({
      ownerKind: "principal",
      ownerPrincipalId: OWNER,
      revision: 1,
      status: "active",
      allowedActions: expect.arrayContaining(["save", "validate", "publish"]),
    });
    if (copied.definition.compatibility !== "editable") throw new Error("copy不可编辑");
    const root = structuredClone(copied.definition.semanticRoot);
    const memory = root.elements.find(
      (element) => element.kind === "task" && element.nodeType === "memory.query",
    );
    if (memory?.kind !== "task") throw new Error("memory node missing");
    memory.defaultActivation = "skipped";

    const saved = await saveWorkflowDefinitionDraft(deps, {
      principalId: OWNER,
      commandId: command("cmd_designersave1"),
      workflowDefinitionId: copied.definition.workflowDefinitionId,
      expectedRevision: 1,
      payload: {
        baseRevisionId: copied.definition.baseRevisionId,
        baseDefinitionSha256: copied.definition.baseDefinitionSha256,
        semanticRoot: root,
      },
    });
    expect(saved.definition.revision).toBe(2);
    expect(saved.affectedRevision?.definitionRevision).toBe(2);
    if (saved.definition.compatibility !== "editable") throw new Error("saved不可编辑");

    const beforeValidate = (await store.read({ kind: "committedSnapshot" })).snapshot.storeRevision;
    const validation = await validateWorkflowDefinition(deps, {
      principalId: OWNER,
      payload: {
        workflowDefinitionId: saved.definition.workflowDefinitionId,
        baseRevisionId: saved.definition.baseRevisionId,
        baseDefinitionSha256: saved.definition.baseDefinitionSha256,
        blueprintKey: saved.definition.blueprintKey,
        blueprintVersion: saved.definition.blueprintVersion,
        semanticRoot: saved.definition.semanticRoot,
      },
    });
    expect(validation.valid).toBe(true);
    expect(validation.normalized?.nodeCount).toBe(
      countDefinitionNodes(saved.definition.semanticRoot),
    );
    expect((await store.read({ kind: "committedSnapshot" })).snapshot.storeRevision).toBe(
      beforeValidate,
    );

    const published = await publishWorkflowDefinition(deps, {
      principalId: OWNER,
      commandId: command("cmd_designerpublish1"),
      workflowDefinitionId: saved.definition.workflowDefinitionId,
      expectedRevision: 2,
      payload: {
        draftRevisionId: saved.definition.baseRevisionId,
        draftDefinitionSha256: saved.definition.baseDefinitionSha256,
      },
    });
    expect(published.definition).toMatchObject({ revision: 3, status: "active" });
    expect(published.definition.currentDraftRevision).toBeUndefined();
    expect(published.definition.publishedRevision?.state).toBe("published");

    const archived = await changeWorkflowDefinitionArchiveStatus(deps, {
      principalId: OWNER,
      commandId: command("cmd_designerarchive1"),
      workflowDefinitionId: published.definition.workflowDefinitionId,
      expectedRevision: 3,
      payload: {
        targetStatus: "archived",
        publishedRevisionId: published.definition.publishedRevision!.workflowDefinitionRevisionId,
        publishedDefinitionSha256: published.definition.publishedRevision!.definitionSha256,
      },
    });
    expect(archived.definition).toMatchObject({ status: "archived", revision: 4 });
    const restored = await changeWorkflowDefinitionArchiveStatus(deps, {
      principalId: OWNER,
      commandId: command("cmd_designerrestore1"),
      workflowDefinitionId: archived.definition.workflowDefinitionId,
      expectedRevision: 4,
      payload: {
        targetStatus: "active",
        publishedRevisionId: archived.definition.publishedRevision!.workflowDefinitionRevisionId,
        publishedDefinitionSha256: archived.definition.publishedRevision!.definitionSha256,
      },
    });
    expect(restored.definition).toMatchObject({ status: "active", revision: 5 });

    const { snapshot } = await store.read({ kind: "committedSnapshot" });
    const revisions = Object.values(snapshot.entities.workflowDefinitionRevisions).filter(
      (revision) => revision.workflowDefinitionId === restored.definition.workflowDefinitionId,
    );
    expect(revisions.map((revision) => revision.state).sort()).toEqual(["published", "superseded"]);
    expect(
      Object.values(snapshot.entities.workflowViewDefinitions).some(
        (view) =>
          view.source.kind === "published_definition" &&
          view.source.definitionSha256 === restored.definition.publishedRevision?.definitionSha256,
      ),
    ).toBe(true);
  });

  it("同command重放返回同一Copy；异payload冲突；跨owner读写失败", async () => {
    const { deps, system } = await fixture();
    const input = {
      principalId: OWNER,
      commandId: command("cmd_designerreplay1"),
      payload: {
        sourceWorkflowDefinitionRevisionId: system.workflowDefinitionRevisionId,
        sourceDefinitionSha256: system.definitionSha256,
        title: "可重放副本",
        description: "相同command保持同一产品身份",
      },
    } as const;
    const first = await createWorkflowDefinitionCopy(deps, input);
    const replay = await createWorkflowDefinitionCopy(deps, input);
    expect(replay).toEqual(first);
    await expect(
      createWorkflowDefinitionCopy(deps, {
        ...input,
        payload: { ...input.payload, title: "不同正文" },
      }),
    ).rejects.toMatchObject({ code: "command_id_reused" });
    await expect(
      getWorkflowDefinitionDetail(deps, {
        principalId: OTHER,
        workflowDefinitionId: first.definition.workflowDefinitionId,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("CAS过期和非法Definition均零写入失败", async () => {
    const { deps, store, memorySystem } = await fixture();
    const copied = await createWorkflowDefinitionCopy(deps, {
      principalId: OWNER,
      commandId: command("cmd_designercopyinvalid1"),
      payload: {
        sourceWorkflowDefinitionRevisionId: memorySystem.workflowDefinitionRevisionId,
        sourceDefinitionSha256: memorySystem.definitionSha256,
        title: "校验失败副本",
        description: "非法结构不能保存",
      },
    });
    if (copied.definition.compatibility !== "editable") throw new Error("copy不可编辑");
    const clonedRoot = structuredClone(copied.definition.semanticRoot);
    const invalidRoot = {
      ...clonedRoot,
      elements: clonedRoot.elements.filter(
        (element) => !(element.kind === "task" && element.nodeType === "product.commit"),
      ),
    };
    const before = (await store.read({ kind: "committedSnapshot" })).snapshot.storeRevision;
    await expect(
      saveWorkflowDefinitionDraft(deps, {
        principalId: OWNER,
        commandId: command("cmd_designersaveinvalid1"),
        workflowDefinitionId: copied.definition.workflowDefinitionId,
        expectedRevision: 999,
        payload: {
          baseRevisionId: copied.definition.baseRevisionId,
          baseDefinitionSha256: copied.definition.baseDefinitionSha256,
          semanticRoot: invalidRoot,
        },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect((await store.read({ kind: "committedSnapshot" })).snapshot.storeRevision).toBe(before);
    const validation = await validateWorkflowDefinition(deps, {
      principalId: OWNER,
      payload: {
        workflowDefinitionId: copied.definition.workflowDefinitionId,
        baseRevisionId: copied.definition.baseRevisionId,
        baseDefinitionSha256: copied.definition.baseDefinitionSha256,
        blueprintKey: copied.definition.blueprintKey,
        blueprintVersion: copied.definition.blueprintVersion,
        semanticRoot: invalidRoot,
      },
    });
    expect(validation.valid).toBe(false);
    expect(validation.diagnostics.some((item) => item.code.includes("terminal"))).toBe(true);
  });

  it("Draft保存与Publish都拒绝Version和Temporary双重Agent配置", async () => {
    const { deps, store, directSystem } = await fixture();
    const copied = await createWorkflowDefinitionCopy(deps, {
      principalId: OWNER,
      commandId: command("cmd_designerambiguouscopy1"),
      payload: {
        sourceWorkflowDefinitionRevisionId: directSystem.workflowDefinitionRevisionId,
        sourceDefinitionSha256: directSystem.definitionSha256,
        title: "双重Agent配置反例",
        description: "保存和发布都必须失败关闭",
      },
    });
    if (copied.definition.compatibility !== "editable") throw new Error("copy不可编辑");
    const ambiguousRoot = structuredClone(copied.definition.semanticRoot);
    const directNode = ambiguousRoot.elements[0];
    if (directNode?.kind !== "composite") throw new Error("Direct副本缺少Agent节点");
    directNode.config = {
      ...directNode.config,
      capabilityMode: "custom",
      agentVersionId: "avn_designerambiguous1",
      agentVersionSha256: "a".repeat(64),
      agentTemporaryConfiguration: {
        runtime: { kind: "pi_coding_agent", baseVariantKey: "pi_cli_default" },
        systemPrompt: { mode: "inherit_runtime" },
        enabledToolNames: ["read", "bash", "edit", "write"],
        resources: {
          contextFiles: "inherit_runtime_default",
          skills: "inherit_runtime_default",
          promptTemplates: "inherit_runtime_default",
          extensions: "inherit_runtime_default",
        },
      },
    };
    const validation = await validateWorkflowDefinition(deps, {
      principalId: OWNER,
      payload: {
        workflowDefinitionId: copied.definition.workflowDefinitionId,
        baseRevisionId: copied.definition.baseRevisionId,
        baseDefinitionSha256: copied.definition.baseDefinitionSha256,
        blueprintKey: copied.definition.blueprintKey,
        blueprintVersion: copied.definition.blueprintVersion,
        semanticRoot: ambiguousRoot,
      },
    });
    expect(validation.valid).toBe(false);
    const beforeSave = (await store.read({ kind: "committedSnapshot" })).snapshot.storeRevision;
    await expect(
      saveWorkflowDefinitionDraft(deps, {
        principalId: OWNER,
        commandId: command("cmd_designerambiguoussave1"),
        workflowDefinitionId: copied.definition.workflowDefinitionId,
        expectedRevision: copied.definition.revision,
        payload: {
          baseRevisionId: copied.definition.baseRevisionId,
          baseDefinitionSha256: copied.definition.baseDefinitionSha256,
          semanticRoot: ambiguousRoot,
        },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect((await store.read({ kind: "committedSnapshot" })).snapshot.storeRevision).toBe(
      beforeSave,
    );

    const copiedDraftRevisionId = copied.definition.baseRevisionId;
    const ambiguousSha256 = hashCanonical("workflow-definition.v1", ambiguousRoot);
    await store.transact({
      commandId: command("cmd_designerambiguouslegacydraft1"),
      commandType: "UpdateOutboxStatus",
      requestSha256: hashCanonical("test.legacy-ambiguous-draft.v1", {
        workflowDefinitionRevisionId: copiedDraftRevisionId,
      }),
      mutate: (draft) => {
        const revision = draft.entities.workflowDefinitionRevisions[copiedDraftRevisionId];
        if (revision === undefined) throw new Error("测试Draft不存在");
        draft.entities.workflowDefinitionRevisions[revision.workflowDefinitionRevisionId] = {
          ...revision,
          semanticRoot: ambiguousRoot,
          definitionSha256: ambiguousSha256,
          updatedAt: deps.now(),
        };
        return { resultRefs: {} };
      },
    });
    await expect(
      publishWorkflowDefinition(deps, {
        principalId: OWNER,
        commandId: command("cmd_designerambiguouspublish1"),
        workflowDefinitionId: copied.definition.workflowDefinitionId,
        expectedRevision: copied.definition.revision,
        payload: {
          draftRevisionId: copiedDraftRevisionId,
          draftDefinitionSha256: ambiguousSha256,
        },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  });

  it("system Definition只允许copy，不可直接编辑", async () => {
    const { deps } = await fixture();
    const detail = await getWorkflowDefinitionDetail(deps, {
      principalId: OWNER,
      workflowDefinitionId: SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID as WorkflowDefinitionId,
    });
    expect(detail.compatibility).toBe("editable");
    expect(detail.allowedActions).toEqual(["copy"]);
    if (detail.compatibility !== "editable") throw new Error("system detail incompatible");
    await expect(
      saveWorkflowDefinitionDraft(deps, {
        principalId: OWNER,
        commandId: command("cmd_designersavesystem1"),
        workflowDefinitionId: detail.workflowDefinitionId,
        expectedRevision: detail.revision,
        payload: {
          baseRevisionId: detail.baseRevisionId,
          baseDefinitionSha256: detail.baseDefinitionSha256,
          semanticRoot: detail.semanticRoot,
        },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("save/publish/archive均可同command重放，异payload冲突且跨owner不能复制", async () => {
    const { deps, system } = await fixture();
    const copied = await createWorkflowDefinitionCopy(deps, {
      principalId: OWNER,
      commandId: command("cmd_designercommands1"),
      payload: {
        sourceWorkflowDefinitionRevisionId: system.workflowDefinitionRevisionId,
        sourceDefinitionSha256: system.definitionSha256,
        title: "命令重放流程",
        description: "验证每个Definition写命令的幂等边界",
      },
    });
    if (copied.definition.compatibility !== "editable") throw new Error("copy不可编辑");
    const saveInput = {
      principalId: OWNER,
      commandId: command("cmd_designersavereplay1"),
      workflowDefinitionId: copied.definition.workflowDefinitionId,
      expectedRevision: copied.definition.revision,
      payload: {
        baseRevisionId: copied.definition.baseRevisionId,
        baseDefinitionSha256: copied.definition.baseDefinitionSha256,
        semanticRoot: copied.definition.semanticRoot,
      },
    } as const;
    const saved = await saveWorkflowDefinitionDraft(deps, saveInput);
    expect(await saveWorkflowDefinitionDraft(deps, saveInput)).toEqual(saved);
    await expect(
      saveWorkflowDefinitionDraft(deps, {
        ...saveInput,
        payload: {
          ...saveInput.payload,
          semanticRoot: { ...saveInput.payload.semanticRoot, elements: [] },
        },
      }),
    ).rejects.toMatchObject({ code: "command_id_reused" });
    if (saved.definition.compatibility !== "editable") throw new Error("save不可编辑");
    const publishInput = {
      principalId: OWNER,
      commandId: command("cmd_designerpublishreplay1"),
      workflowDefinitionId: saved.definition.workflowDefinitionId,
      expectedRevision: saved.definition.revision,
      payload: {
        draftRevisionId: saved.definition.baseRevisionId,
        draftDefinitionSha256: saved.definition.baseDefinitionSha256,
      },
    } as const;
    const published = await publishWorkflowDefinition(deps, publishInput);
    expect(await publishWorkflowDefinition(deps, publishInput)).toEqual(published);
    await expect(
      publishWorkflowDefinition(deps, {
        ...publishInput,
        payload: { ...publishInput.payload, draftDefinitionSha256: "f".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "command_id_reused" });
    const archiveInput = {
      principalId: OWNER,
      commandId: command("cmd_designerarchivereplay1"),
      workflowDefinitionId: published.definition.workflowDefinitionId,
      expectedRevision: published.definition.revision,
      payload: {
        targetStatus: "archived" as const,
        publishedRevisionId: published.definition.publishedRevision!.workflowDefinitionRevisionId,
        publishedDefinitionSha256: published.definition.publishedRevision!.definitionSha256,
      },
    };
    const archived = await changeWorkflowDefinitionArchiveStatus(deps, archiveInput);
    expect(await changeWorkflowDefinitionArchiveStatus(deps, archiveInput)).toEqual(archived);
    await expect(
      changeWorkflowDefinitionArchiveStatus(deps, {
        ...archiveInput,
        payload: { ...archiveInput.payload, targetStatus: "active" },
      }),
    ).rejects.toMatchObject({ code: "command_id_reused" });
    await expect(
      createWorkflowDefinitionCopy(deps, {
        principalId: OTHER,
        commandId: command("cmd_designercrossownercopy1"),
        payload: {
          sourceWorkflowDefinitionRevisionId:
            published.definition.publishedRevision!.workflowDefinitionRevisionId,
          sourceDefinitionSha256: published.definition.publishedRevision!.definitionSha256,
          title: "越权副本",
          description: "不应创建",
        },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      changeWorkflowDefinitionArchiveStatus(deps, {
        principalId: OWNER,
        commandId: command("cmd_designerarchivesystem1"),
        workflowDefinitionId: SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID as WorkflowDefinitionId,
        expectedRevision: 1,
        payload: {
          targetStatus: "archived",
          publishedRevisionId: system.workflowDefinitionRevisionId,
          publishedDefinitionSha256: system.definitionSha256,
        },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("发布B只把A标为superseded，A的不可变View继续可读", async () => {
    const { deps, store, memorySystem } = await fixture();
    const copied = await createWorkflowDefinitionCopy(deps, {
      principalId: OWNER,
      commandId: command("cmd_designerabcopy1"),
      payload: {
        sourceWorkflowDefinitionRevisionId: memorySystem.workflowDefinitionRevisionId,
        sourceDefinitionSha256: memorySystem.definitionSha256,
        title: "A/B流程",
        description: "验证历史View不漂移",
      },
    });
    if (copied.definition.compatibility !== "editable") throw new Error("copy不可编辑");
    const publishedA = await publishWorkflowDefinition(deps, {
      principalId: OWNER,
      commandId: command("cmd_designerabpublisha1"),
      workflowDefinitionId: copied.definition.workflowDefinitionId,
      expectedRevision: 1,
      payload: {
        draftRevisionId: copied.definition.baseRevisionId,
        draftDefinitionSha256: copied.definition.baseDefinitionSha256,
      },
    });
    const revisionA = publishedA.definition.publishedRevision!;
    if (publishedA.definition.compatibility !== "editable") throw new Error("A不可编辑");
    const rootB = structuredClone(publishedA.definition.semanticRoot);
    const memory = rootB.elements.find(
      (element) => element.kind === "task" && element.nodeType === "memory.query",
    );
    if (memory?.kind !== "task") throw new Error("memory node missing");
    memory.defaultActivation = "skipped";
    const draftB = await saveWorkflowDefinitionDraft(deps, {
      principalId: OWNER,
      commandId: command("cmd_designerabsaveb1"),
      workflowDefinitionId: publishedA.definition.workflowDefinitionId,
      expectedRevision: 2,
      payload: {
        baseRevisionId: revisionA.workflowDefinitionRevisionId,
        baseDefinitionSha256: revisionA.definitionSha256,
        semanticRoot: rootB,
      },
    });
    if (draftB.definition.compatibility !== "editable") throw new Error("B不可编辑");
    const publishedB = await publishWorkflowDefinition(deps, {
      principalId: OWNER,
      commandId: command("cmd_designerabpublishb1"),
      workflowDefinitionId: draftB.definition.workflowDefinitionId,
      expectedRevision: 3,
      payload: {
        draftRevisionId: draftB.definition.baseRevisionId,
        draftDefinitionSha256: draftB.definition.baseDefinitionSha256,
      },
    });
    expect(publishedB.definition.publishedRevision?.definitionSha256).not.toBe(
      revisionA.definitionSha256,
    );
    const { snapshot } = await store.read({ kind: "committedSnapshot" });
    expect(
      snapshot.entities.workflowDefinitionRevisions[revisionA.workflowDefinitionRevisionId],
    ).toMatchObject({ state: "superseded", definitionSha256: revisionA.definitionSha256 });
    expect(
      Object.values(snapshot.entities.workflowViewDefinitions).find(
        (view) =>
          view.source.kind === "published_definition" &&
          view.source.definitionSha256 === revisionA.definitionSha256,
      ),
    ).toBeDefined();
  });

  it("公开Designer路由使用strict合同、Command Envelope与私有ETag", async () => {
    const { app, system } = await fixture();
    const detailPath = `/api/workflow/definitions/${SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID}`;
    const detail = await app.request(detailPath);
    expect(detail.status, await detail.clone().text()).toBe(200);
    const etag = detail.headers.get("etag");
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/u);
    const cached = await app.request(detailPath, {
      headers: { "If-None-Match": etag ?? "" },
    });
    expect(cached.status).toBe(304);

    const copy = await app.request("/api/workflow/definitions/copies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd_designerapicopy1",
        payload: {
          sourceWorkflowDefinitionRevisionId: system.workflowDefinitionRevisionId,
          sourceDefinitionSha256: system.definitionSha256,
          title: "API设计器副本",
          description: "验证公开Designer命令边界",
        },
      }),
    });
    expect(copy.status, await copy.clone().text()).toBe(201);
    const result = (await copy.json()) as {
      definition: {
        workflowDefinitionId: string;
        revision: number;
        baseRevisionId: string;
        baseDefinitionSha256: string;
        blueprintKey: "planning";
        blueprintVersion: number;
        semanticRoot: unknown;
      };
    };
    const validate = await app.request("/api/workflow/definitions/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflowDefinitionId: result.definition.workflowDefinitionId,
        baseRevisionId: result.definition.baseRevisionId,
        baseDefinitionSha256: result.definition.baseDefinitionSha256,
        blueprintKey: result.definition.blueprintKey,
        blueprintVersion: result.definition.blueprintVersion,
        semanticRoot: result.definition.semanticRoot,
      }),
    });
    expect(validate.status, await validate.clone().text()).toBe(200);
    expect(await validate.json()).toMatchObject({ valid: true });

    const missingCas = await app.request(
      `/api/workflow/definitions/${result.definition.workflowDefinitionId}/drafts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: "cmd_designerapimissingcas1",
          payload: {
            baseRevisionId: result.definition.baseRevisionId,
            baseDefinitionSha256: result.definition.baseDefinitionSha256,
            semanticRoot: result.definition.semanticRoot,
          },
        }),
      },
    );
    expect(missingCas.status).toBe(400);

    const unknown = await app.request("/api/workflow/definitions/copies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd_designerapiunknown1",
        payload: {
          sourceWorkflowDefinitionRevisionId: system.workflowDefinitionRevisionId,
          sourceDefinitionSha256: system.definitionSha256,
          title: "非法副本",
          description: "不得接受未知字段",
          executorKey: "arbitrary-code",
        },
      }),
    });
    expect(unknown.status).toBe(400);
  });
});

function countDefinitionNodes(root: WorkflowDefinitionSequence): number {
  let count = 0;
  const stack = [...root.elements];
  while (stack.length > 0) {
    const element = stack.pop();
    if (element === undefined) continue;
    if (element.kind === "task" || element.kind === "composite") count += 1;
    else if (element.kind === "sequence") stack.push(...element.elements);
    else if (element.kind === "bounded_loop") stack.push(...element.body.elements);
    else for (const branch of element.branches) stack.push(...branch.body.elements);
  }
  return count;
}

function findNodeConfig(
  root: WorkflowDefinitionSequence,
  definitionNodeId: string,
): Readonly<Record<string, unknown>> | undefined {
  const stack = [...root.elements];
  while (stack.length > 0) {
    const element = stack.pop();
    if (element === undefined) continue;
    if (element.kind === "task" || element.kind === "composite") {
      if (element.definitionNodeId === definitionNodeId) return element.config;
    } else if (element.kind === "sequence") stack.push(...element.elements);
    else if (element.kind === "bounded_loop") stack.push(...element.body.elements);
    else for (const branch of element.branches) stack.push(...branch.body.elements);
  }
  return undefined;
}

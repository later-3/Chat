import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createProductSession,
  createWorkflowDefinitionCopy,
  publishWorkflowDefinition,
  saveWorkflowDefinitionDraft,
  submitUserMessage,
  type ApplicationDeps,
  type IdFactory,
} from "@chat/application";
import { SYSTEM_NOTE_WORKFLOW_REVISION_ID } from "@chat/application/workflow-system-definitions";
import type {
  CommandId,
  NoteCaptureSubmitInput,
  PrincipalId,
  WorkflowDefinitionRevisionId,
} from "@chat/contracts";
import { JsonProductStore } from "@chat/product-store-json";

const OWNER = "usr_notedefaultowner" as PrincipalId;
const NOW = "2026-08-10T15:00:00.000Z";

function ids(): IdFactory {
  let sequence = 0;
  const next = (prefix: string) => `${prefix}_notedefault${(++sequence).toString(36)}`;
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

describe("Note Definition默认值", () => {
  it("Definition默认值进入RunSpec，run输入逐字段覆盖且切换Definition不串值", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chat-note-definition-defaults-"));
    let tick = 0;
    let commandSequence = 0;
    const now = () => new Date(Date.parse(NOW) + tick++ * 1_000).toISOString();
    const deps: ApplicationDeps = {
      store: await JsonProductStore.open({ filePath: join(directory, "product.json"), now }),
      now,
      ids: ids(),
    };
    const command = () => `cmd_notedefault${(++commandSequence).toString(36)}` as CommandId;
    const initial = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const system = initial.entities.workflowDefinitionRevisions[SYSTEM_NOTE_WORKFLOW_REVISION_ID];
    if (system === undefined) throw new Error("system Note Definition不存在");

    const copied = await createWorkflowDefinitionCopy(deps, {
      principalId: OWNER,
      commandId: command(),
      payload: {
        sourceWorkflowDefinitionRevisionId: system.workflowDefinitionRevisionId,
        sourceDefinitionSha256: system.definitionSha256,
        title: "带默认分类的Note流程",
        description: "验证Definition配置与每次运行覆盖的优先级",
      },
    });
    if (copied.definition.compatibility !== "editable") throw new Error("Definition不可编辑");
    const semanticRoot = {
      ...copied.definition.semanticRoot,
      elements: copied.definition.semanticRoot.elements.map((element) =>
        element.kind !== "bounded_loop"
          ? element
          : {
              ...element,
              body: {
                ...element.body,
                elements: element.body.elements.map((child) =>
                  child.kind === "task" && child.nodeType === "note.extract"
                    ? {
                        ...child,
                        config: {
                          maxCharacters: 2_000,
                          defaultKind: "learning",
                          suggestedTagLabels: ["DefinitionTag"],
                        },
                      }
                    : child,
                ),
              },
            },
      ),
    };
    const saved = await saveWorkflowDefinitionDraft(deps, {
      principalId: OWNER,
      commandId: command(),
      workflowDefinitionId: copied.definition.workflowDefinitionId,
      expectedRevision: copied.definition.revision,
      payload: {
        baseRevisionId: copied.definition.baseRevisionId,
        baseDefinitionSha256: copied.definition.baseDefinitionSha256,
        semanticRoot,
      },
    });
    if (saved.definition.compatibility !== "editable") throw new Error("Draft不可编辑");
    const published = await publishWorkflowDefinition(deps, {
      principalId: OWNER,
      commandId: command(),
      workflowDefinitionId: saved.definition.workflowDefinitionId,
      expectedRevision: saved.definition.revision,
      payload: {
        draftRevisionId: saved.definition.baseRevisionId,
        draftDefinitionSha256: saved.definition.baseDefinitionSha256,
      },
    });
    const customRevision = published.definition.publishedRevision;
    if (customRevision === undefined) throw new Error("自定义Definition未发布");

    const submit = async (
      revisionId: WorkflowDefinitionRevisionId,
      definitionSha256: string,
      businessInput?: NoteCaptureSubmitInput,
    ) => {
      const { session } = await createProductSession(deps, {
        principalId: OWNER,
        commandId: command(),
        payload: {},
      });
      const result = await submitUserMessage(deps, {
        principalId: OWNER,
        sessionId: session.sessionId,
        commandId: command(),
        payload: {
          text: "把本次输入整理为Note。",
          workflowSelection: {
            kind: "published_revision",
            workflowDefinitionRevisionId: revisionId,
            definitionSha256,
            ...(businessInput !== undefined ? { businessInput } : {}),
          },
        },
      });
      const snapshot = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
      const run = snapshot.entities.runs[result.run.productRunId];
      const runSpec =
        run?.workflowRunSpecId === undefined
          ? undefined
          : snapshot.entities.workflowRunSpecs[run.workflowRunSpecId];
      if (runSpec?.businessInput?.kind !== "note_capture") throw new Error("Note RunSpec缺失");
      return runSpec.businessInput;
    };

    await expect(
      submit(customRevision.workflowDefinitionRevisionId, customRevision.definitionSha256),
    ).resolves.toMatchObject({
      defaultKind: "learning",
      suggestedTags: [{ label: "DefinitionTag" }],
    });
    await expect(
      submit(customRevision.workflowDefinitionRevisionId, customRevision.definitionSha256, {
        kind: "note_capture",
        defaultKind: "project_idea",
      }),
    ).resolves.toMatchObject({
      defaultKind: "project_idea",
      suggestedTags: [{ label: "DefinitionTag" }],
    });
    await expect(
      submit(customRevision.workflowDefinitionRevisionId, customRevision.definitionSha256, {
        kind: "note_capture",
        suggestedTagLabels: ["RunTag"],
      }),
    ).resolves.toMatchObject({
      defaultKind: "learning",
      suggestedTags: [{ label: "RunTag" }],
    });
    await expect(
      submit(system.workflowDefinitionRevisionId, system.definitionSha256),
    ).resolves.toMatchObject({ defaultKind: "general", suggestedTags: [] });
  });
});

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  noteRevisionSchema,
  publishNoteCandidateRuntimeRequestSchema,
  type CommandId,
  type NoteCandidateId,
  type NoteDecisionId,
  type NoteId,
  type NoteRevisionId,
  type NoteCaptureSubmitInput,
  type PrincipalId,
  type ProductRunId,
  type WorkflowRunSpec,
} from "@chat/contracts";
import {
  type ApplicationDeps,
  type IdFactory,
  type NoteIdFactory,
  commitConfirmedNote,
  createProductSession,
  getWorkflowRunView,
  loadNoteDecisionForRuntime,
  prepareNoteCaptureInputForRuntime,
  publishNoteCandidate,
  submitUserMessage,
  submitNoteDecision,
} from "@chat/application";
import { SYSTEM_NOTE_WORKFLOW_REVISION_ID } from "@chat/application/workflow-system-definitions";
import { computeNoteRevisionSha256, hashCanonical, sha256Hex } from "@chat/domain";
import { JsonProductStore } from "@chat/product-store-json";
import { auditProductIntegrity } from "./product-integrity-auditor.js";

const PRINCIPAL = "usr_noteowner" as PrincipalId;
const NOW = "2026-08-10T12:00:00.000Z";

function idFactory(): IdFactory {
  let sequence = 0;
  const next = (prefix: string) => `${prefix}_noteauto${(++sequence).toString(36)}`;
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

function noteIdFactory(): NoteIdFactory {
  let sequence = 0;
  const next = (prefix: string) => `${prefix}_notefact${(++sequence).toString(36)}`;
  return {
    note: () => next("nte") as NoteId,
    revision: () => next("ntr") as NoteRevisionId,
    candidate: () => next("ntc") as NoteCandidateId,
    decision: () => next("ntd") as NoteDecisionId,
  };
}

async function fixture(options?: {
  readonly constantNow?: boolean;
  readonly autoPolicy?: boolean;
}): Promise<{
  readonly deps: ApplicationDeps;
  readonly productRunId: ProductRunId;
  command(): CommandId;
}> {
  const directory = await mkdtemp(join(tmpdir(), "chat-note-backend-"));
  let clock = 0;
  let commandSequence = 0;
  const now = () =>
    options?.constantNow === true ? NOW : new Date(Date.parse(NOW) + clock++ * 1_000).toISOString();
  const store = await JsonProductStore.open({ filePath: join(directory, "product.json"), now });
  const deps: ApplicationDeps = {
    store,
    now,
    ids: idFactory(),
    noteIds: noteIdFactory(),
  };
  const command = () => `cmd_notebackend${(++commandSequence).toString(36)}` as CommandId;
  const { session } = await createProductSession(deps, {
    principalId: PRINCIPAL,
    commandId: command(),
    payload: {},
  });
  const { snapshot } = await store.read({ kind: "committedSnapshot" });
  const noteRevision =
    snapshot.entities.workflowDefinitionRevisions[SYSTEM_NOTE_WORKFLOW_REVISION_ID];
  if (noteRevision === undefined) throw new Error("测试Fixture缺少system Note Revision");
  const text = "请把这段内容沉淀成一条长期Note。";
  const selectedText = "这段内容";
  const startUtf16 = text.indexOf(selectedText);
  const submitted = await submitUserMessage(deps, {
    principalId: PRINCIPAL,
    sessionId: session.sessionId,
    commandId: command(),
    payload: {
      text,
      workflowSelection: {
        kind: "published_revision",
        workflowDefinitionRevisionId: noteRevision.workflowDefinitionRevisionId,
        definitionSha256: noteRevision.definitionSha256,
        ...(options?.autoPolicy === true
          ? {
              runConfiguration: {
                schemaVersion: "workflow-run-configuration.v1" as const,
                overrides: [
                  {
                    kind: "review_mode" as const,
                    definitionNodeId: "note.review",
                    reviewMode: "auto_continue_if_policy_allows" as const,
                  },
                ],
              },
            }
          : {}),
        businessInput: {
          kind: "note_capture",
          source: {
            kind: "selection",
            startUtf16,
            endUtf16: startUtf16 + selectedText.length,
            selectedTextSha256: sha256Hex(selectedText),
          },
          defaultKind: "learning",
          suggestedTagLabels: ["Knowledge"],
        },
      },
    },
  });

  return { deps, productRunId: submitted.run.productRunId, command };
}

async function noteSubmitFixture(): Promise<{
  readonly deps: ApplicationDeps;
  readonly sessionId: ReturnType<IdFactory["session"]>;
  readonly definition: NonNullable<
    Awaited<
      ReturnType<ApplicationDeps["store"]["read"]>
    >["snapshot"]["entities"]["workflowDefinitionRevisions"][string]
  >;
  readonly text: string;
  command(): CommandId;
}> {
  const directory = await mkdtemp(join(tmpdir(), "chat-note-submit-"));
  let clock = 0;
  let commandSequence = 0;
  const now = () => new Date(Date.parse(NOW) + clock++ * 1_000).toISOString();
  const store = await JsonProductStore.open({ filePath: join(directory, "product.json"), now });
  const deps: ApplicationDeps = {
    store,
    now,
    ids: idFactory(),
    noteIds: noteIdFactory(),
  };
  const command = () => `cmd_notesubmit${(++commandSequence).toString(36)}` as CommandId;
  const { session } = await createProductSession(deps, {
    principalId: PRINCIPAL,
    commandId: command(),
    payload: {},
  });
  const { snapshot } = await store.read({ kind: "committedSnapshot" });
  const definition =
    snapshot.entities.workflowDefinitionRevisions[SYSTEM_NOTE_WORKFLOW_REVISION_ID];
  if (definition === undefined) throw new Error("测试Fixture缺少system Note Revision");
  return {
    deps,
    sessionId: session.sessionId,
    definition,
    text: "把 Alpha 这段沉淀为学习笔记。",
    command,
  };
}

function noteWorkflowSelection(
  definition: Awaited<ReturnType<typeof noteSubmitFixture>>["definition"],
  businessInput?: NoteCaptureSubmitInput,
) {
  return {
    kind: "published_revision" as const,
    workflowDefinitionRevisionId: definition.workflowDefinitionRevisionId,
    definitionSha256: definition.definitionSha256,
    ...(businessInput !== undefined ? { businessInput } : {}),
  };
}

function recomputeRunSpecSha256(runSpec: WorkflowRunSpec): WorkflowRunSpec {
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

describe("Note后端用例与持久完整性", () => {
  it("私有publish Candidate合同拒绝runtime伪造sourceRefs", () => {
    const parsed = publishNoteCandidateRuntimeRequestSchema.safeParse({
      schemaVersion: "chat-internal-runtime.v1",
      commandId: "cmd_notefakesource1",
      productRunId: "run_notefakesource1",
      proposed: {
        title: "伪造来源",
        kind: "general",
        contentMarkdown: "Runtime不允许提交sourceRefs。",
        tagLabels: [],
      },
      sourceRefs: [],
    });
    expect(parsed.success).toBe(false);
  });

  it("system policy对低风险Note原子确认且不伪造Decision/Hook，command replay不重复", async () => {
    const { deps, productRunId, command } = await fixture({ autoPolicy: true });
    const commandId = command();
    const published = await publishNoteCandidate(deps, {
      productRunId,
      commandId,
      proposed: {
        title: "自动确认的低风险笔记",
        kind: "learning",
        contentMarkdown: "这是一条仅写入Chat Note产品事实的低风险内容。",
        tagLabels: ["Knowledge"],
      },
    });
    expect(published.review.outcome).toBe("auto_continued");
    expect(published.candidate).toMatchObject({ status: "confirmed", revision: 2 });
    const replayed = await publishNoteCandidate(deps, {
      productRunId,
      commandId,
      proposed: {
        title: "自动确认的低风险笔记",
        kind: "learning",
        contentMarkdown: "这是一条仅写入Chat Note产品事实的低风险内容。",
        tagLabels: ["Knowledge"],
      },
    });
    expect(replayed).toEqual(published);

    const beforeCommit = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(beforeCommit.entities.runs[productRunId]).toMatchObject({
      status: "running",
      phase: "committing",
    });
    expect(Object.values(beforeCommit.entities.workflowPolicyResolutions)).toHaveLength(1);
    expect(Object.values(beforeCommit.entities.noteDecisions)).toHaveLength(0);
    expect(
      Object.values(beforeCommit.outbox).filter(
        (entry) => entry.kind === "workflow_resume" && entry.productRunId === productRunId,
      ),
    ).toHaveLength(0);
    const reviewNode = Object.values(beforeCommit.entities.workflowNodeRuns).find(
      (node) => node.productRunId === productRunId && node.nodeType === "human.note_review",
    );
    expect(reviewNode).toMatchObject({ status: "succeeded", outcomeCode: "approved" });
    expect(auditProductIntegrity(beforeCommit)).toMatchObject({ ok: true, issues: [] });
    const damagedPolicy = structuredClone(beforeCommit);
    const resolution = Object.values(damagedPolicy.entities.workflowPolicyResolutions)[0];
    if (resolution === undefined) throw new Error("fixture缺少Policy Resolution");
    resolution.workflowRunSpecSha256 = "0".repeat(64);
    expect(auditProductIntegrity(damagedPolicy).issues.map((item) => item.code)).toContain(
      "workflow_policy_resolution.binding_invalid",
    );

    const committed = await commitConfirmedNote(deps, {
      productRunId,
      noteCandidateId: published.candidate.noteCandidateId,
      commandId: command(),
    });
    expect(committed.note.currentRevision.title).toBe("自动确认的低风险笔记");
  });

  it("system policy拒绝超界Note时保存Resolution并回到真实人工审核", async () => {
    const { deps, productRunId, command } = await fixture({ autoPolicy: true });
    const published = await publishNoteCandidate(deps, {
      productRunId,
      commandId: command(),
      proposed: {
        title: "需要人工审核的候选",
        kind: "general",
        contentMarkdown: "标签数量超过低风险自动继续边界。",
        tagLabels: Array.from({ length: 11 }, (_, index) => `Tag ${String(index + 1)}`),
      },
    });
    expect(published.review.outcome).toBe("policy_denied_waiting_human");
    expect(published.candidate.status).toBe("under_review");
    const snapshot = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(snapshot.entities.runs[productRunId]).toMatchObject({
      status: "waiting_human",
      phase: "note_review",
    });
    expect(Object.values(snapshot.entities.workflowPolicyResolutions)[0]).toMatchObject({
      outcome: "denied",
      reasonCode: "note_candidate_exceeds_auto_bounds",
    });
    const workflowView = await getWorkflowRunView(deps, {
      principalId: PRINCIPAL,
      productRunId,
    });
    expect(
      workflowView.value.nodeRuns.find((node) => node.nodeType === "human.note_review")
        ?.allowedActions,
    ).toEqual(["inspect", "submit_decision"]);
    expect(Object.values(snapshot.entities.noteDecisions)).toHaveLength(0);
  });

  it("Application从RunSpec执行allowCustomTags=false，拒绝自定义标签且允许建议子集", async () => {
    const { deps, productRunId, command } = await fixture();
    const before = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const run = before.entities.runs[productRunId];
    if (run?.workflowRunSpecId === undefined) throw new Error("fixture缺少Note RunSpec");
    const workflowRunSpecId = run.workflowRunSpecId;
    await deps.store.transact({
      commandId: command(),
      commandType: "SubmitUserMessage",
      requestSha256: hashCanonical("note-allow-custom-tags-fixture.v1", { productRunId }),
      mutate: (draft) => {
        const current = draft.entities.workflowRunSpecs[workflowRunSpecId];
        const currentRun = draft.entities.runs[productRunId];
        if (current === undefined || currentRun === undefined) throw new Error("fixture损坏");
        draft.entities.workflowRunSpecs[workflowRunSpecId] = recomputeRunSpecSha256({
          ...current,
          nodeResolutions: current.nodeResolutions.map((resolution) =>
            resolution.nodeType === "note.classify"
              ? { ...resolution, config: { allowCustomTags: false } }
              : resolution,
          ),
        });
        return {
          resultRefs: {
            messageId: currentRun.sourceMessageId,
            productRunId,
            workflowRunSpecId,
          },
        };
      },
    });
    const frozen = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    await expect(
      publishNoteCandidate(deps, {
        productRunId,
        commandId: command(),
        proposed: {
          title: "越界标签",
          kind: "learning",
          contentMarkdown: "自定义标签必须在Application边界被拒绝。",
          tagLabels: ["Knowledge", "Injected"],
        },
      }),
    ).rejects.toMatchObject({ code: "validation_failed", httpStatus: 422 });
    const rejected = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(rejected.storeRevision).toBe(frozen.storeRevision);
    expect(Object.values(rejected.entities.noteCandidates)).toHaveLength(0);
    expect(
      Object.values(rejected.entities.workflowNodeRuns).filter(
        (node) => node.productRunId === productRunId && node.nodeType === "human.note_review",
      ),
    ).toHaveLength(0);

    const accepted = await publishNoteCandidate(deps, {
      productRunId,
      commandId: command(),
      proposed: {
        title: "建议标签子集",
        kind: "learning",
        contentMarkdown: "只使用RunSpec businessInput冻结的Knowledge标签。",
        tagLabels: ["knowledge"],
      },
    });
    expect(accepted.candidate.proposed.tags.map((tag) => tag.key)).toEqual(["knowledge"]);
    expect(accepted.review.outcome).toBe("waiting_human");
  });

  it("Submit note_capture默认配置与显式默认配置幂等等价，且Outbox不保存正文", async () => {
    const { deps, sessionId, definition, text, command } = await noteSubmitFixture();
    const commandId = command();
    const first = await submitUserMessage(deps, {
      principalId: PRINCIPAL,
      sessionId,
      commandId,
      payload: {
        text,
        workflowSelection: noteWorkflowSelection(definition),
      },
    });
    const second = await submitUserMessage(deps, {
      principalId: PRINCIPAL,
      sessionId,
      commandId,
      payload: {
        text,
        workflowSelection: noteWorkflowSelection(definition, {
          kind: "note_capture",
          source: { kind: "full_message" },
          defaultKind: "general",
          suggestedTagLabels: [],
        }),
      },
    });
    expect(second.run.productRunId).toBe(first.run.productRunId);

    const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
    const run = snapshot.entities.runs[first.run.productRunId];
    if (run === undefined || run.workflowRunSpecId === undefined) {
      throw new Error("测试Fixture缺少RunSpec");
    }
    const runSpec = snapshot.entities.workflowRunSpecs[run.workflowRunSpecId];
    expect(run?.runKind).toBe("note_capture");
    expect(runSpec?.businessInput).toMatchObject({
      kind: "note_capture",
      source: { kind: "full_message" },
      defaultKind: "general",
      suggestedTags: [],
    });
    expect(JSON.stringify(Object.values(snapshot.outbox))).not.toContain(text);
  });

  it("Submit note_capture拒绝陈旧Definition和错误选区Hash，失败时零写入", async () => {
    const stale = await noteSubmitFixture();
    const beforeStale = (await stale.deps.store.read({ kind: "committedSnapshot" })).snapshot
      .storeRevision;
    await expect(
      submitUserMessage(stale.deps, {
        principalId: PRINCIPAL,
        sessionId: stale.sessionId,
        commandId: stale.command(),
        payload: {
          text: stale.text,
          workflowSelection: {
            ...noteWorkflowSelection(stale.definition),
            definitionSha256: "0".repeat(64),
          },
        },
      }),
    ).rejects.toThrow("Hash已过期");
    expect(
      (await stale.deps.store.read({ kind: "committedSnapshot" })).snapshot.storeRevision,
    ).toBe(beforeStale);

    const badSelection = await noteSubmitFixture();
    const beforeSelection = (await badSelection.deps.store.read({ kind: "committedSnapshot" }))
      .snapshot.storeRevision;
    await expect(
      submitUserMessage(badSelection.deps, {
        principalId: PRINCIPAL,
        sessionId: badSelection.sessionId,
        commandId: badSelection.command(),
        payload: {
          text: badSelection.text,
          workflowSelection: noteWorkflowSelection(badSelection.definition, {
            kind: "note_capture",
            source: {
              kind: "selection",
              startUtf16: 0,
              endUtf16: 2,
              selectedTextSha256: "f".repeat(64),
            },
          }),
        },
      }),
    ).rejects.toThrow("Note来源选区与本次消息不一致");
    expect(
      (await badSelection.deps.store.read({ kind: "committedSnapshot" })).snapshot.storeRevision,
    ).toBe(beforeSelection);
  });

  it("publish Candidate只使用RunSpec派生来源，RunSpec来源被篡改到跨Message时零写入失败", async () => {
    const { deps, productRunId, command } = await fixture();
    const before = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const run = before.entities.runs[productRunId];
    if (
      run === undefined ||
      run.runKind !== "note_capture" ||
      run.workflowRunSpecId === undefined
    ) {
      throw new Error("测试Fixture缺少Note Capture RunSpec");
    }
    const runSpec = before.entities.workflowRunSpecs[run.workflowRunSpecId];
    if (runSpec === undefined || runSpec.businessInput?.kind !== "note_capture") {
      throw new Error("测试Fixture缺少Note Capture businessInput");
    }
    await deps.store.transact({
      commandId: command(),
      commandType: "SubmitUserMessage",
      requestSha256: hashCanonical("note-backend-tamper-source.v1", { productRunId }),
      mutate: (draft) => {
        const current = draft.entities.workflowRunSpecs[run.workflowRunSpecId!];
        if (current === undefined || current.businessInput?.kind !== "note_capture") {
          throw new Error("测试Fixture缺少RunSpec");
        }
        draft.entities.workflowRunSpecs[current.workflowRunSpecId] = recomputeRunSpecSha256({
          ...current,
          businessInput: {
            ...current.businessInput,
            source: {
              ...current.businessInput.source,
              sourceMessageSha256: "0".repeat(64),
            },
          },
        });
        return {
          resultRefs: {
            messageId: run.sourceMessageId,
            productRunId,
            workflowRunSpecId: run.workflowRunSpecId!,
          },
        };
      },
    });
    const afterTamperRevision = (await deps.store.read({ kind: "committedSnapshot" })).snapshot
      .storeRevision;

    await expect(
      publishNoteCandidate(deps, {
        productRunId,
        commandId: command(),
        proposed: {
          title: "被拒绝的候选",
          kind: "general",
          contentMarkdown: "来源Hash已被篡改，不能生成候选。",
          tagLabels: [],
        },
      }),
    ).rejects.toThrow("Note来源Message/选区Hash与RunSpec不一致");
    const afterRejected = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(afterRejected.storeRevision).toBe(afterTamperRevision);
    expect(Object.values(afterRejected.entities.noteCandidates)).toHaveLength(0);
  });

  it("edited confirm先校验原Candidate，再由服务端追加successor并绑定Decision", async () => {
    const { deps, productRunId, command } = await fixture({ constantNow: true });
    const firstSnapshot = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const run = firstSnapshot.entities.runs[productRunId];
    if (run === undefined || run.runKind !== "note_capture") {
      throw new Error("测试Fixture缺少Note Capture Run");
    }
    const runSpec =
      run.workflowRunSpecId === undefined
        ? undefined
        : firstSnapshot.entities.workflowRunSpecs[run.workflowRunSpecId];
    expect(run.runnerFamily).toBe("note-capture.v1");
    expect(runSpec?.businessInput?.kind).toBe("note_capture");
    if (run.workflowRunSpecId === undefined) throw new Error("测试Fixture缺少RunSpec");
    const prepared = await prepareNoteCaptureInputForRuntime(deps, {
      productRunId,
      workflowRunSpecId: run.workflowRunSpecId,
    });
    expect(prepared).toMatchObject({
      sourceText: "这段内容",
      defaultKind: "learning",
      suggestedTagLabels: ["Knowledge"],
    });
    expect(
      Object.values(firstSnapshot.outbox).some(
        (entry) =>
          (entry.kind === "workflow_start" || entry.kind === "workflow_resume") &&
          entry.productRunId === productRunId,
      ),
    ).toBe(true);
    const first = await publishNoteCandidate(deps, {
      productRunId,
      commandId: command(),
      proposed: {
        title: "原始标题",
        kind: "general",
        contentMarkdown: "原始正文",
        tagLabels: ["Inbox"],
      },
    });

    const waitingSnapshot = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(waitingSnapshot.entities.runs[productRunId]).toMatchObject({
      status: "waiting_human",
      phase: "note_review",
    });

    const decided = await submitNoteDecision(deps, {
      principalId: PRINCIPAL,
      commandId: command(),
      expectedRunRevision:
        waitingSnapshot.entities.runs[productRunId]?.revision ??
        (() => {
          throw new Error("测试Fixture缺少waiting Run");
        })(),
      payload: {
        productRunId,
        noteCandidateId: first.candidate.noteCandidateId,
        candidateRevision: first.candidate.revision,
        candidateSha256: first.candidate.sha256,
        kind: "confirm",
        editedProposal: {
          title: "修订后标题",
          kind: "project_idea",
          contentMarkdown: "人工确认时修订后的正文",
          tagLabels: ["Project", "Inbox"],
        },
      },
    });

    expect(decided.candidate.noteCandidateId).not.toBe(first.candidate.noteCandidateId);
    expect(decided.decision.noteCandidateId).toBe(decided.candidate.noteCandidateId);
    expect(decided.candidate.status).toBe("confirmed");
    expect(decided.candidate.proposed.title).toBe("修订后标题");

    const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
    expect(snapshot.entities.runs[productRunId]).toMatchObject({
      status: "running",
      phase: "committing",
    });
    expect(snapshot.entities.noteCandidates[first.candidate.noteCandidateId]?.status).toBe(
      "revision_requested",
    );
    const resumeOutbox = Object.values(snapshot.outbox).find(
      (entry) =>
        entry.kind === "workflow_resume" &&
        entry.noteCandidateId === decided.candidate.noteCandidateId,
    );
    expect(resumeOutbox).toMatchObject({
      kind: "workflow_resume",
      productRunId,
      hookNoteCandidateId: first.candidate.noteCandidateId,
      noteCandidateId: decided.candidate.noteCandidateId,
      noteDecisionId: decided.decision.noteDecisionId,
      runnerFamily: "note-capture.v1",
    });
    const reviewNodes = Object.values(snapshot.entities.workflowNodeRuns).filter(
      (node) => node.productRunId === productRunId && node.nodeType === "human.note_review",
    );
    expect(reviewNodes).toHaveLength(1);
    expect(reviewNodes[0]).toMatchObject({
      status: "succeeded",
      outcomeCode: "approved",
      executionPath: [{ containerNodeId: "note.review.loop", iteration: 1 }],
    });
    const reviewInputManifest =
      reviewNodes[0]?.inputManifestId === undefined
        ? undefined
        : snapshot.entities.nodeValueManifests[reviewNodes[0].inputManifestId];
    expect(reviewInputManifest).toMatchObject({ revision: 1 });
    expect(reviewInputManifest?.slots[0]?.refs).toEqual([
      expect.objectContaining({
        kind: "note_candidate",
        id: first.candidate.noteCandidateId,
        revision: first.candidate.revision,
        sha256: first.candidate.sha256,
      }),
    ]);
    expect(JSON.stringify(reviewInputManifest)).not.toContain(decided.candidate.noteCandidateId);
    expect(
      Date.parse(
        snapshot.entities.noteDecisions[decided.decision.noteDecisionId]?.createdAt ?? NOW,
      ),
    ).toBeGreaterThan(
      Date.parse(
        snapshot.entities.noteCandidates[decided.candidate.noteCandidateId]?.createdAt ?? NOW,
      ),
    );
    if (run.workflowRunSpecId === undefined) throw new Error("测试Fixture缺少RunSpec");
    const loaded = await loadNoteDecisionForRuntime(deps, {
      productRunId,
      workflowRunSpecId: run.workflowRunSpecId,
      noteCandidateId: decided.candidate.noteCandidateId,
      noteDecisionId: decided.decision.noteDecisionId,
    });
    expect(loaded.decision.noteDecisionId).toBe(decided.decision.noteDecisionId);
  });

  it("request_revision后prepare返回上一Candidate和修订指令，并且下一Candidate显式supersedes", async () => {
    const { deps, productRunId, command } = await fixture();
    const first = await publishNoteCandidate(deps, {
      productRunId,
      commandId: command(),
      proposed: {
        title: "需要修订",
        kind: "general",
        contentMarkdown: "第一版候选正文。",
        tagLabels: ["Draft"],
      },
    });
    const waiting = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const waitingRun = waiting.entities.runs[productRunId];
    if (waitingRun === undefined || waitingRun.workflowRunSpecId === undefined) {
      throw new Error("测试Fixture缺少waiting Run");
    }
    const decision = await submitNoteDecision(deps, {
      principalId: PRINCIPAL,
      commandId: command(),
      expectedRunRevision: waitingRun.revision,
      payload: {
        productRunId,
        noteCandidateId: first.candidate.noteCandidateId,
        candidateRevision: first.candidate.revision,
        candidateSha256: first.candidate.sha256,
        kind: "request_revision",
        revisionInstruction: "请补充来源背景",
      },
    });
    const prepared = await prepareNoteCaptureInputForRuntime(deps, {
      productRunId,
      workflowRunSpecId: waitingRun.workflowRunSpecId,
    });
    expect(prepared.priorCandidate?.noteCandidateId).toBe(first.candidate.noteCandidateId);
    expect(prepared.revisionInstruction).toBe("请补充来源背景");
    const loaded = await loadNoteDecisionForRuntime(deps, {
      productRunId,
      workflowRunSpecId: waitingRun.workflowRunSpecId,
      noteCandidateId: first.candidate.noteCandidateId,
      noteDecisionId: decision.decision.noteDecisionId,
    });
    expect(loaded.decision.kind).toBe("request_revision");

    const second = await publishNoteCandidate(deps, {
      productRunId,
      commandId: command(),
      proposed: {
        title: "已修订",
        kind: "general",
        contentMarkdown: "补充来源背景后的第二版候选。",
        tagLabels: ["Draft"],
      },
    });
    expect(second.candidate.supersedesCandidateId).toBe(first.candidate.noteCandidateId);
  });

  it("Note Decision要求Run CAS、waiting阶段和最新under_review Candidate，失败时零写入", async () => {
    const queued = await fixture();
    const queuedRevision = (await queued.deps.store.read({ kind: "committedSnapshot" })).snapshot
      .storeRevision;
    const queuedRun = (await queued.deps.store.read({ kind: "committedSnapshot" })).snapshot
      .entities.runs[queued.productRunId];
    if (queuedRun === undefined) throw new Error("测试Fixture缺少queued Run");
    await expect(
      submitNoteDecision(queued.deps, {
        principalId: PRINCIPAL,
        commandId: queued.command(),
        expectedRunRevision: queuedRun.revision,
        payload: {
          productRunId: queued.productRunId,
          noteCandidateId: "ntc_notqueued1" as NoteCandidateId,
          candidateRevision: 1,
          candidateSha256: "a".repeat(64),
          kind: "reject",
          reason: "queued不能决定",
        },
      }),
    ).rejects.toThrow("不在人工审核阶段");
    expect(
      (await queued.deps.store.read({ kind: "committedSnapshot" })).snapshot.storeRevision,
    ).toBe(queuedRevision);

    const { deps, productRunId, command } = await fixture();
    const first = await publishNoteCandidate(deps, {
      productRunId,
      commandId: command(),
      proposed: {
        title: "CAS候选",
        kind: "general",
        contentMarkdown: "等待人工审核。",
        tagLabels: [],
      },
    });
    const waiting = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const waitingRun = waiting.entities.runs[productRunId];
    if (waitingRun === undefined) throw new Error("测试Fixture缺少waiting Run");
    const beforeStale = waiting.storeRevision;
    await expect(
      submitNoteDecision(deps, {
        principalId: PRINCIPAL,
        commandId: command(),
        expectedRunRevision: waitingRun.revision - 1,
        payload: {
          productRunId,
          noteCandidateId: first.candidate.noteCandidateId,
          candidateRevision: first.candidate.revision,
          candidateSha256: first.candidate.sha256,
          kind: "confirm",
        },
      }),
    ).rejects.toThrow("Note Run已变化");
    const afterStale = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(afterStale.storeRevision).toBe(beforeStale);
    expect(Object.values(afterStale.entities.noteDecisions)).toHaveLength(0);
  });

  it("reject决定取消Note Run且不产生Note或finalMessage", async () => {
    const { deps, productRunId, command } = await fixture();
    const published = await publishNoteCandidate(deps, {
      productRunId,
      commandId: command(),
      proposed: {
        title: "拒绝候选",
        kind: "general",
        contentMarkdown: "这条候选会被拒绝。",
        tagLabels: [],
      },
    });
    const waiting = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const waitingRun = waiting.entities.runs[productRunId];
    if (waitingRun === undefined) throw new Error("测试Fixture缺少waiting Run");
    const rejected = await submitNoteDecision(deps, {
      principalId: PRINCIPAL,
      commandId: command(),
      expectedRunRevision: waitingRun.revision,
      payload: {
        productRunId,
        noteCandidateId: published.candidate.noteCandidateId,
        candidateRevision: published.candidate.revision,
        candidateSha256: published.candidate.sha256,
        kind: "reject",
        reason: "不应沉淀",
      },
    });
    expect(rejected.candidate.status).toBe("rejected");
    const snapshot = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const rejectedRun = snapshot.entities.runs[productRunId];
    expect(rejectedRun).toMatchObject({
      status: "cancelled",
      phase: "rejected",
    });
    expect(rejectedRun?.finalMessageId).toBeUndefined();
    expect(Object.values(snapshot.entities.notes)).toHaveLength(0);
    await expect(
      commitConfirmedNote(deps, {
        productRunId,
        noteCandidateId: published.candidate.noteCandidateId,
        commandId: command(),
      }),
    ).rejects.toThrow("不在提交阶段");
  });

  it("同一confirmed Candidate只能提交为一条Note，并由Store完整性锁定sourceCandidate唯一性", async () => {
    const { deps, productRunId, command } = await fixture();
    const published = await publishNoteCandidate(deps, {
      productRunId,
      commandId: command(),
      proposed: {
        title: "长期笔记",
        kind: "learning",
        contentMarkdown: "需要长期复用的结论。",
        tagLabels: ["Knowledge"],
      },
    });
    const waiting = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const decided = await submitNoteDecision(deps, {
      principalId: PRINCIPAL,
      commandId: command(),
      expectedRunRevision:
        waiting.entities.runs[productRunId]?.revision ??
        (() => {
          throw new Error("测试Fixture缺少waiting Run");
        })(),
      payload: {
        productRunId,
        noteCandidateId: published.candidate.noteCandidateId,
        candidateRevision: published.candidate.revision,
        candidateSha256: published.candidate.sha256,
        kind: "confirm",
      },
    });

    const commitCommandId = command();
    const committed = await commitConfirmedNote(deps, {
      productRunId,
      noteCandidateId: decided.candidate.noteCandidateId,
      commandId: commitCommandId,
    });
    expect(committed.note.currentRevision.title).toBe("长期笔记");

    const replayed = await commitConfirmedNote(deps, {
      productRunId,
      noteCandidateId: decided.candidate.noteCandidateId,
      commandId: commitCommandId,
    });
    expect(replayed.note.noteId).toBe(committed.note.noteId);

    await expect(
      commitConfirmedNote(deps, {
        productRunId,
        noteCandidateId: decided.candidate.noteCandidateId,
        commandId: command(),
      }),
    ).rejects.toThrow("不在提交阶段");

    const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
    const storedNote = snapshot.entities.notes[committed.note.noteId];
    if (storedNote === undefined) throw new Error("测试Fixture缺少已提交Note");
    expect(storedNote.sourceCandidateId).toBe(decided.candidate.noteCandidateId);

    const duplicateNoteId = "nte_noteduplicate1" as NoteId;
    const duplicateRevisionId = "ntr_noteduplicate1" as NoteRevisionId;
    await expect(
      deps.store.transact({
        commandId: command(),
        commandType: "ReviseNote",
        requestSha256: hashCanonical("note-backend-duplicate-source.v1", {
          duplicateNoteId,
        }),
        mutate: (draft) => {
          const revision = noteRevisionSchema.parse({
            schemaVersion: "note-revision.v1",
            noteRevisionId: duplicateRevisionId,
            noteId: duplicateNoteId,
            noteRevision: 1,
            title: decided.candidate.proposed.title,
            kind: decided.candidate.proposed.kind,
            contentMarkdown: decided.candidate.proposed.contentMarkdown,
            tags: decided.candidate.proposed.tags,
            sourceRefs: decided.candidate.sourceRefs,
            createdByPrincipalId: PRINCIPAL,
            sha256: computeNoteRevisionSha256({
              noteId: duplicateNoteId,
              noteRevision: 1,
              title: decided.candidate.proposed.title,
              kind: decided.candidate.proposed.kind,
              contentMarkdown: decided.candidate.proposed.contentMarkdown,
              tags: decided.candidate.proposed.tags,
              sourceRefs: decided.candidate.sourceRefs,
              createdByPrincipalId: PRINCIPAL,
            }),
            createdAt: NOW,
          });
          draft.entities.noteRevisions[duplicateRevisionId] = revision;
          draft.entities.notes[duplicateNoteId] = {
            schemaVersion: "note.v1",
            noteId: duplicateNoteId,
            ownerPrincipalId: PRINCIPAL,
            sourceCandidateId: storedNote.sourceCandidateId,
            currentRevisionId: duplicateRevisionId,
            status: "active",
            revision: 1,
            createdAt: NOW,
            updatedAt: NOW,
          };
          return { resultRefs: { noteId: duplicateNoteId, noteRevisionId: duplicateRevisionId } };
        },
      }),
    ).rejects.toThrow("重复绑定同一Note Candidate");

    const afterRejected = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(afterRejected.entities.notes[duplicateNoteId]).toBeUndefined();
  });
});

import { serve } from "@hono/node-server";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  NoteCandidateId,
  NoteDecisionId,
  NoteId,
  NoteRevisionId,
  NoteRevisionInput,
  PrincipalId,
  TraceEventInput,
} from "@chat/contracts";
import {
  createProductSession,
  submitNoteDecision,
  submitUserMessage,
  type ApplicationDeps,
  type IdFactory,
  type NoteIdFactory,
} from "@chat/application";
import { SYSTEM_NOTE_WORKFLOW_REVISION_ID } from "@chat/application/workflow-system-definitions";
import { createApiApp } from "@chat/api";
import { OutboxDispatcher } from "@chat/api/outbox-dispatcher";
import type { AgentRunResult, BailianConfig, NoteCaptureModelInput } from "@chat/pi-runtime";
import { JsonProductStore } from "@chat/product-store-json";
import {
  createWorkflowRuntimeServer,
  RuntimeBindingStore,
  setWorkflowRuntimeContext,
} from "@chat/workflows";

/**
 * S5 Note真实恢复门：只替换付费pi边界，Hono、Product Store、Outbox、Runtime
 * Binding、预构建bundle、Local World和Hook全部使用正式实现。正文只留在临时Store，
 * Runtime Binding/Outbox和Trace断言确保不会复制正文或暴露私有Hook身份。
 */

const BUNDLE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../workflows/.workflow-bundle",
);
const PRINCIPAL_ID = "usr_noteworld" as PrincipalId;

let idSequence = 0;
function ids(): IdFactory {
  const next = (prefix: string) => `${prefix}_ntw${(++idSequence).toString(36)}`;
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

let noteIdSequence = 0;
function noteIds(): NoteIdFactory {
  const next = (prefix: string) => `${prefix}_ntw${(++noteIdSequence).toString(36)}`;
  return {
    note: () => next("nte") as NoteId,
    revision: () => next("ntr") as NoteRevisionId,
    candidate: () => next("ntc") as NoteCandidateId,
    decision: () => next("ntd") as NoteDecisionId,
  };
}

let commandSequence = 0;
const command = () => `cmd_noteworld${(++commandSequence).toString(36)}` as never;

interface FakeNoteCapture {
  calls: NoteCaptureModelInput[];
  failNext: boolean;
  denyAutoPolicyNext: boolean;
  capture(input: {
    readonly config: BailianConfig;
    readonly captureInput: NoteCaptureModelInput;
    readonly onProviderRequestStart?: (() => void) | undefined;
  }): Promise<AgentRunResult<NoteRevisionInput>>;
}

function createFakeNoteCapture(): FakeNoteCapture {
  const fake: FakeNoteCapture = {
    calls: [],
    failNext: false,
    denyAutoPolicyNext: false,
    capture: async ({ captureInput, onProviderRequestStart }) => {
      onProviderRequestStart?.();
      fake.calls.push(structuredClone(captureInput));
      if (fake.failNext) {
        fake.failNext = false;
        return {
          kind: "provider_failed",
          errorCode: "provider.stream_interrupted",
          durationMs: 4,
          providerCallCount: 1,
          providerMeta: { providerRequestId: "req-note-unknown" },
        };
      }
      const revision = captureInput.revisionInstruction === undefined ? 1 : 2;
      const denyAutoPolicy = fake.denyAutoPolicyNext;
      fake.denyAutoPolicyNext = false;
      return {
        kind: "candidate",
        candidate: {
          title: revision === 1 ? "第一版长期笔记" : "第二版长期笔记",
          kind: captureInput.defaultKind,
          contentMarkdown:
            revision === 1
              ? "第一版：保留来源事实。"
              : `第二版：${captureInput.revisionInstruction ?? "已修订"}`,
          tagLabels: denyAutoPolicy
            ? Array.from({ length: 11 }, (_, index) => `Policy Bound ${String(index + 1)}`)
            : [...captureInput.suggestedTagLabels, `revision-${String(revision)}`],
        },
        usage: { inputTokens: 30, outputTokens: 20 },
        durationMs: 4,
        providerCallCount: 1,
        providerMeta: { httpStatus: 200, providerRequestId: `req-note-${String(revision)}` },
      };
    },
  };
  return fake;
}

type HttpServer = ReturnType<typeof serve>;

function listen(
  app: { readonly fetch: (request: Request) => Promise<Response> | Response },
  port = 0,
): Promise<{ readonly server: HttpServer; readonly port: number }> {
  return new Promise((resolveListen, rejectListen) => {
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) =>
      resolveListen({ server, port: info.port }),
    );
    server.on("error", rejectListen);
  });
}

async function closeServer(server: HttpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
}

interface NoteWorldStack {
  readonly deps: ApplicationDeps;
  readonly dispatcher: OutboxDispatcher;
  readonly fake: FakeNoteCapture;
  readonly traceEvents: TraceEventInput[];
  bindings: RuntimeBindingStore;
  restart(): Promise<void>;
  close(): Promise<void>;
}

async function startStack(): Promise<NoteWorldStack> {
  const directory = await mkdtemp(join(tmpdir(), "chat-note-world-"));
  const traceEvents: TraceEventInput[] = [];
  let clock = Date.now();
  // Product不变量要求同一Candidate的updatedAt严格前进；测试时钟显式单调，避免
  // 真实毫秒时钟分辨率把业务断言变成偶发失败（Application另有同毫秒防护门）。
  const now = () => new Date(clock++).toISOString();
  const store = await JsonProductStore.open({ filePath: join(directory, "product.json"), now });
  const deps: ApplicationDeps = {
    store,
    now,
    ids: ids(),
    noteIds: noteIds(),
    trace: (event) => traceEvents.push(event),
  };
  const credential = "rtk_noteworld000000000000000";
  const api = createApiApp({
    traceSink: null,
    product: { deps, principalId: PRINCIPAL_ID },
    internalRuntime: { credential },
  });
  const listenedApi = await listen(api);
  const fake = createFakeNoteCapture();
  const runtimeOptions = {
    repoRoot: directory,
    bundleDir: BUNDLE_DIR,
    workflowDataDir: join(directory, "workflow-data"),
    bindingsPath: join(directory, "runtime-bindings.json"),
    apiBaseUrl: `http://127.0.0.1:${String(listenedApi.port)}`,
    credential,
    traceSink: { emit: (event: TraceEventInput) => traceEvents.push(event) },
    runtimeOverrides: {
      now,
      bailian: {
        apiKey: "fake",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        endpointHost: "dashscope.aliyuncs.com",
      },
      noteCapture: fake.capture as never,
    },
  } as const;
  let runtime = await createWorkflowRuntimeServer(runtimeOptions);
  let listenedRuntime = await listen(runtime.app);
  const runtimePort = listenedRuntime.port;
  const dispatcher = new OutboxDispatcher({
    deps,
    workflowRuntimeBaseUrl: `http://127.0.0.1:${String(runtimePort)}`,
    credential,
  });
  const stack: NoteWorldStack = {
    deps,
    dispatcher,
    fake,
    traceEvents,
    bindings: runtime.bindings,
    restart: async () => {
      await closeServer(listenedRuntime.server);
      await runtime.world.close();
      runtime = await createWorkflowRuntimeServer(runtimeOptions);
      listenedRuntime = await listen(runtime.app, runtimePort);
      stack.bindings = runtime.bindings;
    },
    close: async () => {
      await closeServer(listenedRuntime.server);
      await runtime.world.close();
      await closeServer(listenedApi.server);
      setWorkflowRuntimeContext(undefined);
    },
  };
  return stack;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Note Local World等待超时");
}

async function seedNoteRun(
  stack: NoteWorldStack,
  text: string,
  options: { readonly autoPolicy?: boolean } = {},
) {
  const { session } = await createProductSession(stack.deps, {
    principalId: PRINCIPAL_ID,
    commandId: command(),
    payload: {},
  });
  const { snapshot } = await stack.deps.store.read({ kind: "committedSnapshot" });
  const definition =
    snapshot.entities.workflowDefinitionRevisions[SYSTEM_NOTE_WORKFLOW_REVISION_ID];
  if (definition === undefined) throw new Error("Note Local World缺少system Note Definition");
  const { run } = await submitUserMessage(stack.deps, {
    principalId: PRINCIPAL_ID,
    sessionId: session.sessionId,
    commandId: command(),
    payload: {
      text,
      workflowSelection: {
        kind: "published_revision",
        workflowDefinitionRevisionId: definition.workflowDefinitionRevisionId,
        definitionSha256: definition.definitionSha256,
        ...(options.autoPolicy === true
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
          source: { kind: "full_message" },
          defaultKind: "learning",
          suggestedTagLabels: ["Knowledge"],
        },
      },
    },
  });
  return run;
}

async function readNoteRun(stack: NoteWorldStack, productRunId: string) {
  const { snapshot } = await stack.deps.store.read({ kind: "committedSnapshot" });
  const candidates = Object.values(snapshot.entities.noteCandidates)
    .filter((candidate) => candidate.productRunId === productRunId)
    .sort((left, right) => left.candidateSequence - right.candidateSequence);
  const decisions = Object.values(snapshot.entities.noteDecisions).filter(
    (decision) => decision.productRunId === productRunId,
  );
  const notes = Object.values(snapshot.entities.notes).filter((note) =>
    candidates.some((candidate) => candidate.noteCandidateId === note.sourceCandidateId),
  );
  const outbox = Object.values(snapshot.outbox).filter(
    (entry) => "productRunId" in entry && entry.productRunId === productRunId,
  );
  return {
    snapshot,
    run: snapshot.entities.runs[productRunId as never],
    candidates,
    decisions,
    notes,
    outbox,
  };
}

async function noteReviewCheckpointReady(
  stack: NoteWorldStack,
  productRunId: string,
  candidateSequence: number,
): Promise<boolean> {
  const current = await readNoteRun(stack, productRunId);
  if (current.run?.status !== "waiting_human" || current.run.phase !== "note_review") return false;
  const candidate = current.candidates.find(
    (item) => item.candidateSequence === candidateSequence && item.status === "under_review",
  );
  if (candidate === undefined) return false;
  const hook = stack.bindings.getNoteHookBinding(candidate.noteCandidateId);
  if (hook?.hookClaimState !== "claimed" || hook.resumeDispatchState !== "none") return false;
  const node = Object.values(current.snapshot.entities.workflowNodeRuns).find(
    (item) =>
      item.productRunId === productRunId &&
      item.nodeType === "human.note_review" &&
      item.status === "waiting_human" &&
      item.executionPath.at(-1)?.iteration === candidateSequence,
  );
  // Candidate发布事务原子拥有waiting节点；Binding claim后即可安全恢复，
  // 不再依赖会与权威summary/outcome冲突的通用Transition Receipt。
  return node !== undefined;
}

describe("Note Capture真实Local World + Hook + 恢复", () => {
  let stack: NoteWorldStack;
  beforeAll(async () => {
    stack = await startStack();
  }, 120_000);
  afterAll(async () => {
    await stack?.close();
  });

  it("两轮修订后重启，人工编辑确认只提交一次Note，重复resume不重复模型或副作用", async () => {
    const run = await seedNoteRun(stack, "来源事实：Workflow必须可恢复，候选不能自动成为Note。");
    await stack.dispatcher.tick();
    await waitFor(() => noteReviewCheckpointReady(stack, run.productRunId, 1));
    let current = await readNoteRun(stack, run.productRunId);
    const first = current.candidates[0];
    if (first === undefined) throw new Error("缺少第一版Note Candidate");
    expect(stack.fake.calls).toHaveLength(1);
    expect(stack.bindings.getWorkflowBinding(run.productRunId)).toMatchObject({
      runnerFamily: "note-capture.v1",
      runnerBundleVersion: "note-capture.bundle.v1",
      workflowRunSpecId: current.run?.workflowRunSpecId,
    });

    await submitNoteDecision(stack.deps, {
      principalId: PRINCIPAL_ID,
      commandId: command(),
      expectedRunRevision: current.run?.revision ?? 0,
      payload: {
        productRunId: run.productRunId,
        noteCandidateId: first.noteCandidateId,
        candidateRevision: first.revision,
        candidateSha256: first.sha256,
        kind: "request_revision",
        revisionInstruction: "补充恢复边界，并明确候选仍需审核",
      },
    });
    await stack.dispatcher.tick();
    await waitFor(() => noteReviewCheckpointReady(stack, run.productRunId, 2));
    current = await readNoteRun(stack, run.productRunId);
    const second = current.candidates.find((candidate) => candidate.candidateSequence === 2);
    if (second === undefined) throw new Error("缺少第二版Note Candidate");
    expect(second.supersedesCandidateId).toBe(first.noteCandidateId);
    expect(stack.fake.calls).toHaveLength(2);
    expect(stack.fake.calls[1]).toMatchObject({
      priorCandidate: { title: first.proposed.title },
      revisionInstruction: "补充恢复边界，并明确候选仍需审核",
    });

    // Hook Binding与权威waiting Node均已耐久后模拟Runtime重启。
    await stack.restart();
    expect(stack.fake.calls).toHaveLength(2);
    expect(stack.bindings.getNoteHookBinding(second.noteCandidateId)?.resumeDispatchState).toBe(
      "none",
    );

    const confirmed = await submitNoteDecision(stack.deps, {
      principalId: PRINCIPAL_ID,
      commandId: command(),
      expectedRunRevision: current.run?.revision ?? 0,
      payload: {
        productRunId: run.productRunId,
        noteCandidateId: second.noteCandidateId,
        candidateRevision: second.revision,
        candidateSha256: second.sha256,
        kind: "confirm",
        editedProposal: {
          title: "人工确认的恢复边界",
          kind: "learning",
          contentMarkdown: "候选经过人工编辑确认后，才成为一条正式且可追溯的Note。",
          tagLabels: ["Knowledge", "Workflow"],
        },
      },
    });
    expect(confirmed.candidate.noteCandidateId).not.toBe(second.noteCandidateId);
    await stack.dispatcher.tick();
    await stack.dispatcher.tick();
    await waitFor(
      async () => (await readNoteRun(stack, run.productRunId)).run?.status === "succeeded",
    );

    const completed = await readNoteRun(stack, run.productRunId);
    expect(completed.run?.phase).toBe("completed");
    expect(completed.notes).toHaveLength(1);
    const note = completed.notes[0];
    if (note === undefined) throw new Error("缺少正式Note");
    const revision = completed.snapshot.entities.noteRevisions[note.currentRevisionId];
    expect(note.sourceCandidateId).toBe(confirmed.candidate.noteCandidateId);
    expect(revision).toMatchObject({
      title: "人工确认的恢复边界",
      contentMarkdown: "候选经过人工编辑确认后，才成为一条正式且可追溯的Note。",
    });
    expect(stack.fake.calls).toHaveLength(2);
    expect(completed.outbox.filter((entry) => entry.kind === "workflow_resume")).toHaveLength(2);
    expect(
      completed.outbox.filter(
        (entry) =>
          entry.kind === "workflow_resume" &&
          entry.noteDecisionId === confirmed.decision.noteDecisionId,
      )[0],
    ).toMatchObject({ status: "acknowledged", dispatchAttempts: 1 });
  }, 90_000);

  it("reject恢复同一Workflow为cancelled，且不创建Note", async () => {
    const beforeCalls = stack.fake.calls.length;
    const run = await seedNoteRun(stack, "这条候选将被用户拒绝。");
    await stack.dispatcher.tick();
    await waitFor(() => noteReviewCheckpointReady(stack, run.productRunId, 1));
    const current = await readNoteRun(stack, run.productRunId);
    const candidate = current.candidates[0];
    if (candidate === undefined) throw new Error("缺少待拒绝Note Candidate");
    await submitNoteDecision(stack.deps, {
      principalId: PRINCIPAL_ID,
      commandId: command(),
      expectedRunRevision: current.run?.revision ?? 0,
      payload: {
        productRunId: run.productRunId,
        noteCandidateId: candidate.noteCandidateId,
        candidateRevision: candidate.revision,
        candidateSha256: candidate.sha256,
        kind: "reject",
        reason: "不应沉淀",
      },
    });
    await stack.dispatcher.tick();
    await waitFor(
      async () => (await readNoteRun(stack, run.productRunId)).run?.status === "cancelled",
    );
    const rejected = await readNoteRun(stack, run.productRunId);
    expect(rejected.run?.phase).toBe("rejected");
    expect(rejected.notes).toHaveLength(0);
    expect(stack.fake.calls).toHaveLength(beforeCalls + 1);
  }, 90_000);

  it("Provider结果未知时不自动重试，Run失败且不生成Candidate或Note", async () => {
    stack.fake.failNext = true;
    const beforeCalls = stack.fake.calls.length;
    const run = await seedNoteRun(stack, "模拟Provider流中断。");
    await stack.dispatcher.tick();
    await waitFor(
      async () => (await readNoteRun(stack, run.productRunId)).run?.status === "failed",
    );
    await stack.dispatcher.tick();
    const failed = await readNoteRun(stack, run.productRunId);
    expect(stack.fake.calls).toHaveLength(beforeCalls + 1);
    expect(failed.candidates).toHaveLength(0);
    expect(failed.notes).toHaveLength(0);
    expect(failed.run?.failure?.code).toBe("provider.stream_interrupted");
  }, 90_000);

  it("权威Policy允许时无Hook/Decision自动提交，重复派发不重复模型或Note", async () => {
    const beforeCalls = stack.fake.calls.length;
    const run = await seedNoteRun(stack, "低风险Note只写入Chat产品事实。", {
      autoPolicy: true,
    });
    await stack.dispatcher.tick();
    await waitFor(
      async () => (await readNoteRun(stack, run.productRunId)).run?.status === "succeeded",
    );

    const completed = await readNoteRun(stack, run.productRunId);
    const candidate = completed.candidates[0];
    if (candidate === undefined) throw new Error("缺少自动继续Note Candidate");
    expect(candidate).toMatchObject({ status: "confirmed", revision: 2 });
    expect(completed.notes).toHaveLength(1);
    expect(completed.decisions).toHaveLength(0);
    expect(stack.bindings.getNoteHookBinding(candidate.noteCandidateId)).toBeUndefined();
    expect(
      Object.values(completed.snapshot.entities.workflowPolicyResolutions).filter(
        (resolution) => resolution.productRunId === run.productRunId,
      ),
    ).toHaveLength(1);
    expect(completed.outbox.filter((entry) => entry.kind === "workflow_resume")).toHaveLength(0);
    expect(stack.fake.calls).toHaveLength(beforeCalls + 1);

    // 已acknowledged的start Outbox重放不会再次启动Workflow；commit命令本身也以稳定
    // Candidate身份幂等，因而模型调用与正式Note数量都保持不变。
    await stack.dispatcher.tick();
    await stack.dispatcher.tick();
    const replayed = await readNoteRun(stack, run.productRunId);
    expect(stack.fake.calls).toHaveLength(beforeCalls + 1);
    expect(replayed.notes).toHaveLength(1);
    expect(replayed.candidates).toHaveLength(1);
  }, 90_000);

  it("权威Policy拒绝后持久化人工Hook，重启恢复确认且重复resume幂等", async () => {
    stack.fake.denyAutoPolicyNext = true;
    const beforeCalls = stack.fake.calls.length;
    const run = await seedNoteRun(stack, "超出低风险策略边界后必须回到人工审核。", {
      autoPolicy: true,
    });
    await stack.dispatcher.tick();
    await waitFor(() => noteReviewCheckpointReady(stack, run.productRunId, 1));
    let current = await readNoteRun(stack, run.productRunId);
    const candidate = current.candidates[0];
    if (candidate === undefined) throw new Error("缺少Policy denied Candidate");
    expect(stack.fake.calls).toHaveLength(beforeCalls + 1);
    expect(stack.bindings.getNoteHookBinding(candidate.noteCandidateId)).toMatchObject({
      hookClaimState: "claimed",
      resumeDispatchState: "none",
    });
    expect(
      Object.values(current.snapshot.entities.workflowPolicyResolutions).find(
        (resolution) => resolution.productRunId === run.productRunId,
      ),
    ).toMatchObject({ outcome: "denied" });

    await stack.restart();
    current = await readNoteRun(stack, run.productRunId);
    const confirmed = await submitNoteDecision(stack.deps, {
      principalId: PRINCIPAL_ID,
      commandId: command(),
      expectedRunRevision: current.run?.revision ?? 0,
      payload: {
        productRunId: run.productRunId,
        noteCandidateId: candidate.noteCandidateId,
        candidateRevision: candidate.revision,
        candidateSha256: candidate.sha256,
        kind: "confirm",
      },
    });
    await stack.dispatcher.tick();
    await stack.dispatcher.tick();
    await waitFor(
      async () => (await readNoteRun(stack, run.productRunId)).run?.status === "succeeded",
    );
    const completed = await readNoteRun(stack, run.productRunId);
    expect(completed.notes).toHaveLength(1);
    expect(completed.decisions).toHaveLength(1);
    expect(stack.fake.calls).toHaveLength(beforeCalls + 1);
    expect(
      completed.outbox.filter(
        (entry) =>
          entry.kind === "workflow_resume" &&
          entry.noteDecisionId === confirmed.decision.noteDecisionId,
      )[0],
    ).toMatchObject({ status: "acknowledged", dispatchAttempts: 1 });
  }, 90_000);
});

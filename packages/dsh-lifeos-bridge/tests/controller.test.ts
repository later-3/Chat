import assert from "node:assert/strict";
import test from "node:test";
import { LifeosProjectionController } from "../src/client/controller.ts";
import {
  bridgeChatDispatchReviewDecisionRequestSchema,
  dshSendReviewDecisionRequestSchema,
  noteDecisionRequestSchema,
  promptReviewDecisionRequestSchema,
  toolExecutionDecisionRequestSchema,
  workflowSelectionSchema,
} from "../src/contracts.ts";

const projection = {
  schemaVersion: "chat-dsh-lifeos-bridge.v3",
  dshSessionId: "dsh-session-1",
  run: null,
  plan: null,
  approval: null,
  pendingDecision: null,
  noteCandidate: null,
  pendingNoteDecision: null,
  workflowSelection: null,
  executionTraces: [],
};

const projectionWithSelection = {
  ...projection,
  workflowSelection: {
    workflowDefinitionRevisionId: "wfr_systemmemoryplanningv1",
    definitionSha256: "a".repeat(64),
    title: "Memory 增强规划与执行",
  },
};

const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

test("projection polling follows first-subscribe and last-unsubscribe lifecycle", async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let starts = 0;
  let clears = 0;
  let fetches = 0;
  const intervalIds = new Set<number>();
  try {
    globalThis.setInterval = ((handler: TimerHandler) => {
      assert.equal(typeof handler, "function");
      starts += 1;
      intervalIds.add(starts);
      return starts;
    }) as typeof setInterval;
    globalThis.clearInterval = ((id: number | undefined) => {
      if (id !== undefined && intervalIds.delete(Number(id))) clears += 1;
    }) as typeof clearInterval;
    const controller = new LifeosProjectionController("dsh-session-1", async () => {
      fetches += 1;
      return new Response(JSON.stringify(projection), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    assert.equal(fetches, 0);
    const unsubscribeFirst = controller.subscribe(() => undefined);
    await settle();
    assert.equal(starts, 1);
    assert.equal(fetches, 1);
    unsubscribeFirst();
    assert.equal(clears, 1);

    const unsubscribeSecond = controller.subscribe(() => undefined);
    await settle();
    assert.equal(starts, 2);
    assert.equal(fetches, 2);
    unsubscribeSecond();
    assert.equal(clears, 2);
    controller.dispose();
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("projection fetch is invoked without the controller as receiver", async () => {
  let calls = 0;
  async function receiverCheckingFetch(
    this: unknown,
    _input: URL | RequestInfo,
    _init?: RequestInit,
  ): Promise<Response> {
    assert.equal(this, undefined);
    calls += 1;
    return new Response(JSON.stringify(projection), { status: 200 });
  }
  const controller = new LifeosProjectionController(
    "dsh-session-1",
    receiverCheckingFetch as typeof fetch,
  );
  await controller.refresh();
  assert.equal(calls, 1);
  assert.equal(controller.getSnapshot().status, "ready");
  controller.dispose();
});

test("loadWorkflows fills the picker list and keeps run polling untouched", async () => {
  const items = [
    {
      workflowDefinitionId: "wfd_systemsimpleplanning",
      workflowDefinitionRevisionId: "wfr_systemsimpleplanningv1",
      definitionSha256: "a".repeat(64),
      title: "规划执行工作流",
      description: "生成计划、人工审核、执行、验证并提交结果的系统内置流程。",
      blueprintKey: "planning",
      ownerKind: "system",
      isDefault: true,
      configurableNodes: [],
      agentNodes: [],
    },
    {
      workflowDefinitionId: "wfd_systemplanning",
      workflowDefinitionRevisionId: "wfr_systemplanningv2",
      definitionSha256: "b".repeat(64),
      title: "默认规划工作流",
      description: "读取上下文、生成计划、人工审核、执行、验证并提交结果的系统内置流程。",
      blueprintKey: "planning",
      ownerKind: "system",
      isDefault: false,
      configurableNodes: [],
      agentNodes: [],
    },
    {
      workflowDefinitionId: "wfd_systemmemoryplanning",
      workflowDefinitionRevisionId: "wfr_systemmemoryplanningv1",
      definitionSha256: "d".repeat(64),
      title: "Memory 增强规划与执行",
      description: "显式查询既有记忆、保存本次用户输入，再规划、审核、执行并提交结果。",
      blueprintKey: "planning",
      ownerKind: "system",
      isDefault: false,
      configurableNodes: [],
      agentNodes: [],
    },
    {
      workflowDefinitionId: "wfd_systemnote",
      workflowDefinitionRevisionId: "wfr_systemnotev1",
      definitionSha256: "c".repeat(64),
      title: "默认笔记工作流",
      description: "从本次消息或选区抽取笔记、分类、人工审核并保存为正式Note。",
      blueprintKey: "note",
      ownerKind: "system",
      isDefault: false,
      configurableNodes: [],
      agentNodes: [],
    },
  ];
  const controller = new LifeosProjectionController("dsh-session-1", async () => {
    return new Response(JSON.stringify({ items }), { status: 200 });
  });
  const loaded = await controller.loadWorkflows();
  assert.deepEqual(loaded, items);
  assert.deepEqual(controller.getSnapshot().workflows, items);
  assert.equal(controller.getSnapshot().workflowError, null);
  controller.dispose();
});

test("context manager loads its bounded DSH projection from the dedicated on-demand route", async () => {
  const requests: string[] = [];
  const contextProjection = {
    schemaVersion: "chat-dsh-context-injections.v1",
    dshSessionId: "dsh-session-1",
    status: "ready",
    revision: "f".repeat(64),
    chatForwarding: "not_forwarded",
    items: [
      {
        messageId: "context-1",
        sourceKind: "agent-instructions",
        sourceName: null,
        form: "instructions",
        sourceDetails: ["/repo/AGENTS.md"],
        sourceDetailsTruncated: false,
        text: "workspace rules",
        contentCharacters: 15,
        truncated: false,
        unsupportedContentBlockCount: 0,
      },
    ],
    totalItems: 1,
    omittedItems: 0,
    totalContentCharacters: 15,
  };
  const controller = new LifeosProjectionController(
    "dsh-session-1",
    async (input: URL | RequestInfo) => {
      requests.push(String(input));
      return new Response(JSON.stringify(contextProjection), { status: 200 });
    },
  );

  assert.deepEqual(await controller.loadContextInjections(), contextProjection);
  assert.deepEqual(requests, ["/lifeos/sessions/dsh-session-1/context-injections"]);
  assert.deepEqual(controller.getSnapshot().contextInjections, contextProjection);
  assert.equal(controller.getSnapshot().contextInjectionsLoading, false);
  assert.equal(controller.getSnapshot().contextInjectionsError, null);
  controller.dispose();
});

test("context manager keeps the last good projection when a refresh fails", async () => {
  let succeeds = true;
  const contextProjection = {
    schemaVersion: "chat-dsh-context-injections.v1",
    dshSessionId: "dsh-session-1",
    status: "not_assembled",
    revision: "e".repeat(64),
    chatForwarding: "not_forwarded",
    items: [],
    totalItems: 0,
    omittedItems: 0,
    totalContentCharacters: 0,
  };
  const controller = new LifeosProjectionController("dsh-session-1", async () => {
    if (succeeds) return new Response(JSON.stringify(contextProjection), { status: 200 });
    return new Response(
      JSON.stringify({ title: "会话未恢复", code: "lifeos_dsh_session_not_found" }),
      { status: 404 },
    );
  });
  assert.ok((await controller.loadContextInjections()) !== null);
  succeeds = false;
  assert.equal(await controller.loadContextInjections(), null);
  assert.deepEqual(controller.getSnapshot().contextInjections, contextProjection);
  assert.match(
    controller.getSnapshot().contextInjectionsError ?? "",
    /lifeos_dsh_session_not_found/u,
  );
  controller.dispose();
});

test("selectWorkflow submits the draft and adopts the returned projection", async () => {
  const requests: { method?: string | undefined; body?: string | undefined }[] = [];
  const controller = new LifeosProjectionController(
    "dsh-session-1",
    async (input: URL | RequestInfo, init?: RequestInit) => {
      requests.push({
        method: init?.method,
        body: init?.body === undefined ? undefined : String(init.body),
      });
      return new Response(JSON.stringify(projectionWithSelection), { status: 200 });
    },
  );
  const accepted = await controller.selectWorkflow(
    workflowSelectionSchema.parse({
      workflowDefinitionRevisionId: "wfr_systemmemoryplanningv1",
      definitionSha256: "a".repeat(64),
      title: "Memory 增强规划与执行",
      runConfiguration: {
        schemaVersion: "workflow-run-configuration.v1",
        overrides: [
          {
            kind: "node_config",
            definitionNodeId: "direct.agent",
            field: "promptReviewMode",
            value: "off",
          },
        ],
      },
    }),
  );
  assert.equal(accepted, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, "PUT");
  assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), {
    scope: "session",
    workflowSelection: {
      workflowDefinitionRevisionId: "wfr_systemmemoryplanningv1",
      definitionSha256: "a".repeat(64),
      title: "Memory 增强规划与执行",
      runConfiguration: {
        schemaVersion: "workflow-run-configuration.v1",
        overrides: [
          {
            kind: "node_config",
            definitionNodeId: "direct.agent",
            field: "promptReviewMode",
            value: "off",
          },
        ],
      },
    },
  });
  assert.deepEqual(
    controller.getSnapshot().projection?.workflowSelection?.workflowDefinitionRevisionId,
    "wfr_systemmemoryplanningv1",
  );
  controller.dispose();
});

test("selectWorkflow surfaces bridge failures without clobbering the projection", async () => {
  const controller = new LifeosProjectionController("dsh-session-1", async () => {
    return new Response(
      JSON.stringify({ title: "选项目前不可用", status: 409, code: "lifeos_workflow_stale" }),
      { status: 409 },
    );
  });
  const accepted = await controller.selectWorkflow(null);
  assert.equal(accepted, false);
  assert.equal(controller.getSnapshot().selectingWorkflow, false);
  assert.match(controller.getSnapshot().workflowError ?? "", /lifeos_workflow_stale/);
  controller.dispose();
});

test("decideNote submits the observed candidate binding to the dedicated same-origin route", async () => {
  const requests: Array<{ path: string; method?: string; body?: unknown }> = [];
  const controller = new LifeosProjectionController(
    "dsh-session-1",
    async (input: URL | RequestInfo, init?: RequestInit) => {
      requests.push({
        path: String(input),
        ...(init?.method === undefined ? {} : { method: init.method }),
        ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
      });
      return new Response(JSON.stringify(projection), { status: 200 });
    },
  );
  const request = noteDecisionRequestSchema.parse({
    kind: "request_revision",
    explanation: "补充来源边界",
    binding: {
      productRunId: "run_note1",
      runRevision: 2,
      noteCandidateId: "ntc_note1",
      candidateRevision: 1,
      candidateSha256: "d".repeat(64),
    },
  });
  assert.equal(await controller.decideNote(request), true);
  assert.deepEqual(requests, [
    {
      path: "/lifeos/sessions/dsh-session-1/note-decisions",
      method: "POST",
      body: request,
    },
  ]);
  controller.dispose();
});

test("decidePromptReview submits the exact observed request hashes to its same-origin route", async () => {
  const requests: Array<{ path: string; method?: string; body?: unknown }> = [];
  const controller = new LifeosProjectionController(
    "dsh-session-1",
    async (input: URL | RequestInfo, init?: RequestInit) => {
      requests.push({
        path: String(input),
        ...(init?.method === undefined ? {} : { method: init.method }),
        ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
      });
      return new Response(JSON.stringify(projection), { status: 200 });
    },
  );
  const request = promptReviewDecisionRequestSchema.parse({
    kind: "approve",
    binding: {
      productRunId: "run_prompt1",
      runRevision: 3,
      promptReviewRequestId: "prr_prompt1",
      requestRevision: 1,
      reviewSha256: "e".repeat(64),
      payloadSha256: "f".repeat(64),
    },
  });
  assert.equal(await controller.decidePromptReview(request), true);
  assert.deepEqual(requests, [
    {
      path: "/lifeos/sessions/dsh-session-1/prompt-review-decisions",
      method: "POST",
      body: request,
    },
  ]);
  controller.dispose();
});

test("decideToolExecution submits Capability、参数与Scope绑定到独立同源路由", async () => {
  const requests: Array<{ path: string; method?: string; body?: unknown }> = [];
  const controller = new LifeosProjectionController(
    "dsh-session-1",
    async (input: URL | RequestInfo, init?: RequestInit) => {
      requests.push({
        path: String(input),
        ...(init?.method === undefined ? {} : { method: init.method }),
        ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
      });
      return new Response(JSON.stringify(projection), { status: 200 });
    },
  );
  const request = toolExecutionDecisionRequestSchema.parse({
    kind: "approve",
    binding: {
      productRunId: "run_tool1",
      runRevision: 4,
      toolExecutionIntentId: "tei_tool1",
      intentRevision: 1,
      capabilityDescriptorSha256: "1".repeat(64),
      inputSha256: "2".repeat(64),
      scopeRef: { kind: "workspace", rootId: "root_chat" },
    },
  });
  assert.equal(await controller.decideToolExecution(request), true);
  assert.deepEqual(requests, [
    {
      path: "/lifeos/sessions/dsh-session-1/tool-execution-decisions",
      method: "POST",
      body: request,
    },
  ]);
  controller.dispose();
});

test("two Bridge debug review gates use independent same-origin routes", async () => {
  const requests: Array<{ path: string; method?: string; body?: unknown }> = [];
  const controller = new LifeosProjectionController(
    "dsh-session-1",
    async (input: URL | RequestInfo, init?: RequestInit) => {
      requests.push({
        path: String(input),
        ...(init?.method === undefined ? {} : { method: init.method }),
        ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
      });
      return new Response(JSON.stringify(projection), { status: 200 });
    },
  );
  const decision = dshSendReviewDecisionRequestSchema.parse({
    reviewId: `dsr_${"a".repeat(32)}`,
    kind: "approve",
  });
  const bridgeDecision = bridgeChatDispatchReviewDecisionRequestSchema.parse({
    reviewId: `bdr_${"b".repeat(32)}`,
    planSha256: "c".repeat(64),
    kind: "approve",
  });
  assert.equal(await controller.setDshSendReviewEnabled(true), true);
  assert.equal(await controller.decideDshSendReview(decision), true);
  assert.equal(await controller.setBridgeDispatchReviewEnabled(true), true);
  assert.equal(await controller.decideBridgeDispatchReview(bridgeDecision), true);
  assert.deepEqual(requests, [
    {
      path: "/lifeos/sessions/dsh-session-1/dsh-send-review-setting",
      method: "PUT",
      body: { enabled: true },
    },
    {
      path: "/lifeos/sessions/dsh-session-1/dsh-send-review-decisions",
      method: "POST",
      body: decision,
    },
    {
      path: "/lifeos/sessions/dsh-session-1/bridge-dispatch-review-setting",
      method: "POST",
      body: { enabled: true },
    },
    {
      path: "/lifeos/sessions/dsh-session-1/bridge-dispatch-review-decisions",
      method: "POST",
      body: bridgeDecision,
    },
  ]);
  controller.dispose();
});

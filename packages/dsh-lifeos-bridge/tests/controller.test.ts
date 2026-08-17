import assert from "node:assert/strict";
import test from "node:test";
import { LifeosProjectionController } from "../src/client/controller.ts";
import { workflowSelectionSchema } from "../src/contracts.ts";

const projection = {
  schemaVersion: "chat-dsh-lifeos-bridge.v3",
  dshSessionId: "dsh-session-1",
  run: null,
  plan: null,
  approval: null,
  pendingDecision: null,
  workflowSelection: null,
  executionTraces: [],
};

const projectionWithSelection = {
  ...projection,
  workflowSelection: {
    workflowDefinitionRevisionId: "wfr_systemnotev1",
    definitionSha256: "a".repeat(64),
    title: "默认笔记工作流",
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
      workflowDefinitionRevisionId: "wfr_systemplanningv2",
      definitionSha256: "b".repeat(64),
      title: "默认规划工作流",
      description: "读取上下文、生成计划、人工审核、执行、验证并提交结果的系统内置流程。",
      blueprintKey: "planning",
      ownerKind: "system",
      isDefault: false,
    },
    {
      workflowDefinitionRevisionId: "wfr_systemnotev1",
      definitionSha256: "c".repeat(64),
      title: "默认笔记工作流",
      description: "从本次消息或选区抽取笔记、分类、人工审核并保存为正式Note。",
      blueprintKey: "note",
      ownerKind: "system",
      isDefault: false,
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
      workflowDefinitionRevisionId: "wfr_systemnotev1",
      definitionSha256: "a".repeat(64),
      title: "默认笔记工作流",
    }),
  );
  assert.equal(accepted, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, "PUT");
  assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), {
    workflowSelection: {
      workflowDefinitionRevisionId: "wfr_systemnotev1",
      definitionSha256: "a".repeat(64),
      title: "默认笔记工作流",
    },
  });
  assert.deepEqual(
    controller.getSnapshot().projection?.workflowSelection?.workflowDefinitionRevisionId,
    "wfr_systemnotev1",
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

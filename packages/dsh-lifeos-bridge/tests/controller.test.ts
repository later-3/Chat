import assert from "node:assert/strict";
import test from "node:test";
import { LifeosProjectionController } from "../src/client/controller.ts";

const projection = {
  schemaVersion: "chat-dsh-lifeos-bridge.v1",
  dshSessionId: "dsh-session-1",
  run: null,
  plan: null,
  approval: null,
  pendingDecision: null,
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

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationDeps, IdFactory } from "@chat/application";
import { createProductSession, submitUserMessage } from "@chat/application";
import { JsonProductStore } from "@chat/product-store-json";
import { OutboxDispatcher } from "./outbox-dispatcher.js";

function ids(): IdFactory {
  let value = 0;
  const next = (prefix: string) => `${prefix}_dispatch${(++value).toString(36)}`;
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

async function seed(): Promise<{ deps: ApplicationDeps; productRunId: string }> {
  const directory = await mkdtemp(join(tmpdir(), "chat-dispatch-test-"));
  const now = () => "2026-08-07T12:00:00.000Z";
  const store = await JsonProductStore.open({
    filePath: join(directory, "chat-product-store.v1.json"),
    now,
  });
  const deps: ApplicationDeps = { store, now, ids: ids() };
  const { session } = await createProductSession(deps, {
    principalId: "usr_dispatchtest" as never,
    commandId: "cmd_dispatch1" as never,
    payload: {},
  });
  const { run } = await submitUserMessage(deps, {
    principalId: "usr_dispatchtest" as never,
    sessionId: session.sessionId,
    commandId: "cmd_dispatch2" as never,
    payload: { text: "启动规划" },
  });
  return { deps, productRunId: run.productRunId };
}

afterEach(() => vi.unstubAllGlobals());

describe("Outbox结果未知栅栏", () => {
  it("Runtime成功响应体损坏时进入outcome_unknown，对账不得第二次Start", async () => {
    const { deps, productRunId } = await seed();
    let startCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/start")) {
          startCalls += 1;
          return new Response("not-json", { status: 201 });
        }
        if (url.includes("/reconcile")) {
          return Response.json({
            schemaVersion: "chat-workflow-dispatch.v1",
            productRunId,
            startBinding: "outcome_unknown",
          });
        }
        throw new Error("unexpected fetch");
      }),
    );
    const dispatcher = new OutboxDispatcher({
      deps,
      workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
      credential: "rtk_test",
    });

    await dispatcher.tick();
    let { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
    let entry = Object.values(snapshot.outbox)[0];
    expect(entry?.status).toBe("outcome_unknown");
    expect(entry?.dispatchAttempts).toBe(1);

    await dispatcher.tick();
    await dispatcher.tick();
    ({ snapshot } = await deps.store.read({ kind: "committedSnapshot" }));
    entry = Object.values(snapshot.outbox)[0];
    expect(entry?.status).toBe("outcome_unknown");
    expect(entry?.dispatchAttempts).toBe(1);
    expect(startCalls).toBe(1);
  });
});

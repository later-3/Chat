import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decisionRequestSchema } from "../src/contracts.ts";
import { AtomicBridgeStateStore } from "../src/state-store.ts";

const command = (character: string): string => `cmd_${character.repeat(48)}`;

test("bridge mapping survives reload in a private atomic JSON file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-state-"));
  const path = join(directory, "bridge.json");
  try {
    const store = new AtomicBridgeStateStore(path);
    await store.ready();
    await store.mutateSession("dsh-session-1", command("a"), (binding) => {
      binding.chatSessionId = "psn_session1";
      binding.currentRequestKey = "request-1";
      binding.requests["request-1"] = {
        dshMessageId: "msg_dsh1",
        userTextSha256: "b".repeat(64),
        messageCommandId: command("c"),
        productRunId: "run_run1",
        pendingDecision: {
          bodySha256: "d".repeat(64),
          commandId: command("e"),
          productRunId: "run_run1",
          expectedRunRevision: 2,
          approvalRequestId: "apr_approval1",
          planId: "pln_plan1",
          planRevision: 1,
          planSha256: "f".repeat(64),
          request: decisionRequestSchema.parse({
            kind: "request_revision",
            explanation: "保留原样重试",
            binding: {
              productRunId: "run_run1",
              runRevision: 2,
              approvalRequestId: "apr_approval1",
              planId: "pln_plan1",
              planRevision: 1,
              planSha256: "f".repeat(64),
            },
          }),
        },
      };
    });

    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(
      JSON.parse(await readFile(path, "utf8")).schemaVersion,
      "chat-dsh-lifeos-state.v3",
    );
    const reloaded = new AtomicBridgeStateStore(path);
    const binding = await reloaded.readSession("dsh-session-1");
    assert.equal(binding?.chatSessionId, "psn_session1");
    assert.equal(binding?.requests["request-1"]?.dshMessageId, "msg_dsh1");
    assert.deepEqual(binding?.requests["request-1"]?.pendingDecision?.request, {
      kind: "request_revision",
      explanation: "保留原样重试",
      binding: {
        productRunId: "run_run1",
        runRevision: 2,
        approvalRequestId: "apr_approval1",
        planId: "pln_plan1",
        planRevision: 1,
        planSha256: "f".repeat(64),
      },
    });
    await assert.rejects(
      reloaded.mutateSession("dsh-session-1", command("z"), () => undefined),
      /command identity mismatch/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v1/v2 bridge state migrates atomically to v3 before trace anchors are written", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-state-v1-"));
  const path = join(directory, "bridge.json");
  try {
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: "chat-dsh-lifeos-state.v1",
        sessions: {
          "dsh-session-1": {
            createSessionCommandId: command("a"),
            requests: {},
          },
        },
      })}\n`,
      { mode: 0o600 },
    );
    const store = new AtomicBridgeStateStore(path);
    await store.ready();
    assert.equal((await store.readSession("dsh-session-1"))?.createSessionCommandId, command("a"));
    assert.equal(
      JSON.parse(await readFile(path, "utf8")).schemaVersion,
      "chat-dsh-lifeos-state.v3",
    );
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid persisted bridge state fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-state-invalid-"));
  const path = join(directory, "bridge.json");
  try {
    await writeFile(path, '{"schemaVersion":"wrong","sessions":{}}\n', { mode: 0o600 });
    await assert.rejects(new AtomicBridgeStateStore(path).ready());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

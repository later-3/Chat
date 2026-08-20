import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  decisionRequestSchema,
  promptSelectionRequestSchema,
  workflowSelectionSchema,
} from "../src/contracts.ts";
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
      "chat-dsh-lifeos-state.v10",
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

test("new DSH sessions inherit the last selected workflow until the user restores default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-state-workflow-"));
  const path = join(directory, "bridge.json");
  const direct = workflowSelectionSchema.parse({
    workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
    definitionSha256: "f".repeat(64),
    title: "执行 Agent（逐次提示词审核）",
    blueprintKey: "direct",
  });
  try {
    const store = new AtomicBridgeStateStore(path);
    await store.ready();
    await store.selectWorkflow("dsh-session-1", command("a"), direct);

    assert.deepEqual(await store.readWorkflowSelection("dsh-session-2"), direct);
    await store.mutateSession("dsh-session-2", command("b"), () => undefined);
    assert.deepEqual((await store.readSession("dsh-session-2"))?.workflowSelection, direct);

    await store.selectWorkflow("dsh-session-2", command("b"), null);
    assert.equal(await store.readWorkflowSelection("dsh-session-3"), null);
    await store.mutateSession("dsh-session-3", command("c"), () => undefined);
    assert.equal((await store.readSession("dsh-session-3"))?.workflowSelection, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v7 bridge state migrates its latest explicit workflow choice to the v10 preference", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-state-v7-"));
  const path = join(directory, "bridge.json");
  const direct = {
    workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
    definitionSha256: "f".repeat(64),
    title: "执行 Agent（逐次提示词审核）",
    blueprintKey: "direct",
  };
  try {
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: "chat-dsh-lifeos-state.v7",
        sessions: {
          "dsh-session-1": {
            createSessionCommandId: command("a"),
            requests: {},
            workflowSelection: direct,
          },
          "dsh-session-2": {
            createSessionCommandId: command("b"),
            requests: {},
          },
        },
      })}\n`,
      { mode: 0o600 },
    );

    const store = new AtomicBridgeStateStore(path);
    await store.ready();
    assert.deepEqual(await store.readWorkflowSelection("dsh-session-3"), direct);
    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      schemaVersion: string;
      preferredWorkflowSelection: unknown;
    };
    assert.equal(persisted.schemaVersion, "chat-dsh-lifeos-state.v10");
    assert.deepEqual(persisted.preferredWorkflowSelection, direct);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v8 bridge state preserves its top-level workflow preference while migrating to v10", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-state-v8-"));
  const path = join(directory, "bridge.json");
  const direct = workflowSelectionSchema.parse({
    workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
    definitionSha256: "f".repeat(64),
    title: "执行 Agent（逐次提示词审核）",
    blueprintKey: "direct",
  });
  try {
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: "chat-dsh-lifeos-state.v8",
        preferredWorkflowSelection: direct,
        sessions: {
          "dsh-session-1": {
            createSessionCommandId: command("a"),
            currentRequestKey: "request-1",
            requests: {
              "request-1": {
                dshMessageId: "msg_dsh1",
                userTextSha256: "b".repeat(64),
                messageCommandId: command("c"),
                productUserMessageId: "msg_product1",
                productRunId: "run_run1",
                traceCursor: 3,
              },
            },
          },
        },
      })}\n`,
      { mode: 0o600 },
    );

    const store = new AtomicBridgeStateStore(path);
    await store.ready();
    assert.deepEqual(await store.readWorkflowSelection("dsh-session-2"), direct);
    const request = (await store.readSession("dsh-session-1"))?.requests["request-1"];
    assert.equal(request?.productUserMessageId, "msg_product1");
    assert.equal(request?.traceCursor, 3);
    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      schemaVersion: string;
      preferredWorkflowSelection: unknown;
    };
    assert.equal(persisted.schemaVersion, "chat-dsh-lifeos-state.v10");
    assert.deepEqual(persisted.preferredWorkflowSelection, direct);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v1 bridge state migrates atomically to v10 before workflow drafts are written", async () => {
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
      "chat-dsh-lifeos-state.v10",
    );
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v2 bridge state migrates atomically to v10 before Note decisions are written", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-state-v2-"));
  const path = join(directory, "bridge.json");
  try {
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: "chat-dsh-lifeos-state.v2",
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
    assert.equal(
      JSON.parse(await readFile(path, "utf8")).schemaVersion,
      "chat-dsh-lifeos-state.v10",
    );
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v3 bridge state migrates to v10 and starts trajectory cursor at zero", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-state-v3-"));
  const path = join(directory, "bridge.json");
  try {
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: "chat-dsh-lifeos-state.v3",
        sessions: {
          "dsh-session-1": {
            createSessionCommandId: command("a"),
            currentRequestKey: "request-1",
            requests: {
              "request-1": {
                userTextSha256: "b".repeat(64),
                messageCommandId: command("c"),
                productRunId: "run_run1",
              },
            },
          },
        },
      })}\n`,
      { mode: 0o600 },
    );
    const store = new AtomicBridgeStateStore(path);
    await store.ready();
    const binding = await store.readSession("dsh-session-1");
    assert.equal(binding?.requests["request-1"]?.traceCursor, undefined);
    await store.advanceTraceCursor("dsh-session-1", "run_run1", 3);
    assert.equal((await store.readSession("dsh-session-1"))?.requests["request-1"]?.traceCursor, 3);
    assert.equal(
      JSON.parse(await readFile(path, "utf8")).schemaVersion,
      "chat-dsh-lifeos-state.v10",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v4 bridge state migrates to v10 with optional Product Message links absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-state-v4-"));
  const path = join(directory, "bridge.json");
  try {
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: "chat-dsh-lifeos-state.v4",
        sessions: {
          "dsh-session-1": {
            createSessionCommandId: command("a"),
            currentRequestKey: "request-1",
            requests: {
              "request-1": {
                dshMessageId: "msg_dsh1",
                userTextSha256: "b".repeat(64),
                messageCommandId: command("c"),
                productRunId: "run_run1",
              },
            },
          },
        },
      })}\n`,
      { mode: 0o600 },
    );
    const store = new AtomicBridgeStateStore(path);
    await store.ready();
    const request = (await store.readSession("dsh-session-1"))?.requests["request-1"];
    assert.equal(request?.productUserMessageId, undefined);
    assert.equal(request?.productAssistantMessageId, undefined);
    assert.equal(
      JSON.parse(await readFile(path, "utf8")).schemaVersion,
      "chat-dsh-lifeos-state.v10",
    );
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v5 bridge state migrates to v10 before Workspace instructions are cached", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-state-v5-"));
  const path = join(directory, "bridge.json");
  try {
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: "chat-dsh-lifeos-state.v5",
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
    assert.equal(
      JSON.parse(await readFile(path, "utf8")).schemaVersion,
      "chat-dsh-lifeos-state.v10",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prompt selection is session-local and survives an atomic reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-state-prompt-"));
  const path = join(directory, "bridge.json");
  const selection = promptSelectionRequestSchema.shape.promptSelection.parse({
    schemaVersion: "prompt-turn-selection-input.v1" as const,
    workspaceRootId: "root_chat",
    regions: [
      {
        regionKey: "rules",
        mode: "append" as const,
        selected: [
          {
            promptFragmentRevisionId: "pfr_customrulesv1",
            sha256: "a".repeat(64),
          },
        ],
      },
    ],
  });
  try {
    const store = new AtomicBridgeStateStore(path);
    await store.ready();
    await store.selectPrompt("dsh-session-1", command("a"), selection);
    assert.deepEqual(await store.readPromptSelection("dsh-session-1"), selection);
    assert.equal(await store.readPromptSelection("dsh-session-2"), undefined);

    const reloaded = new AtomicBridgeStateStore(path);
    assert.deepEqual(await reloaded.readPromptSelection("dsh-session-1"), selection);
    assert.equal(
      JSON.parse(await readFile(path, "utf8")).schemaVersion,
      "chat-dsh-lifeos-state.v10",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("DSH send review switch is session-local, durable, and v9 migrates disabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-state-send-review-"));
  const path = join(directory, "bridge.json");
  try {
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: "chat-dsh-lifeos-state.v9",
        preferredWorkflowSelection: null,
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
    assert.equal(await store.readDshSendReviewEnabled("dsh-session-1"), false);
    await store.setDshSendReviewEnabled("dsh-session-1", command("a"), true);
    assert.equal(await store.readDshSendReviewEnabled("dsh-session-1"), true);
    assert.equal(await store.readDshSendReviewEnabled("dsh-session-2"), false);

    const reloaded = new AtomicBridgeStateStore(path);
    assert.equal(await reloaded.readDshSendReviewEnabled("dsh-session-1"), true);
    assert.equal(
      JSON.parse(await readFile(path, "utf8")).schemaVersion,
      "chat-dsh-lifeos-state.v10",
    );
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

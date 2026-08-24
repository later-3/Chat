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
        submissionTarget: "first_message",
        submissionStatus: "bound",
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
      "chat-dsh-lifeos-state.v15",
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

test("new DSH sessions inherit only the explicit new-session workflow preference", async () => {
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
    await store.selectWorkflow("dsh-session-1", command("a"), direct, "session_and_new_sessions");

    assert.deepEqual(await store.readWorkflowSelection("dsh-session-2"), direct);
    await store.mutateSession("dsh-session-2", command("b"), () => undefined);
    assert.deepEqual((await store.readSession("dsh-session-2"))?.sessionWorkflowSelection, direct);

    await store.selectWorkflow("dsh-session-2", command("b"), null, "session_and_new_sessions");
    assert.equal(await store.readWorkflowSelection("dsh-session-3"), null);
    await store.mutateSession("dsh-session-3", command("c"), () => undefined);
    assert.equal((await store.readSession("dsh-session-3"))?.sessionWorkflowSelection, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workflow scopes independently update the current session and future sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-state-workflow-scopes-"));
  const path = join(directory, "bridge.json");
  const direct = workflowSelectionSchema.parse({
    workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
    definitionSha256: "a".repeat(64),
    title: "执行 Agent（逐次提示词审核）",
    blueprintKey: "direct",
  });
  const planning = workflowSelectionSchema.parse({
    workflowDefinitionRevisionId: "wfr_systemplanningv1",
    definitionSha256: "b".repeat(64),
    title: "规划与执行",
    blueprintKey: "planning",
  });
  try {
    const store = new AtomicBridgeStateStore(path);
    await store.ready();
    await store.mutateSession("dsh-session-current", command("a"), () => undefined);

    await store.selectWorkflow("dsh-session-current", command("a"), direct, "session");
    assert.deepEqual(await store.readWorkflowSelection("dsh-session-current"), direct);
    assert.equal(await store.readNewSessionWorkflowPreference(), null);
    assert.equal(await store.readWorkflowSelection("dsh-session-future"), null);

    await store.selectWorkflow("dsh-session-current", command("a"), planning, "new_sessions");
    assert.deepEqual(await store.readWorkflowSelection("dsh-session-current"), direct);
    assert.deepEqual(await store.readNewSessionWorkflowPreference(), planning);
    assert.deepEqual(await store.readWorkflowSelection("dsh-session-future"), planning);

    await store.mutateSession("dsh-session-future", command("b"), () => undefined);
    await store.selectWorkflow(
      "dsh-session-current",
      command("a"),
      direct,
      "session_and_new_sessions",
    );
    assert.deepEqual(await store.readWorkflowSelection("dsh-session-current"), direct);
    assert.deepEqual(await store.readNewSessionWorkflowPreference(), direct);
    assert.deepEqual(await store.readWorkflowSelection("dsh-session-future"), planning);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("every first-write order materializes the inherited workflow exactly once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-state-first-write-order-"));
  const path = join(directory, "bridge.json");
  const direct = workflowSelectionSchema.parse({
    workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
    definitionSha256: "c".repeat(64),
    title: "执行 Agent（逐次提示词审核）",
    blueprintKey: "direct",
  });
  const prompt = promptSelectionRequestSchema.shape.promptSelection.parse({
    schemaVersion: "prompt-turn-selection-input.v1",
    workspaceRootId: "root_chat",
    regions: [],
  });
  try {
    const store = new AtomicBridgeStateStore(path);
    await store.ready();

    await store.selectWorkflow("dsh-session-a", command("a"), direct, "session_and_new_sessions");
    await store.selectPrompt("dsh-session-a", command("a"), prompt);
    assert.deepEqual(await store.readWorkflowSelection("dsh-session-a"), direct);
    assert.deepEqual(await store.readPromptSelection("dsh-session-a"), prompt);

    await store.selectPrompt("dsh-session-b", command("b"), prompt);
    assert.deepEqual(await store.readWorkflowSelection("dsh-session-b"), direct);
    await store.selectWorkflow("dsh-session-b", command("b"), direct, "session");
    assert.deepEqual(await store.readPromptSelection("dsh-session-b"), prompt);

    await store.setBridgeDispatchReviewEnabled("dsh-session-c", command("c"), true);
    await store.selectPrompt("dsh-session-c", command("c"), prompt);
    assert.equal(await store.readBridgeDispatchReviewEnabled("dsh-session-c"), true);
    assert.deepEqual(await store.readWorkflowSelection("dsh-session-c"), direct);
    assert.deepEqual(await store.readPromptSelection("dsh-session-c"), prompt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v1-v7 bridge state never manufactures a global preference from session object order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-state-v7-"));
  const path = join(directory, "bridge.json");
  const direct = {
    workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
    definitionSha256: "f".repeat(64),
    title: "执行 Agent（逐次提示词审核）",
    blueprintKey: "direct",
  };
  try {
    const migratedDirect = workflowSelectionSchema.parse(direct);
    for (const version of ["v1", "v2", "v3", "v4", "v5", "v6", "v7"]) {
      await writeFile(
        path,
        `${JSON.stringify({
          schemaVersion: `chat-dsh-lifeos-state.${version}`,
          sessions: {
            "dsh-session-with-selection": {
              createSessionCommandId: command("a"),
              requests: {},
              workflowSelection: direct,
            },
            "dsh-session-without-selection": {
              createSessionCommandId: command("b"),
              requests: {},
            },
          },
        })}\n`,
        { mode: 0o600 },
      );

      const store = new AtomicBridgeStateStore(path);
      await store.ready();
      assert.deepEqual(
        await store.readWorkflowSelection("dsh-session-with-selection"),
        migratedDirect,
      );
      assert.equal(await store.readWorkflowSelection("dsh-session-new"), null);
      const persisted = JSON.parse(await readFile(path, "utf8")) as {
        schemaVersion: string;
        newSessionWorkflowPreference: unknown;
        sessions: Record<string, { sessionWorkflowSelection?: unknown }>;
      };
      assert.equal(persisted.schemaVersion, "chat-dsh-lifeos-state.v15");
      assert.equal(persisted.newSessionWorkflowPreference, null);
      assert.deepEqual(
        persisted.sessions["dsh-session-with-selection"]?.sessionWorkflowSelection,
        migratedDirect,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v8 bridge state preserves its top-level workflow preference while migrating to v15", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-state-v8-"));
  const path = join(directory, "bridge.json");
  const legacyDirect = {
    workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
    definitionSha256: "f".repeat(64),
    title: "执行 Agent（逐次提示词审核）",
    blueprintKey: "direct" as const,
  };
  const direct = workflowSelectionSchema.parse(legacyDirect);
  try {
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: "chat-dsh-lifeos-state.v8",
        preferredWorkflowSelection: legacyDirect,
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
      newSessionWorkflowPreference: unknown;
    };
    assert.equal(persisted.schemaVersion, "chat-dsh-lifeos-state.v15");
    assert.deepEqual(persisted.newSessionWorkflowPreference, direct);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v1 bridge state migrates atomically to v15 before workflow drafts are written", async () => {
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
      "chat-dsh-lifeos-state.v15",
    );
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v2 bridge state migrates atomically to v15 before Note decisions are written", async () => {
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
      "chat-dsh-lifeos-state.v15",
    );
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v3 bridge state migrates to v15 without manufacturing a trajectory cursor", async () => {
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
    assert.equal(
      JSON.parse(await readFile(path, "utf8")).schemaVersion,
      "chat-dsh-lifeos-state.v15",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v4 bridge state migrates to v15 with optional Product Message links absent", async () => {
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
      "chat-dsh-lifeos-state.v15",
    );
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v5 bridge state migrates to v15 before Workspace instructions are cached", async () => {
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
      "chat-dsh-lifeos-state.v15",
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
      "chat-dsh-lifeos-state.v15",
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
      "chat-dsh-lifeos-state.v15",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v10 workflow drafts migrate to v15 with empty run configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-state-v10-"));
  const path = join(directory, "bridge.json");
  const legacyDirect = {
    workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
    definitionSha256: "f".repeat(64),
    title: "执行 Agent（逐次提示词审核）",
    blueprintKey: "direct" as const,
  };
  try {
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: "chat-dsh-lifeos-state.v10",
        preferredWorkflowSelection: legacyDirect,
        sessions: {
          "dsh-session-1": {
            createSessionCommandId: command("a"),
            requests: {},
            workflowSelection: legacyDirect,
            dshSendReviewEnabled: true,
          },
        },
      })}\n`,
      { mode: 0o600 },
    );

    const store = new AtomicBridgeStateStore(path);
    await store.ready();
    const expected = workflowSelectionSchema.parse(legacyDirect);
    assert.deepEqual(await store.readWorkflowSelection("dsh-session-1"), expected);
    assert.deepEqual(await store.readWorkflowSelection("dsh-session-2"), expected);
    assert.equal(await store.readDshSendReviewEnabled("dsh-session-1"), true);
    assert.equal(
      JSON.parse(await readFile(path, "utf8")).schemaVersion,
      "chat-dsh-lifeos-state.v15",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v10 bridge state preserves all bindings while the Bridge dispatch gate migrates disabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-state-v10-dispatch-review-"));
  const path = join(directory, "bridge.json");
  const legacyDirect = {
    workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
    definitionSha256: "f".repeat(64),
    title: "执行 Agent（逐次提示词审核）",
    blueprintKey: "direct" as const,
  };
  const direct = workflowSelectionSchema.parse(legacyDirect);
  const promptSelection = promptSelectionRequestSchema.shape.promptSelection.parse({
    schemaVersion: "prompt-turn-selection-input.v1",
    workspaceRootId: "root_chat",
    regions: [],
  });
  try {
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: "chat-dsh-lifeos-state.v10",
        preferredWorkflowSelection: legacyDirect,
        sessions: {
          "dsh-session-1": {
            createSessionCommandId: command("a"),
            chatSessionId: "psn_statev10",
            currentRequestKey: "request-1",
            requests: {
              "request-1": {
                dshMessageId: "msg_dshv10",
                userTextSha256: "b".repeat(64),
                messageCommandId: command("c"),
                productUserMessageId: "msg_productuserv10",
                productAssistantMessageId: "msg_productassistantv10",
                productRunId: "run_statev10",
                traceCursor: 7,
                workflowSelection: legacyDirect,
                promptSelection,
              },
            },
            workflowSelection: legacyDirect,
            promptSelection,
            dshSendReviewEnabled: true,
          },
        },
      })}\n`,
      { mode: 0o600 },
    );

    const store = new AtomicBridgeStateStore(path);
    await store.ready();
    const binding = await store.readSession("dsh-session-1");
    assert.equal(binding?.chatSessionId, "psn_statev10");
    assert.equal(binding?.currentRequestKey, "request-1");
    assert.deepEqual(binding?.sessionWorkflowSelection, direct);
    assert.deepEqual(binding?.promptSelection, promptSelection);
    assert.equal(binding?.dshSendReviewEnabled, true);
    assert.equal(binding?.bridgeDispatchReviewEnabled, false);
    assert.deepEqual(binding?.requests["request-1"], {
      dshMessageId: "msg_dshv10",
      userTextSha256: "b".repeat(64),
      messageCommandId: command("c"),
      submissionTarget: "existing_session",
      submissionStatus: "bound",
      productUserMessageId: "msg_productuserv10",
      productAssistantMessageId: "msg_productassistantv10",
      productRunId: "run_statev10",
      traceCursor: 7,
      workflowSelection: direct,
      promptSelection,
    });
    assert.deepEqual(await store.readWorkflowSelection("dsh-session-2"), direct);
    assert.equal(await store.readBridgeDispatchReviewEnabled("dsh-session-1"), false);

    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      schemaVersion: string;
      sessions: Record<string, { bridgeDispatchReviewEnabled?: boolean }>;
    };
    assert.equal(persisted.schemaVersion, "chat-dsh-lifeos-state.v15");
    assert.equal(persisted.sessions["dsh-session-1"]?.bridgeDispatchReviewEnabled, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("main v11 state preserves Run Configuration and adds the Bridge dispatch gate disabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-state-main-v11-"));
  const path = join(directory, "bridge.json");
  const direct = workflowSelectionSchema.parse({
    workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
    definitionSha256: "f".repeat(64),
    title: "执行 Agent（逐次提示词审核）",
    blueprintKey: "direct",
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
  });
  try {
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: "chat-dsh-lifeos-state.v11",
        preferredWorkflowSelection: direct,
        sessions: {
          "dsh-session-1": {
            createSessionCommandId: command("a"),
            requests: {},
            workflowSelection: direct,
            dshSendReviewEnabled: true,
          },
        },
      })}\n`,
      { mode: 0o600 },
    );

    const store = new AtomicBridgeStateStore(path);
    await store.ready();
    assert.deepEqual(await store.readWorkflowSelection("dsh-session-1"), direct);
    assert.equal(await store.readDshSendReviewEnabled("dsh-session-1"), true);
    assert.equal(await store.readBridgeDispatchReviewEnabled("dsh-session-1"), false);
    assert.equal(
      JSON.parse(await readFile(path, "utf8")).schemaVersion,
      "chat-dsh-lifeos-state.v15",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Prompt纵向v11 state preserves its Bridge gate and gains default Run Configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-state-prompt-v11-"));
  const path = join(directory, "bridge.json");
  const legacyDirect = {
    workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
    definitionSha256: "f".repeat(64),
    title: "执行 Agent（逐次提示词审核）",
    blueprintKey: "direct" as const,
  };
  try {
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: "chat-dsh-lifeos-state.v11",
        preferredWorkflowSelection: legacyDirect,
        sessions: {
          "dsh-session-1": {
            createSessionCommandId: command("a"),
            requests: {},
            workflowSelection: legacyDirect,
            dshSendReviewEnabled: true,
            bridgeDispatchReviewEnabled: true,
          },
        },
      })}\n`,
      { mode: 0o600 },
    );

    const store = new AtomicBridgeStateStore(path);
    await store.ready();
    const expected = workflowSelectionSchema.parse(legacyDirect);
    assert.deepEqual(await store.readWorkflowSelection("dsh-session-1"), expected);
    assert.equal(await store.readBridgeDispatchReviewEnabled("dsh-session-1"), true);
    assert.equal(
      JSON.parse(await readFile(path, "utf8")).schemaVersion,
      "chat-dsh-lifeos-state.v15",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v12 migration preserves response-unknown frozen bootstrap requests and historical Runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-state-v12-bootstrap-"));
  const path = join(directory, "bridge.json");
  const direct = workflowSelectionSchema.parse({
    workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
    definitionSha256: "d".repeat(64),
    title: "执行 Agent（逐次提示词审核）",
    blueprintKey: "direct",
  });
  const bootstrap = workflowSelectionSchema.parse({
    workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
    definitionSha256: "e".repeat(64),
    title: "项目初始化",
    blueprintKey: "direct",
    runConfiguration: {
      schemaVersion: "workflow-run-configuration.v1",
      overrides: [
        {
          kind: "node_config",
          definitionNodeId: "direct.agent",
          field: "capabilityMode",
          value: "project_bootstrap",
        },
      ],
    },
  });
  const prompt = promptSelectionRequestSchema.shape.promptSelection.parse({
    schemaVersion: "prompt-turn-selection-input.v1",
    workspaceRootId: "root_chat",
    regions: [],
  });
  const historicalRequest = {
    dshMessageId: "msg_dshv12",
    userTextSha256: "f".repeat(64),
    messageCommandId: command("c"),
    productUserMessageId: "msg_productuserv12",
    productRunId: "run_statev12",
    workflowSelection: bootstrap,
    promptSelection: prompt,
  };
  const unsentRequest = {
    dshMessageId: "msg_dshv12unsent",
    userTextSha256: "a".repeat(64),
    messageCommandId: command("d"),
    workflowSelection: bootstrap,
    promptSelection: prompt,
  };
  try {
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: "chat-dsh-lifeos-state.v12",
        preferredWorkflowSelection: bootstrap,
        sessions: {
          "dsh-session-bootstrap": {
            createSessionCommandId: command("a"),
            currentRequestKey: "request-unsent",
            requests: {
              "request-historical": historicalRequest,
              "request-unsent": unsentRequest,
            },
            workflowSelection: bootstrap,
            promptSelection: prompt,
            dshSendReviewEnabled: true,
            bridgeDispatchReviewEnabled: false,
          },
        },
      })}\n`,
      { mode: 0o600 },
    );

    const store = new AtomicBridgeStateStore(path);
    await store.ready();
    assert.deepEqual(await store.readNewSessionWorkflowPreference(), {
      ...bootstrap,
      runConfiguration: { schemaVersion: "workflow-run-configuration.v1", overrides: [] },
    });
    const binding = await store.readSession("dsh-session-bootstrap");
    assert.deepEqual(binding?.sessionWorkflowSelection, {
      ...bootstrap,
      runConfiguration: { schemaVersion: "workflow-run-configuration.v1", overrides: [] },
    });
    assert.deepEqual(binding?.promptSelection, prompt);
    assert.deepEqual(binding?.requests["request-historical"], {
      ...historicalRequest,
      submissionTarget: "first_message",
      submissionStatus: "bound",
    });
    assert.deepEqual(binding?.requests["request-unsent"], {
      ...unsentRequest,
      submissionTarget: "first_message",
      submissionStatus: "outcome_unknown",
    });
    assert.equal(binding?.projectBootstrapLifecycle, undefined);

    await store.selectWorkflow("dsh-session-bootstrap", command("a"), direct, "session");
    assert.deepEqual(await store.readWorkflowSelection("dsh-session-bootstrap"), direct);

    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      schemaVersion: string;
      newSessionWorkflowPreference: unknown;
      sessions: Record<string, { projectBootstrapLifecycle?: unknown }>;
    };
    assert.equal(persisted.schemaVersion, "chat-dsh-lifeos-state.v15");
    assert.deepEqual(persisted.newSessionWorkflowPreference, {
      ...bootstrap,
      runConfiguration: { schemaVersion: "workflow-run-configuration.v1", overrides: [] },
    });
    assert.equal(persisted.sessions["dsh-session-bootstrap"]?.projectBootstrapLifecycle, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v13 state migrates to v15 with a durable first-message recovery target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-state-v13-target-"));
  const path = join(directory, "bridge.json");
  try {
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: "chat-dsh-lifeos-state.v13",
        newSessionWorkflowPreference: null,
        sessions: {
          "dsh-session-v13-target": {
            createSessionCommandId: command("a"),
            chatSessionId: "psn_statev13target1",
            currentRequestKey: "request-first-half-bound",
            requests: {
              "request-first-half-bound": {
                dshMessageId: "msg_dshv13target1",
                userTextSha256: "b".repeat(64),
                messageCommandId: command("c"),
              },
            },
            dshSendReviewEnabled: false,
            bridgeDispatchReviewEnabled: false,
          },
        },
      })}\n`,
      { mode: 0o600 },
    );

    const store = new AtomicBridgeStateStore(path);
    await store.ready();
    const binding = await store.readSession("dsh-session-v13-target");
    assert.equal(
      binding?.requests["request-first-half-bound"]?.submissionTarget,
      "existing_session",
    );
    assert.equal(
      JSON.parse(await readFile(path, "utf8")).schemaVersion,
      "chat-dsh-lifeos-state.v15",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v14 migration derives only from productRunId and reopening v15 is byte-idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-state-v14-submission-status-"));
  const path = join(directory, "bridge.json");
  const frozenWorkflow = workflowSelectionSchema.parse({
    workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
    definitionSha256: "d".repeat(64),
    title: "冻结的历史Workflow",
    blueprintKey: "direct",
    runConfiguration: {
      schemaVersion: "workflow-run-configuration.v1",
      overrides: [],
    },
  });
  const frozenPrompt = promptSelectionRequestSchema.shape.promptSelection.parse({
    schemaVersion: "prompt-turn-selection-input.v1",
    workspaceRootId: "root_chat",
    regions: [],
  });
  const bound = {
    dshMessageId: "msg_v14bound1",
    userTextSha256: "a".repeat(64),
    messageCommandId: command("b"),
    productUserMessageId: "msg_v14productuser1",
    productRunId: "run_v14bound1",
    workflowSelection: frozenWorkflow,
    promptSelection: frozenPrompt,
    submissionTarget: "existing_session" as const,
  };
  const unknown = {
    dshMessageId: "msg_v14unknown1",
    userTextSha256: "c".repeat(64),
    messageCommandId: command("d"),
    workflowSelection: frozenWorkflow,
    promptSelection: frozenPrompt,
    submissionTarget: "first_message" as const,
  };
  try {
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: "chat-dsh-lifeos-state.v14",
        newSessionWorkflowPreference: null,
        sessions: {
          "dsh-v14-migration": {
            createSessionCommandId: command("a"),
            chatSessionId: "psn_v14bound1",
            currentRequestKey: "request-unknown",
            requests: {
              "request-bound": bound,
              "request-unknown": unknown,
            },
            dshSendReviewEnabled: false,
            bridgeDispatchReviewEnabled: false,
          },
        },
      })}\n`,
      { mode: 0o600 },
    );

    const migrated = new AtomicBridgeStateStore(path);
    await migrated.ready();
    const binding = await migrated.readSession("dsh-v14-migration");
    assert.deepEqual(binding?.requests["request-bound"], {
      ...bound,
      submissionStatus: "bound",
    });
    assert.deepEqual(binding?.requests["request-unknown"], {
      ...unknown,
      submissionStatus: "outcome_unknown",
    });
    assert.equal(binding?.currentRequestKey, "request-unknown");
    assert.equal(binding?.chatSessionId, "psn_v14bound1");
    const firstOpenBytes = await readFile(path, "utf8");

    const reopened = new AtomicBridgeStateStore(path);
    await reopened.ready();
    assert.equal(await readFile(path, "utf8"), firstOpenBytes);
    assert.deepEqual(await reopened.readSession("dsh-v14-migration"), binding);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v15 submission state transitions are durable and invalid reversals fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-state-v15-transitions-"));
  const path = join(directory, "bridge.json");
  const sessionId = "dsh-v15-transitions";
  const requestKey = "request-a";
  try {
    const store = new AtomicBridgeStateStore(path);
    await store.ready();
    await store.mutateSession(sessionId, command("a"), (binding) => {
      binding.currentRequestKey = requestKey;
      binding.requests[requestKey] = {
        dshMessageId: "msg_v15prepared1",
        userTextSha256: "b".repeat(64),
        messageCommandId: command("c"),
        submissionTarget: "first_message",
        submissionStatus: "prepared",
      };
    });
    await store.markRequestOutcomeUnknown(sessionId, command("a"), requestKey);
    await store.markRequestOutcomeUnknown(sessionId, command("a"), requestKey);
    assert.equal(
      (await store.readSession(sessionId))?.requests[requestKey]?.submissionStatus,
      "outcome_unknown",
    );
    await assert.rejects(
      store.markRequestDefinitelyUncommitted(sessionId, command("a"), requestKey, {
        reason: "local_review_rejected",
      }),
      /cannot be cleared by a later local rejection/u,
    );
    await store.markRequestDefinitelyUncommitted(sessionId, command("a"), requestKey, {
      reason: "product_definitely_uncommitted",
    });
    await store.markRequestDefinitelyUncommitted(sessionId, command("a"), requestKey, {
      reason: "product_definitely_uncommitted",
    });
    assert.equal(
      (await store.readSession(sessionId))?.requests[requestKey]?.submissionStatus,
      "definitely_uncommitted",
    );
    await assert.rejects(
      store.markRequestOutcomeUnknown(sessionId, command("a"), requestKey),
      /cannot dispatch request/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("strict v15 rejects missing or contradictory submission states", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-state-v15-invalid-status-"));
  const path = join(directory, "bridge.json");
  const baseRequest = {
    dshMessageId: "msg_v15invalid1",
    userTextSha256: "b".repeat(64),
    messageCommandId: command("c"),
    submissionTarget: "first_message",
  };
  const invalidRequests = [
    baseRequest,
    { ...baseRequest, submissionStatus: "bound" },
    { ...baseRequest, submissionStatus: "outcome_unknown", productRunId: "run_v15invalid1" },
  ];
  try {
    for (const request of invalidRequests) {
      await writeFile(
        path,
        `${JSON.stringify({
          schemaVersion: "chat-dsh-lifeos-state.v15",
          newSessionWorkflowPreference: null,
          sessions: {
            "dsh-v15-invalid": {
              createSessionCommandId: command("a"),
              currentRequestKey: "request-invalid",
              requests: { "request-invalid": request },
              dshSendReviewEnabled: false,
              bridgeDispatchReviewEnabled: false,
            },
          },
        })}\n`,
        { mode: 0o600 },
      );
      await assert.rejects(new AtomicBridgeStateStore(path).ready());
    }
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

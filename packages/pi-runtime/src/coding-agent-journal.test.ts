import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { EXECUTION_CAPABILITY_WORKSPACE_READ, executionContractSchema } from "@chat/contracts";
import { hashCanonical } from "@chat/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCodingExecutorJournalExtension,
  createCodingExecutorJournalState,
  settleCodingExecutorFatal,
} from "./coding-agent-executor.js";
import { PiExecutorOperationStore } from "./executor-operation-store.js";
import {
  PI_EXECUTOR_PROTOCOL_VERSION,
  startPiExecutorOperationRequestSchema,
} from "./executor-service-contract.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function request(operationId: string) {
  const now = "2026-08-23T12:00:00.000Z";
  const contractBody = {
    schemaVersion: "execution-contract.v1" as const,
    executionContractId: "exc_journal1",
    productRunId: "run_journal1",
    approvedPlanId: "pln_journal1",
    approvedPlanRevision: 1,
    approvedPlanSha256: "a".repeat(64),
    approvalDecisionId: "dec_journal1",
    steps: [
      {
        stepId: "step-1",
        title: "读取测试文件",
        purpose: "验证重复Tool Call ID失败关闭",
        dependsOn: [],
        inputRefs: [],
        expectedOutput: "文件内容",
        successCriteria: ["完成读取"],
        capabilityRefs: [EXECUTION_CAPABILITY_WORKSPACE_READ],
      },
    ],
    completionCriteria: ["完成读取"],
    capabilityRefs: [EXECUTION_CAPABILITY_WORKSPACE_READ],
    limits: {
      maxTurnsPerStep: 8,
      timeoutMsPerStep: 60_000,
      tokenBudgetPerStep: 8_000,
    },
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  const contract = executionContractSchema.parse({
    ...contractBody,
    sha256: hashCanonical("execution-contract.v1", {
      productRunId: contractBody.productRunId,
      approvedPlanId: contractBody.approvedPlanId,
      approvedPlanRevision: contractBody.approvedPlanRevision,
      approvedPlanSha256: contractBody.approvedPlanSha256,
      approvalDecisionId: contractBody.approvalDecisionId,
      steps: contractBody.steps,
      completionCriteria: contractBody.completionCriteria,
      capabilityRefs: contractBody.capabilityRefs,
      limits: contractBody.limits,
    }),
  });
  return startPiExecutorOperationRequestSchema.parse({
    schemaVersion: PI_EXECUTOR_PROTOCOL_VERSION,
    operationId,
    executionAttemptId: "att_journal1",
    inputManifestSha256: "b".repeat(64),
    contract,
    stepId: "step-1",
    contextItems: [],
    dependencyResults: [],
  });
}

async function harness(operationId: string) {
  const root = await mkdtemp(join(tmpdir(), "chat-pi-journal-agent-session-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(agentDir, { recursive: true })]);
  await writeFile(join(workspace, "probe.txt"), "journal-probe");
  const store = await PiExecutorOperationStore.open(join(root, "operations"));
  const operationRequest = request(operationId);
  await store.createOrGet(operationRequest);
  await store.markRunning(operationId);
  const sessionId = `pis_${operationId.slice(4)}`;
  await store.setSession(operationId, sessionId, ["read"]);
  const state = createCodingExecutorJournalState();
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const services = await createAgentSessionServices({
    cwd: workspace,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    modelRuntime,
    resourceLoaderOptions: {
      extensionFactories: [
        {
          name: "chat-journal-test",
          hidden: true,
          factory: createCodingExecutorJournalExtension({
            request: operationRequest,
            sessionId,
            workspaceRoot: workspace,
            endpointHost: "faux.local",
            store,
            state,
          }),
        },
      ],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      noThemes: true,
    },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(workspace),
    model: faux.getModel(),
    thinkingLevel: "off",
    tools: ["read"],
  });
  return { faux, operationId, session, state, store };
}

async function assertFatal(
  value: Awaited<ReturnType<typeof harness>>,
  expectedDurableIntents: number,
): Promise<void> {
  await expect(
    settleCodingExecutorFatal({
      operationId: value.operationId,
      store: value.store,
      state: value.state,
    }),
  ).rejects.toMatchObject({ code: "executor.tool_call_id_reused" });
  expect(value.store.getSnapshot(value.operationId)).toMatchObject({
    status: "outcome_unknown",
    errorCode: "executor.tool_call_id_reused",
  });
  const events = value.store.getEvents(value.operationId);
  expect(events.filter((event) => event.type === "tool.intent_persisted")).toHaveLength(
    expectedDurableIntents,
  );
  expect(events.some((event) => event.type === "operation.completed")).toBe(false);
}

describe("Coding Executor真实Pi AgentSession Tool Journal", () => {
  it("同批并行重复toolCallId不会覆盖首个Intent且Operation耐久熔断", async () => {
    const value = await harness("pio_journalbatch1");
    value.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("read", { path: "probe.txt" }, { id: "call_duplicate" }),
          fauxToolCall("read", { path: "probe.txt" }, { id: "call_duplicate" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("工具轮次结束"),
    ]);
    try {
      await value.session.prompt("并行读取两次");
      await assertFatal(value, 1);
    } finally {
      value.session.dispose();
    }
  });

  it("跨轮重复toolCallId被真实Pi转成Tool Error后仍不能返回成功", async () => {
    const value = await harness("pio_journalturns1");
    try {
      value.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("read", { path: "probe.txt" }, { id: "call_reused" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("第一轮完成"),
      ]);
      await value.session.prompt("第一轮读取");
      expect(value.state.fatalError).toBeUndefined();

      value.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("read", { path: "probe.txt" }, { id: "call_reused" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("第二轮完成"),
      ]);
      await value.session.prompt("第二轮复用ID");
      await assertFatal(value, 1);
    } finally {
      value.session.dispose();
    }
  });
});

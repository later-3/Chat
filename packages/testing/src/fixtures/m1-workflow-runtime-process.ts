import { serve } from "@hono/node-server";
import { appendFile } from "node:fs/promises";
import type {
  ExecutionContract,
  MemoryBackendId,
  PlanContent,
  PlanningInputDto,
} from "@chat/contracts";
import { planContentSchema } from "@chat/contracts";
import type { MemoryBackendPort, MemoryBackendRegistryPort } from "@chat/application";
import type { AgentRunResult, ExecutorStepCandidate } from "@chat/pi-runtime";
import { createWorkflowRuntimeServer, setWorkflowRuntimeContext } from "@chat/workflows";
import { createDeterministicWorkflowMemoryRegistry } from "./workflow-memory-test-provider.js";

interface ProcessOptions {
  readonly repoRoot: string;
  readonly bundleDir: string;
  readonly workflowDataDir: string;
  readonly bindingsPath: string;
  readonly apiBaseUrl: string;
  readonly credential: string;
  readonly memoryCallsPath: string;
  readonly plannerCallsPath: string;
}

const rawOptions = process.argv[2];
if (rawOptions === undefined) throw new Error("缺少Workflow Runtime测试进程参数");
const options = JSON.parse(rawOptions) as ProcessOptions;

const backend: MemoryBackendPort = {
  describe: () => ({
    backendId: "mbk_memmy" as MemoryBackendId,
    displayName: "memmy 确定性恢复测试",
    kind: "memmy",
    adapterContractVersion: "memmy-http-query.v1",
    authMode: "none",
    credentialRevision: "none",
    configurationFingerprint: "a".repeat(64),
    configured: true,
    capabilities: {
      query: true,
      tags: true,
      layers: ["L1", "L2", "L3", "Skill"],
      maxLimit: 20,
      maxContextBudget: 8_192,
    },
  }),
  health: async () => ({ status: "ready" }),
  query: async (input) => {
    if (input.tags.join(",") !== "recovery" || input.layers.join(",") !== "L2") {
      throw new Error("恢复测试收到非预期Memory查询条件");
    }
    await appendFile(options.memoryCallsPath, `${input.operationId}\n`, "utf8");
    return {
      externalQueryId: "memory-query-recovery-1",
      hitCount: 1,
      tokenEstimate: 16,
      sections: [
        {
          externalObjectIds: ["memory-recovery-1"],
          title: "恢复测试事实",
          kind: "world_model",
          memoryLayer: "L2",
          content: "Aurora 的恢复校验色是 heliotrope。",
          tags: ["recovery"],
          score: 0.99,
          tokenEstimate: 16,
        },
      ],
    };
  },
};

const memoryBackends: MemoryBackendRegistryPort = {
  list: () => [backend],
  get: (backendId) => (backendId === "mbk_memmy" ? backend : undefined),
};

const workflowMemoryProviders = createDeterministicWorkflowMemoryRegistry(
  async (input) => {
    await appendFile(options.memoryCallsPath, `query:${input.operationId}\n`, "utf8");
    return {
      externalQueryId: "workflow-memory-query-recovery-1",
      hitCount: 1,
      sections: [
        {
          externalObjectIds: ["memory-recovery-1"],
          title: "恢复测试事实",
          category: "fact",
          content: "Aurora 的恢复校验色是 heliotrope。",
          labels: ["recovery"],
          score: 0.99,
        },
      ],
    };
  },
  {
    writeMemory: async (input) => {
      await appendFile(options.memoryCallsPath, `write:${input.operationId}\n`, "utf8");
      return {
        externalObjectId: `memory-write:${input.operationId}`,
        externalObjectVersion: "v1",
        externalStatus: "accepted",
        responseSha256: "a".repeat(64),
      };
    },
  },
);

function planFor(input: PlanningInputDto): PlanContent {
  const memoryRef = input.workflowMemory?.items[0];
  if (memoryRef === undefined) throw new Error("确定性Planner没有收到Workflow Memory Context");
  return planContentSchema.parse({
    objective: "根据恢复测试记忆生成计划",
    summary:
      input.planRevision === 1
        ? "v1：使用 heliotrope 恢复事实"
        : "v2：保留 heliotrope，并补充恢复验证",
    assumptions: [],
    openQuestions: [],
    steps: [
      {
        stepId: "step-1",
        title: "整理恢复结论",
        purpose: "证明重启后仍使用冻结上下文",
        dependsOn: [],
        inputRefs: [
          { refId: memoryRef.refId, revision: memoryRef.revision, sha256: memoryRef.sha256 },
        ],
        expectedOutput: "恢复结论",
        successCriteria: ["包含heliotrope事实"],
        requestedCapabilities: [],
        risk: "low",
      },
    ],
    completionCriteria: ["恢复结论可读"],
    warnings: [],
  });
}

const planner = async (input: {
  planningInput: PlanningInputDto;
}): Promise<AgentRunResult<PlanContent>> => {
  const { planningInput } = input;
  await appendFile(
    options.plannerCallsPath,
    `${JSON.stringify({
      planRevision: planningInput.planRevision,
      workflowMemoryContextRef: planningInput.workflowMemory?.ref,
    })}\n`,
    "utf8",
  );
  return {
    kind: "candidate",
    candidate: planFor(planningInput),
    usage: { inputTokens: 10, outputTokens: 10 },
    durationMs: 1,
    providerCallCount: 1,
    providerMeta: {
      httpStatus: 200,
      providerRequestId: `req-recovery-${String(planningInput.planRevision)}`,
    },
  };
};

const executor = async (input: {
  contract: ExecutionContract;
  stepId: string;
}): Promise<AgentRunResult<ExecutorStepCandidate>> => ({
  kind: "candidate",
  candidate: {
    stepId: input.stepId,
    output: "heliotrope 恢复结论",
    sections: [{ heading: "恢复结论", body: "heliotrope" }],
    successCriteriaEvidence: ["包含heliotrope事实：已包含"],
    criteriaEvidence: ["恢复结论可读：已生成"],
    warnings: [],
  },
  usage: { inputTokens: 5, outputTokens: 5 },
  durationMs: 1,
  providerCallCount: 1,
  providerMeta: { httpStatus: 200, providerRequestId: "req-recovery-executor" },
});

const runtime = await createWorkflowRuntimeServer({
  repoRoot: options.repoRoot,
  bundleDir: options.bundleDir,
  workflowDataDir: options.workflowDataDir,
  bindingsPath: options.bindingsPath,
  apiBaseUrl: options.apiBaseUrl,
  credential: options.credential,
  runtimeOverrides: {
    memoryBackends,
    workflowMemoryProviders,
    bailian: {
      apiKey: "fake",
      baseUrl: "http://127.0.0.1:1/v1",
      endpointHost: "127.0.0.1",
    },
    planner: planner as never,
    executor: executor as never,
    now: () => new Date().toISOString(),
  },
});

const server = serve({ fetch: runtime.app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
  process.stdout.write(`${JSON.stringify({ type: "ready", port: info.port })}\n`);
});

let closing = false;
async function close(exitCode: number): Promise<void> {
  if (closing) return;
  closing = true;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error === undefined ? resolveClose() : reject(error)));
  });
  await runtime.world.close();
  setWorkflowRuntimeContext(undefined);
  process.exit(exitCode);
}

process.once("SIGTERM", () => void close(0));
process.once("SIGINT", () => void close(0));
process.once("uncaughtException", (error) => {
  process.stderr.write(`runtime_fixture_uncaught:${String(error)}\n`);
  void close(1);
});
process.once("unhandledRejection", (error) => {
  process.stderr.write(`runtime_fixture_rejection:${String(error)}\n`);
  void close(1);
});

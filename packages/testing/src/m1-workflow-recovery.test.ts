import { serve } from "@hono/node-server";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  runDtoSchema,
  sessionDtoSchema,
  projectCandidateDtoSchema,
  type MemoryBackendId,
  type ProductRunId,
} from "@chat/contracts";
import {
  type ApplicationDeps,
  type IdFactory,
  type MemoryBackendPort,
  type MemoryBackendRegistryPort,
  type ProjectIdFactory,
} from "@chat/application";
import { createApiApp } from "@chat/api";
import { OutboxDispatcher } from "@chat/api/outbox-dispatcher";
import { JsonProductStore } from "@chat/product-store-json";
import { RuntimeBindingStore } from "@chat/workflows";
import { createProjectResourceRegistry } from "@chat/project-runtime";

/**
 * M1 免费恢复门：真实Hono、JSON Store、Runtime Binding、预构建bundle、
 * Local World与Hook，只把付费pi和外部Memory边界换成可计数的确定性实现。
 *
 * Local World的close()只关闭队列HTTP agent，不清理同进程模块缓存与在途任务，
 * 因此恢复必须在新Node进程中验证，才等价于真实Runtime进程重启。
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BUNDLE_DIR = join(REPO_ROOT, "packages/workflows/.workflow-bundle");
const RUNTIME_FIXTURE = join(
  REPO_ROOT,
  "packages/testing/src/fixtures/m1-workflow-runtime-process.ts",
);
const TSX_BIN = join(REPO_ROOT, "packages/testing/node_modules/.bin/tsx");
const PRINCIPAL_ID = "usr_debug" as const;
const CREDENTIAL = "rtk_m1recoverytest0000000000";
const WAIT_TIMEOUT_MS = 30_000;
const exec = promisify(execFile);

type HttpServer = ReturnType<typeof serve>;

let idCounter = 0;
function testIds(): IdFactory {
  const next = (prefix: string) => `${prefix}_m1r${(++idCounter).toString(36)}`;
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

let projectIdCounter = 0;
function testProjectIds(): ProjectIdFactory {
  const next = (prefix: string) => `${prefix}_m1r${(++projectIdCounter).toString(36)}`;
  return {
    project: () => next("prj") as ReturnType<ProjectIdFactory["project"]>,
    methodSnapshot: () => next("pms") as ReturnType<ProjectIdFactory["methodSnapshot"]>,
    stage: () => next("pst") as ReturnType<ProjectIdFactory["stage"]>,
    resource: () => next("prs") as ReturnType<ProjectIdFactory["resource"]>,
    participant: () => next("ppt") as ReturnType<ProjectIdFactory["participant"]>,
    work: () => next("pwk") as ReturnType<ProjectIdFactory["work"]>,
    action: () => next("pac") as ReturnType<ProjectIdFactory["action"]>,
    contribution: () => next("pct") as ReturnType<ProjectIdFactory["contribution"]>,
    evidence: () => next("pev") as ReturnType<ProjectIdFactory["evidence"]>,
    decision: () => next("pdc") as ReturnType<ProjectIdFactory["decision"]>,
    observation: () => next("pob") as ReturnType<ProjectIdFactory["observation"]>,
    candidate: () => next("pca") as ReturnType<ProjectIdFactory["candidate"]>,
    milestone: () => next("pml") as ReturnType<ProjectIdFactory["milestone"]>,
    update: () => next("pup") as ReturnType<ProjectIdFactory["update"]>,
    stateTransition: () => next("ptr") as ReturnType<ProjectIdFactory["stateTransition"]>,
  };
}

let commandCounter = 0;
function nextCommandId(): string {
  commandCounter += 1;
  return `cmd_m1recovery${commandCounter.toString(36)}`;
}

function listen(
  app: {
    fetch: (request: Request) => Promise<Response> | Response;
  },
  port = 0,
): Promise<{ server: HttpServer; port: number }> {
  return new Promise((resolveListen, reject) => {
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) =>
      resolveListen({ server, port: info.port }),
    );
    server.on("error", reject);
  });
}

async function closeHttpServer(server: HttpServer | undefined): Promise<void> {
  if (server === undefined || !server.listening) return;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error === undefined ? resolveClose() : reject(error)));
  });
}

async function postJson(baseUrl: string, path: string, body: unknown, expectedStatus = 201) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(
      `POST ${path}返回${String(response.status)}，期望${String(expectedStatus)}：${text.slice(0, 1_000)}`,
    );
  }
  return JSON.parse(text) as unknown;
}

async function getProjectCandidateFromApi(baseUrl: string, projectCandidateId: string) {
  const response = await fetch(`${baseUrl}/api/project-candidates/${projectCandidateId}`, {
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GET project candidate返回${String(response.status)}：${text.slice(0, 1_000)}`);
  }
  const body = JSON.parse(text) as { candidate?: unknown };
  return projectCandidateDtoSchema.parse(body.candidate);
}

async function waitForProjectCandidate(
  baseUrl: string,
  projectCandidateId: string,
  status: "under_review" | "confirmed",
) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let candidate = await getProjectCandidateFromApi(baseUrl, projectCandidateId);
  while (Date.now() < deadline) {
    if (candidate.status === status) return candidate;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    candidate = await getProjectCandidateFromApi(baseUrl, projectCandidateId);
  }
  throw new Error(
    `Project Candidate等待${status}超时：${JSON.stringify({
      projectCandidateId,
      candidateKind: candidate.candidateKind,
      status: candidate.status,
      revision: candidate.revision,
    })}`,
  );
}

function createApplicationMemoryRegistry(): MemoryBackendRegistryPort {
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
    query: async () => {
      throw new Error("API进程不得越过Memory查询边界");
    },
  };
  return {
    list: () => [backend],
    get: (backendId) => (backendId === "mbk_memmy" ? backend : undefined),
  };
}

interface RuntimeProcessOptions {
  readonly repoRoot: string;
  readonly bundleDir: string;
  readonly workflowDataDir: string;
  readonly bindingsPath: string;
  readonly apiBaseUrl: string;
  readonly credential: string;
  readonly memoryCallsPath: string;
  readonly plannerCallsPath: string;
}

interface RuntimeProcessHandle {
  readonly baseUrl: string;
  readonly stdout: () => string;
  readonly stderr: () => string;
  stop(): Promise<void>;
}

async function startRuntimeProcess(options: RuntimeProcessOptions): Promise<RuntimeProcessHandle> {
  const child = spawn(TSX_BIN, [RUNTIME_FIXTURE, JSON.stringify(options)], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "test",
      NO_COLOR: "1",
    },
  });
  child.stdin.end();
  let stdout = "";
  let stderr = "";
  let lineBuffer = "";
  let readyPort: number | undefined;
  let resolveReady: ((port: number) => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const ready = new Promise<number>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdout += text;
    lineBuffer += text;
    for (;;) {
      const newline = lineBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = lineBuffer.slice(0, newline);
      lineBuffer = lineBuffer.slice(newline + 1);
      try {
        const parsed = JSON.parse(line) as { type?: string; port?: number };
        if (parsed.type === "ready" && typeof parsed.port === "number") {
          readyPort = parsed.port;
          resolveReady?.(parsed.port);
        }
      } catch {
        // Local World诊断不是JSON；保留在stdout供超时/失败报告使用。
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.once("exit", (code, signal) => {
    if (readyPort === undefined) {
      rejectReady?.(
        new Error(
          `Workflow Runtime在ready前退出 code=${String(code)} signal=${String(signal)} stdout=${stdout.slice(-2_000)} stderr=${stderr.slice(-2_000)}`,
        ),
      );
    }
  });

  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let port: number;
  try {
    port = await Promise.race([
      ready,
      new Promise<never>((_, rejectPromise) => {
        readyTimer = setTimeout(
          () =>
            rejectPromise(
              new Error(
                `Workflow Runtime启动超时 stdout=${stdout.slice(-2_000)} stderr=${stderr.slice(-2_000)}`,
              ),
            ),
          WAIT_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
      child.kill("SIGKILL");
      await exited;
    }
    throw error;
  } finally {
    if (readyTimer !== undefined) clearTimeout(readyTimer);
  }

  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    stdout: () => stdout,
    stderr: () => stderr,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
      child.kill("SIGTERM");
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          exited,
          new Promise<never>((_, rejectPromise) => {
            stopTimer = setTimeout(
              () => rejectPromise(new Error("Workflow Runtime关闭超时")),
              10_000,
            );
          }),
        ]);
      } catch (error) {
        child.kill("SIGKILL");
        await exited;
        throw new Error(
          `Workflow Runtime未能干净关闭 stdout=${stdout.slice(-2_000)} stderr=${stderr.slice(-2_000)}`,
          { cause: error },
        );
      } finally {
        if (stopTimer !== undefined) clearTimeout(stopTimer);
      }
    },
  };
}

async function readLines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter((line) => line.length > 0);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readRunSnapshot(deps: ApplicationDeps, productRunId: ProductRunId) {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const run = snapshot.entities.runs[productRunId];
  const plans = Object.values(snapshot.entities.plans)
    .filter((plan) => plan.productRunId === productRunId)
    .sort((left, right) => left.planRevision - right.planRevision);
  const approvals = Object.values(snapshot.entities.approvalRequests).filter(
    (approval) => approval.productRunId === productRunId,
  );
  return { snapshot, run, plans, approvals };
}

async function waitForRun(
  deps: ApplicationDeps,
  productRunId: ProductRunId,
  label: string,
  predicate: (current: Awaited<ReturnType<typeof readRunSnapshot>>) => boolean | Promise<boolean>,
): Promise<Awaited<ReturnType<typeof readRunSnapshot>>> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let current = await readRunSnapshot(deps, productRunId);
  while (Date.now() < deadline) {
    if (await predicate(current)) return current;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    current = await readRunSnapshot(deps, productRunId);
  }
  const outbox = Object.values(current.snapshot.outbox)
    .filter((entry) => "productRunId" in entry && entry.productRunId === productRunId)
    .map((entry) => ({ kind: entry.kind, status: entry.status, error: entry.lastErrorCode }));
  throw new Error(
    `${label}超时：${JSON.stringify({
      run: current.run,
      plans: current.plans.map((plan) => ({
        revision: plan.planRevision,
        status: plan.status,
      })),
      outbox,
      entityCounts: {
        memoryQueries: Object.keys(current.snapshot.entities.memoryQueries).length,
        memoryResultSnapshots: Object.keys(current.snapshot.entities.memoryResultSnapshots).length,
        memoryAdoptions: Object.keys(current.snapshot.entities.memoryAdoptions).length,
        contextPackages: Object.keys(current.snapshot.entities.contextPackages).length,
      },
      workflowNodeRuns: Object.values(current.snapshot.entities.workflowNodeRuns)
        .filter((node) => node.productRunId === productRunId)
        .map((node) => ({
          definitionNodeId: node.definitionNodeId,
          executionPath: node.executionPath,
          status: node.status,
          outcomeCode: node.outcomeCode,
          revision: node.revision,
        })),
    }).slice(0, 4_000)}`,
  );
}

async function reviewCheckpointReady(
  current: Awaited<ReturnType<typeof readRunSnapshot>>,
  productRunId: ProductRunId,
  bindingsPath: string,
): Promise<boolean> {
  if (current.run?.status !== "waiting_human") return false;
  const approval = current.approvals.find((candidate) => candidate.status === "open");
  if (approval === undefined) return false;
  let hookClaimed = false;
  try {
    const bindings = await RuntimeBindingStore.open(bindingsPath, { allowCreate: false });
    hookClaimed = bindings.getHookBinding(approval.approvalRequestId)?.hookClaimState === "claimed";
  } catch {
    return false;
  }
  if (!hookClaimed) return false;
  const reviewNode = Object.values(current.snapshot.entities.workflowNodeRuns).find(
    (candidate) =>
      candidate.productRunId === productRunId &&
      candidate.nodeType === "human.plan_review" &&
      candidate.status === "waiting_human" &&
      candidate.executionPath.at(-1)?.iteration === approval.planRevision,
  );
  // Plan发布事务原子拥有waiting节点；Hook Binding独立耐久后即可安全重启。
  // Runner不再为同一业务节点追加不同summary/outcome的通用Transition Receipt。
  return reviewNode !== undefined;
}

describe("M1真实Local World恢复", () => {
  it("等待Hook时关闭并恢复同一Workflow，Plan修订复用唯一Memory快照", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-m1-world-recovery-"));
    const productPath = join(root, "product.json");
    const workflowDataDir = join(root, "workflow-data");
    const bindingsPath = join(root, "bindings.json");
    const memoryCallsPath = join(root, "memory-calls.jsonl");
    const plannerCallsPath = join(root, "planner-calls.jsonl");
    let apiServer: HttpServer | undefined;
    let runtimeProcess: RuntimeProcessHandle | undefined;

    try {
      const store = await JsonProductStore.open({
        filePath: productPath,
        now: () => new Date().toISOString(),
      });
      const deps: ApplicationDeps = {
        store,
        now: () => new Date().toISOString(),
        ids: testIds(),
        memoryBackends: createApplicationMemoryRegistry(),
      };
      const apiApp = createApiApp({
        traceSink: null,
        product: { deps, principalId: PRINCIPAL_ID as never },
        internalRuntime: { credential: CREDENTIAL },
      });
      const apiListener = await listen(apiApp);
      apiServer = apiListener.server;
      const apiBaseUrl = `http://127.0.0.1:${String(apiListener.port)}`;
      const runtimeOptions: RuntimeProcessOptions = {
        repoRoot: root,
        bundleDir: BUNDLE_DIR,
        workflowDataDir,
        bindingsPath,
        apiBaseUrl,
        credential: CREDENTIAL,
        memoryCallsPath,
        plannerCallsPath,
      };

      runtimeProcess = await startRuntimeProcess(runtimeOptions);
      let dispatcher = new OutboxDispatcher({
        deps,
        workflowRuntimeBaseUrl: runtimeProcess.baseUrl,
        credential: CREDENTIAL,
      });

      const sessionResponse = (await postJson(apiBaseUrl, "/api/sessions", {
        commandId: nextCommandId(),
        payload: {},
      })) as { session: unknown };
      const session = sessionDtoSchema.parse(sessionResponse.session);
      const messageResponse = (await postJson(
        apiBaseUrl,
        `/api/sessions/${session.sessionId}/messages`,
        {
          commandId: nextCommandId(),
          payload: {
            text: "Aurora 的恢复校验色是什么？",
            context: {
              memory: {
                backendId: "mbk_memmy",
                requirement: "required",
                tags: ["recovery"],
                layers: ["L2"],
                limit: 3,
                contextBudget: 512,
              },
            },
          },
        },
      )) as { run: unknown };
      const submittedRun = runDtoSchema.parse(messageResponse.run);
      const productRunId = submittedRun.productRunId;

      await dispatcher.tick();
      let current = await waitForRun(
        deps,
        productRunId,
        "Plan v1等待Hook",
        async (candidate) =>
          candidate.plans.length === 1 &&
          (await reviewCheckpointReady(candidate, productRunId, bindingsPath)),
      );
      expect(await readLines(memoryCallsPath)).toHaveLength(1);
      expect(await readLines(plannerCallsPath)).toHaveLength(1);
      expect(Object.keys(current.snapshot.entities.memoryQueries)).toHaveLength(1);
      expect(Object.keys(current.snapshot.entities.memoryResultSnapshots)).toHaveLength(1);
      expect(Object.keys(current.snapshot.entities.contextPackages)).toHaveLength(1);
      expect(Object.keys(current.snapshot.entities.memoryAdoptions)).toHaveLength(1);
      const contextPackage = Object.values(current.snapshot.entities.contextPackages)[0];
      expect(contextPackage).toBeDefined();
      const bindingsV1 = await RuntimeBindingStore.open(bindingsPath, { allowCreate: false });
      const workflowBindingV1 = bindingsV1.getWorkflowBinding(productRunId);
      expect(workflowBindingV1).toBeDefined();

      // API与Product Store继续存活；Workflow HTTP、Local World及其Node进程干净关闭。
      await runtimeProcess.stop();
      runtimeProcess = undefined;

      // 新Node进程使用同一Workflow数据目录和Binding文件，生产装配以recoverActiveRuns=true恢复。
      runtimeProcess = await startRuntimeProcess(runtimeOptions);
      dispatcher = new OutboxDispatcher({
        deps,
        workflowRuntimeBaseUrl: runtimeProcess.baseUrl,
        credential: CREDENTIAL,
      });
      expect(runtimeProcess.stdout()).toContain("Re-enqueued 1 active run(s) on startup");
      const recoveredBindings = await RuntimeBindingStore.open(bindingsPath, {
        allowCreate: false,
      });
      expect(recoveredBindings.getWorkflowBinding(productRunId)?.workflowRunId).toBe(
        workflowBindingV1?.workflowRunId,
      );

      const v1 = current.plans[0];
      const v1Approval = current.approvals.find((approval) => approval.status === "open");
      if (v1 === undefined || v1Approval === undefined) throw new Error("Plan v1审核事实缺失");
      await postJson(apiBaseUrl, `/api/runs/${productRunId}/decisions`, {
        commandId: nextCommandId(),
        expectedRevision: current.run?.revision,
        payload: {
          approvalRequestId: v1Approval.approvalRequestId,
          planId: v1.planId,
          planRevision: v1.planRevision,
          planSha256: v1.sha256,
          kind: "request_revision",
          revisionInstruction: "补充一次重启恢复验证，但保持同一Memory事实。",
        },
      });
      await dispatcher.tick();
      current = await waitForRun(
        deps,
        productRunId,
        "恢复后的Plan v2等待Hook",
        async (candidate) =>
          candidate.plans.length === 2 &&
          (await reviewCheckpointReady(candidate, productRunId, bindingsPath)),
      );

      expect(await readLines(memoryCallsPath)).toHaveLength(1);
      const plannerCalls = (await readLines(plannerCallsPath)).map(
        (line) => JSON.parse(line) as { planRevision: number; contextPackageRef: unknown },
      );
      expect(plannerCalls).toHaveLength(2);
      expect(plannerCalls[0]?.contextPackageRef).toEqual(plannerCalls[1]?.contextPackageRef);
      expect(Object.keys(current.snapshot.entities.memoryQueries)).toHaveLength(1);
      expect(Object.keys(current.snapshot.entities.memoryResultSnapshots)).toHaveLength(1);
      expect(Object.keys(current.snapshot.entities.contextPackages)).toHaveLength(1);
      expect(Object.keys(current.snapshot.entities.memoryAdoptions)).toHaveLength(1);
      expect(Object.values(current.snapshot.entities.contextPackages)[0]).toEqual(contextPackage);
      const planningAttempts = Object.values(current.snapshot.entities.attempts)
        .filter((attempt) => attempt.productRunId === productRunId && attempt.kind === "planning")
        .sort((left, right) => (left.planRevision ?? 0) - (right.planRevision ?? 0));
      expect(planningAttempts).toHaveLength(2);
      expect(
        planningAttempts.map((attempt) => ({
          contextPackageId: attempt.contextPackageId,
          contextPackageSha256: attempt.contextPackageSha256,
        })),
      ).toEqual([
        {
          contextPackageId: contextPackage?.contextPackageId,
          contextPackageSha256: contextPackage?.sha256,
        },
        {
          contextPackageId: contextPackage?.contextPackageId,
          contextPackageSha256: contextPackage?.sha256,
        },
      ]);
      const workflowRunFiles = (await readdir(join(workflowDataDir, "runs"))).filter((name) =>
        name.endsWith(".json"),
      );
      expect(workflowRunFiles).toHaveLength(1);

      const v2 = current.plans[1];
      const v2Approval = current.approvals.find((approval) => approval.status === "open");
      if (v2 === undefined || v2Approval === undefined) throw new Error("Plan v2审核事实缺失");
      await postJson(apiBaseUrl, `/api/runs/${productRunId}/decisions`, {
        commandId: nextCommandId(),
        expectedRevision: current.run?.revision,
        payload: {
          approvalRequestId: v2Approval.approvalRequestId,
          planId: v2.planId,
          planRevision: v2.planRevision,
          planSha256: v2.sha256,
          kind: "reject",
          reason: "恢复证明完成，结束测试运行。",
        },
      });
      await dispatcher.tick();
      current = await waitForRun(
        deps,
        productRunId,
        "拒绝后Workflow终止",
        (candidate) => candidate.run?.status === "cancelled",
      );
      expect(current.run?.phase).toBe("rejected");
      expect(await readLines(memoryCallsPath)).toHaveLength(1);
      expect([
        Object.keys(current.snapshot.entities.memoryQueries).length,
        Object.keys(current.snapshot.entities.memoryResultSnapshots).length,
        Object.keys(current.snapshot.entities.contextPackages).length,
        Object.keys(current.snapshot.entities.memoryAdoptions).length,
      ]).toEqual([1, 1, 1, 1]);
      const runOutbox = Object.values(current.snapshot.outbox).filter(
        (entry) => "productRunId" in entry && entry.productRunId === productRunId,
      );
      expect(runOutbox).toHaveLength(3);
      expect(runOutbox.every((entry) => entry.status === "acknowledged")).toBe(true);
    } catch (error) {
      throw new Error(
        `M1恢复场景失败 stdout=${runtimeProcess?.stdout().slice(-12_000) ?? ""} stderr=${runtimeProcess?.stderr().slice(-12_000) ?? ""}`,
        { cause: error },
      );
    } finally {
      const cleanupErrors: unknown[] = [];
      if (runtimeProcess !== undefined) {
        await runtimeProcess.stop().catch((error: unknown) => cleanupErrors.push(error));
      }
      await closeHttpServer(apiServer).catch((error: unknown) => cleanupErrors.push(error));
      await rm(root, { recursive: true, force: true }).catch((error: unknown) =>
        cleanupErrors.push(error),
      );
      if (cleanupErrors.length > 0)
        throw new AggregateError(cleanupErrors, "M1恢复测试资源清理失败");
    }
  }, 120_000);

  it("Project Intake与Advancement等待确认时重启API/Workflow，仍恢复同一候选且不重复调用模型", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-project-world-recovery-"));
    const productPath = join(root, "product.json");
    const projectRoot = join(root, "project-root");
    const workflowDataDir = join(root, "workflow-data");
    const bindingsPath = join(root, "bindings.json");
    const memoryCallsPath = join(root, "memory-calls.jsonl");
    const plannerCallsPath = join(root, "planner-calls.jsonl");
    const applicationIds = testIds();
    const applicationProjectIds = testProjectIds();
    let understandingCalls = 0;
    let advancementCalls = 0;
    let apiServer: HttpServer | undefined;
    let runtimeProcess: RuntimeProcessHandle | undefined;

    try {
      await mkdir(join(projectRoot, "docs"), { recursive: true });
      await writeFile(join(projectRoot, "AGENTS.md"), "# Project recovery rules\n", "utf8");
      await writeFile(
        join(projectRoot, "docs", "architecture.md"),
        "# Architecture\nProject recovery fixture.\n",
        "utf8",
      );
      await writeFile(
        join(projectRoot, "package.json"),
        JSON.stringify({ scripts: { build: "tsc", test: "vitest" } }),
        "utf8",
      );
      await exec("git", ["init", projectRoot]);
      await exec("git", ["-C", projectRoot, "config", "user.email", "recovery@example.test"]);
      await exec("git", ["-C", projectRoot, "config", "user.name", "Recovery Test"]);
      await exec("git", ["-C", projectRoot, "add", "."]);
      await exec("git", ["-C", projectRoot, "commit", "-m", "initial"]);

      const projectRoots = await createProjectResourceRegistry({
        CHAT_PROJECT_ROOTS_JSON: JSON.stringify([
          {
            rootId: "root_recovery",
            displayName: "恢复测试项目",
            canonicalPath: projectRoot,
            enabledAdapters: [
              "local-git-workspace.v1",
              "project-document-manifest.v1",
              "package-script-catalog.v1",
            ],
          },
        ]),
      });
      const projectIntakeUnderstanding: NonNullable<ApplicationDeps["projectIntakeUnderstanding"]> =
        {
          describe: () => ({
            profileVersion: "test.project-recovery.v1",
            providerName: "test-provider",
            modelId: "test-model",
            promptTemplateVersion: "project-intake-understanding.v1",
            endpointHost: "models.example.test",
          }),
          understand: async () => {
            understandingCalls += 1;
            return {
              understanding: {
                name: "恢复测试项目",
                goal: "证明建项在API与Workflow重启后仍能从同一审核事实继续",
                summary: "耐久建项恢复验证",
                scopeHints: ["观察真实Git和文档资源", "保存建项账本"],
                successCriteriaHints: ["重启后确认只创建一个Project"],
                initialWorkHints: ["验证耐久候选", "确认项目事实"],
                openQuestions: [],
              },
              evidence: { durationMs: 1, providerRequestId: "req-project-recovery" },
            };
          },
        };
      const projectAdvancementUnderstanding: NonNullable<
        ApplicationDeps["projectAdvancementUnderstanding"]
      > = {
        describe: () => ({
          profileVersion: "test.project-recovery.v1",
          providerName: "test-provider",
          modelId: "test-model",
          promptTemplateVersion: "project-advancement-understanding.v1",
          endpointHost: "models.example.test",
        }),
        understand: async () => {
          advancementCalls += 1;
          return {
            understanding: {
              stage: {
                name: "耐久推进验证",
                goal: "证明项目推进候选在API与Workflow重启后继续同一运行",
                successCriteria: ["只调用一次理解节点", "确认后发布项目更新"],
              },
              milestones: [
                {
                  outcome: "完成推进恢复闭环",
                  acceptanceCriteria: ["Stage、Milestone与Update原子提交"],
                },
              ],
              update: {
                health: "on_track" as const,
                narrative: "推进候选已经恢复并等待确认。",
                observedChanges: [],
                blockers: [],
                nextFocus: ["确认推进候选"],
              },
            },
            evidence: { durationMs: 1, providerRequestId: "req-advancement-recovery" },
          };
        },
      };
      const now = () => new Date().toISOString();
      const openDeps = async (): Promise<ApplicationDeps> => ({
        store: await JsonProductStore.open({ filePath: productPath, now }),
        now,
        ids: applicationIds,
        memoryBackends: createApplicationMemoryRegistry(),
        projectRoots,
        projectIntakeUnderstanding,
        projectAdvancementUnderstanding,
        projectIds: applicationProjectIds,
      });
      const openApi = async (deps: ApplicationDeps, port = 0) => {
        const app = createApiApp({
          traceSink: null,
          product: { deps, principalId: PRINCIPAL_ID as never },
          internalRuntime: { credential: CREDENTIAL },
        });
        return listen(app, port);
      };

      let deps = await openDeps();
      const firstApi = await openApi(deps);
      apiServer = firstApi.server;
      const apiPort = firstApi.port;
      const apiBaseUrl = `http://127.0.0.1:${String(apiPort)}`;
      const runtimeOptions: RuntimeProcessOptions = {
        repoRoot: root,
        bundleDir: BUNDLE_DIR,
        workflowDataDir,
        bindingsPath,
        apiBaseUrl,
        credential: CREDENTIAL,
        memoryCallsPath,
        plannerCallsPath,
      };
      runtimeProcess = await startRuntimeProcess(runtimeOptions);
      let dispatcher = new OutboxDispatcher({
        deps,
        workflowRuntimeBaseUrl: runtimeProcess.baseUrl,
        credential: CREDENTIAL,
      });

      const sessionResponse = (await postJson(apiBaseUrl, "/api/sessions", {
        commandId: nextCommandId(),
        payload: {},
      })) as { session: unknown };
      const session = sessionDtoSchema.parse(sessionResponse.session);
      const beginResponse = (await postJson(
        apiBaseUrl,
        "/api/project-intakes",
        {
          commandId: nextCommandId(),
          payload: {
            sessionId: session.sessionId,
            text: "把这个真实Git工作区建立为项目，并准备当前推进基线",
            rootId: "root_recovery",
          },
        },
        202,
      )) as { candidate: unknown };
      const queued = projectCandidateDtoSchema.parse(beginResponse.candidate);
      expect(queued).toMatchObject({ candidateKind: "intake", status: "queued", revision: 1 });

      await dispatcher.tick();
      const reviewing = await waitForProjectCandidate(
        apiBaseUrl,
        queued.projectCandidateId,
        "under_review",
      );
      if (reviewing.candidateKind !== "intake" || reviewing.status !== "under_review") {
        throw new Error("Project Intake候选未进入审核态");
      }
      expect(understandingCalls).toBe(1);
      const bindingsBefore = await RuntimeBindingStore.open(bindingsPath, { allowCreate: false });
      const bindingBefore = bindingsBefore.getProjectIntakeBinding(queued.projectCandidateId);
      expect(bindingBefore).toBeDefined();

      // 同时关闭两个服务。随后仅依赖JSON Product Store、Binding和Workflow数据目录恢复。
      await runtimeProcess.stop();
      runtimeProcess = undefined;
      await closeHttpServer(apiServer);
      apiServer = undefined;

      deps = await openDeps();
      const reopenedApi = await openApi(deps, apiPort);
      apiServer = reopenedApi.server;
      runtimeProcess = await startRuntimeProcess(runtimeOptions);
      dispatcher = new OutboxDispatcher({
        deps,
        workflowRuntimeBaseUrl: runtimeProcess.baseUrl,
        credential: CREDENTIAL,
      });
      expect(runtimeProcess.stdout()).toContain("Re-enqueued 1 active run(s) on startup");

      const recovered = await getProjectCandidateFromApi(apiBaseUrl, queued.projectCandidateId);
      expect(recovered).toMatchObject({
        candidateKind: "intake",
        status: "under_review",
        revision: reviewing.revision,
        candidateSha256: reviewing.candidateSha256,
      });
      expect(understandingCalls).toBe(1);
      const bindingsAfter = await RuntimeBindingStore.open(bindingsPath, { allowCreate: false });
      expect(bindingsAfter.getProjectIntakeBinding(queued.projectCandidateId)?.workflowRunId).toBe(
        bindingBefore?.workflowRunId,
      );

      const confirmResponse = (await postJson(
        apiBaseUrl,
        `/api/project-candidates/${queued.projectCandidateId}/decisions`,
        {
          commandId: nextCommandId(),
          expectedRevision: recovered.revision,
          payload: {
            kind: "confirm",
            candidateSha256:
              recovered.candidateKind === "intake" && recovered.status === "under_review"
                ? recovered.candidateSha256
                : "invalid",
          },
        },
      )) as { candidate: unknown };
      const confirmed = projectCandidateDtoSchema.parse(confirmResponse.candidate);
      expect(confirmed).toMatchObject({ candidateKind: "intake", status: "confirmed" });
      await dispatcher.tick();

      const finalBindings = await RuntimeBindingStore.open(bindingsPath, { allowCreate: false });
      const finalBinding = finalBindings.getProjectIntakeBinding(queued.projectCandidateId);
      expect(finalBinding?.workflowRunId).toBe(bindingBefore?.workflowRunId);
      expect(finalBinding?.resumeDispatchState).toBe("dispatched");
      const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
      expect(Object.keys(snapshot.entities.projects)).toHaveLength(1);
      expect(Object.keys(snapshot.entities.projectObservations)).toHaveLength(1);
      const projectOutbox = Object.values(snapshot.outbox).filter(
        (entry) =>
          "projectCandidateId" in entry && entry.projectCandidateId === queued.projectCandidateId,
      );
      expect(projectOutbox).toHaveLength(2);
      expect(projectOutbox.every((entry) => entry.status === "acknowledged")).toBe(true);
      const workflowRunFiles = (await readdir(join(workflowDataDir, "runs"))).filter((name) =>
        name.endsWith(".json"),
      );
      expect(workflowRunFiles).toHaveLength(1);
      expect(understandingCalls).toBe(1);

      const project = Object.values(snapshot.entities.projects)[0];
      if (project === undefined) throw new Error("Project Intake未创建Project");
      const advancementResponse = (await postJson(
        apiBaseUrl,
        "/api/project-advancements",
        {
          commandId: nextCommandId(),
          payload: {
            sessionId: session.sessionId,
            projectId: project.projectId,
            text: "推进到耐久恢复验证阶段，并记录当前进展",
          },
        },
        202,
      )) as { candidate: unknown };
      const advancementQueued = projectCandidateDtoSchema.parse(advancementResponse.candidate);
      expect(advancementQueued).toMatchObject({
        candidateKind: "advancement",
        status: "queued",
        revision: 1,
      });
      await dispatcher.tick();
      const advancementReviewing = await waitForProjectCandidate(
        apiBaseUrl,
        advancementQueued.projectCandidateId,
        "under_review",
      );
      if (
        advancementReviewing.candidateKind !== "advancement" ||
        advancementReviewing.status !== "under_review"
      ) {
        throw new Error("Project Advancement候选未进入审核态");
      }
      expect(advancementCalls).toBe(1);
      const advancementBindingBefore = (
        await RuntimeBindingStore.open(bindingsPath, { allowCreate: false })
      ).getProjectIntakeBinding(advancementQueued.projectCandidateId);
      expect(advancementBindingBefore).toBeDefined();

      await runtimeProcess.stop();
      runtimeProcess = undefined;
      await closeHttpServer(apiServer);
      apiServer = undefined;
      deps = await openDeps();
      const advancementReopenedApi = await openApi(deps, apiPort);
      apiServer = advancementReopenedApi.server;
      runtimeProcess = await startRuntimeProcess(runtimeOptions);
      dispatcher = new OutboxDispatcher({
        deps,
        workflowRuntimeBaseUrl: runtimeProcess.baseUrl,
        credential: CREDENTIAL,
      });
      const advancementRecovered = await getProjectCandidateFromApi(
        apiBaseUrl,
        advancementQueued.projectCandidateId,
      );
      expect(advancementRecovered).toMatchObject({
        candidateKind: "advancement",
        status: "under_review",
        revision: advancementReviewing.revision,
      });
      expect(advancementCalls).toBe(1);

      const advancementConfirmResponse = (await postJson(
        apiBaseUrl,
        `/api/project-advancements/${advancementQueued.projectCandidateId}/decisions`,
        {
          commandId: nextCommandId(),
          expectedRevision: advancementRecovered.revision,
          payload: {
            kind: "confirm",
            candidateSha256:
              advancementRecovered.candidateKind === "advancement" &&
              advancementRecovered.status === "under_review"
                ? advancementRecovered.candidateSha256
                : "invalid",
          },
        },
      )) as { candidate: unknown };
      expect(projectCandidateDtoSchema.parse(advancementConfirmResponse.candidate)).toMatchObject({
        candidateKind: "advancement",
        status: "confirmed",
      });
      await dispatcher.tick();
      const finalSnapshot = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
      expect(Object.values(finalSnapshot.entities.projectMilestones)).toHaveLength(1);
      expect(Object.values(finalSnapshot.entities.projectUpdates)).toHaveLength(1);
      expect(finalSnapshot.entities.projectStages[project.currentStageId]?.name).toBe(
        "耐久推进验证",
      );
      expect(
        (
          await RuntimeBindingStore.open(bindingsPath, { allowCreate: false })
        ).getProjectIntakeBinding(advancementQueued.projectCandidateId)?.workflowRunId,
      ).toBe(advancementBindingBefore?.workflowRunId);
      expect(advancementCalls).toBe(1);
      expect(
        (await readdir(join(workflowDataDir, "runs"))).filter((name) => name.endsWith(".json")),
      ).toHaveLength(2);
    } catch (error) {
      throw new Error(
        `Project Intake恢复场景失败 stdout=${runtimeProcess?.stdout().slice(-4_000) ?? ""} stderr=${runtimeProcess?.stderr().slice(-4_000) ?? ""}`,
        { cause: error },
      );
    } finally {
      const cleanupErrors: unknown[] = [];
      if (runtimeProcess !== undefined) {
        await runtimeProcess.stop().catch((error: unknown) => cleanupErrors.push(error));
      }
      await closeHttpServer(apiServer).catch((error: unknown) => cleanupErrors.push(error));
      await rm(root, { recursive: true, force: true }).catch((error: unknown) =>
        cleanupErrors.push(error),
      );
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "Project Intake恢复测试资源清理失败");
      }
    }
  }, 120_000);
});

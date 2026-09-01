import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const nitroCli = path.join(projectRoot, "node_modules", "nitro", "dist", "cli", "index.mjs");

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function stopProcess(process) {
  if (process === undefined || process.exitCode !== null) return;
  process.kill("SIGINT");
  await Promise.race([
    new Promise((resolve) => process.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (process.exitCode === null) process.kill("SIGKILL");
}

test("Nitro dev executes Frontend's Run contract through Workflow, Pi SDK, and a local model", {
  timeout: 45_000,
}, async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chat-dev-server-"));
  const buildDir = fs.mkdtempSync(path.join(projectRoot, "node_modules", ".nitro-dev-test-"));
  const chatHome = path.join(runtimeRoot, "chat-home");
  const workspace = path.join(runtimeRoot, "workspace");
  const agentDir = path.join(chatHome, "agent");
  let modelServer;
  let devServer;
  let output = "";
  const modelRequests = [];

  try {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(path.join(workspace, ".chat"), { recursive: true });
    const canonicalWorkspace = fs.realpathSync(workspace);
    fs.writeFileSync(path.join(workspace, ".chat", "project.json"), JSON.stringify({
      schemaVersion: 1,
      id: "dev-e2e-project",
      name: "Dev E2E Project",
    }));

    modelServer = http.createServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      const modelRequest = await readJson(request);
      modelRequests.push(modelRequest);
      const responseText = modelRequests.length === 1
        ? "PLAN_V1"
        : modelRequests.length === 2
          ? "PLAN_V2"
          : "DEV_E2E_OK";
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl-dev-e2e",
        object: "chat.completion.chunk",
        created: 0,
        model: "dev-e2e-model",
        choices: [{
          index: 0,
          delta: { role: "assistant", content: responseText },
          finish_reason: null,
        }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl-dev-e2e",
        object: "chat.completion.chunk",
        created: 0,
        model: "dev-e2e-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    await new Promise((resolve, reject) => {
      modelServer.once("error", reject);
      modelServer.listen(0, "127.0.0.1", resolve);
    });
    const modelAddress = modelServer.address();
    assert.equal(typeof modelAddress, "object");
    const modelBaseUrl = `http://127.0.0.1:${modelAddress.port}/v1`;
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: "dev-e2e",
      defaultModel: "dev-e2e-model",
      defaultThinkingLevel: "off",
    }));
    fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
      providers: {
        "dev-e2e": {
          baseUrl: modelBaseUrl,
          api: "openai-completions",
          apiKey: "dev-e2e-key",
          models: [{
            id: "dev-e2e-model",
            name: "Dev E2E Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 8_192,
          }],
        },
      },
    }));

    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    devServer = spawn(process.execPath, [nitroCli, "dev", "--host", "127.0.0.1", "--port", String(port)], {
      cwd: projectRoot,
      env: {
        ...process.env,
        CHAT_HOME: chatHome,
        CHAT_NITRO_BUILD_DIR: buildDir,
        WORKFLOW_TARGET_WORLD: "local",
        WORKFLOW_LOCAL_DATA_DIR: path.join(chatHome, "runtime", "workflow-data"),
        CHAT_WEB_AUTH_ENABLED: "1",
        CHAT_WEB_AUTH_USERNAME: "later",
        CHAT_WEB_AUTH_PASSWORD: "123456",
        CHAT_WEB_AUTH_SESSION_SECRET: "dev-server-test-session-secret-at-least-32-characters",
        CHAT_PUBLIC_URL: "https://chat.ai4child.asia",
        MEM0_TELEMETRY: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (chunk) => { output += chunk.toString(); };
    devServer.stdout.on("data", collect);
    devServer.stderr.on("data", collect);

    const startupDeadline = Date.now() + 20_000;
    let healthy = false;
    while (Date.now() < startupDeadline && devServer.exitCode === null) {
      try {
        healthy = (await fetch(`${baseUrl}/api/health`)).ok;
        if (healthy) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(healthy, true, output);

    const login = await fetch(`${baseUrl}/api/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
      body: JSON.stringify({ username: "later", password: "123456", persistent: true }),
    });
    assert.equal(login.status, 200, await login.text());
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const authenticatedFetch = (pathname, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Cookie", cookie);
      return fetch(`${baseUrl}${pathname}`, { ...init, headers });
    };

    const opened = await authenticatedFetch("/api/projects/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: canonicalWorkspace }),
    });
    assert.equal(opened.status, 200, await opened.text());

    const start = await authenticatedFetch("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "dev-e2e-project",
        cwd: canonicalWorkspace,
        prompt: "Reply with the deterministic marker after an approved plan.",
        workflow: "planning-execution",
      }),
    });
    const started = await start.json();
    assert.equal(start.status, 202, JSON.stringify(started));

    const statusPath = () => {
      const query = new URLSearchParams({
        projectId: "dev-e2e-project",
        workflowInvocationId: started.workflowInvocationId,
      });
      return `/runs/${encodeURIComponent(started.runId)}?${query.toString()}`;
    };
    const waitForReview = async (revision) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const response = await authenticatedFetch(statusPath());
        const status = await response.json();
        assert.equal(response.status, 200, JSON.stringify(status));
        if (status.status === "failed" || status.status === "cancelled") {
          assert.fail(`${JSON.stringify(status)}\n${output}`);
        }
        if (status.phase === "waiting_review" && status.review?.planRevision === revision) {
          return status.review;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail(`plan revision ${revision} did not reach review\n${output}`);
    };
    const submitReview = async (review, decision) => {
      const response = await authenticatedFetch(`/runs/${encodeURIComponent(started.runId)}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "dev-e2e-project",
          decision: {
            ...decision,
            reviewId: review.reviewId,
            workflowInvocationId: review.workflowInvocationId,
            planRevision: review.planRevision,
            planSha256: review.planSha256,
          },
        }),
      });
      assert.equal(response.status, 202, await response.text());
    };

    const firstReview = await waitForReview(1);
    assert.equal(firstReview.plan, "PLAN_V1");
    const overlappingRun = await authenticatedFetch("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "dev-e2e-project",
        cwd: canonicalWorkspace,
        sessionId: firstReview.sessionId,
        prompt: "This overlapping turn must be rejected while review is pending.",
        workflow: "minimal-pi-coding-agent",
      }),
    });
    assert.equal(overlappingRun.status, 400);
    assert.match(await overlappingRun.text(), /等待计划v1审核/);
    assert.equal(modelRequests.length, 1);
    await submitReview(firstReview, {
      kind: "request_revision",
      feedback: "Add an explicit rollback step before execution.",
    });
    const secondReview = await waitForReview(2);
    assert.equal(secondReview.plan, "PLAN_V2");
    await submitReview(secondReview, { kind: "approve" });

    const runDeadline = Date.now() + 15_000;
    let status;
    while (Date.now() < runDeadline) {
      const response = await authenticatedFetch(statusPath());
      status = await response.json();
      assert.equal(response.status, 200, JSON.stringify(status));
      if (["completed", "failed", "cancelled"].includes(status.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.equal(status?.status, "completed", `${JSON.stringify(status)}\n${output}`);
    assert.equal(status.result.text, "DEV_E2E_OK");
    assert.equal(modelRequests.length, 3);
    assert.match(JSON.stringify(modelRequests[1]), /Add an explicit rollback step before execution\./);
    assert.match(JSON.stringify(modelRequests[1]), /PLAN_V1/);
    assert.match(JSON.stringify(modelRequests[2]), /PLAN_V2/);
    // Executor receives the same linear Session, so the rejected plan remains
    // historical Agent speech. Its final internal handoff must select PLAN_V2.
    assert.match(JSON.stringify(modelRequests[2]), /PLAN_V1/);
    const executorHandoff = modelRequests[2].messages.at(-1);
    assert.equal(executorHandoff.role, "user");
    assert.match(JSON.stringify(executorHandoff), /PLAN_V2/);
    assert.doesNotMatch(JSON.stringify(executorHandoff), /PLAN_V1/);
    assert.match(output, /\[workflow\] accepted/);
    assert.match(output, /\[planner\] revision=1/);
    assert.match(output, /\[planner\] revision=2/);
    assert.match(output, /\[pi\] planning execution step starting/);
    assert.match(output, /\[pi\] model=dev-e2e\/dev-e2e-model/);
    assert.doesNotMatch(
      output,
      /ERR_IMPORT_ATTRIBUTE_MISSING|找不到.*Skill资源|\[Workflow\] Error/,
    );

    const cancelStartResponse = await authenticatedFetch("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "dev-e2e-project",
        cwd: canonicalWorkspace,
        sessionId: status.result.sessionId,
        prompt: "Create a plan that will be cancelled during review.",
        workflow: "planning-execution",
      }),
    });
    const cancelStarted = await cancelStartResponse.json();
    assert.equal(cancelStartResponse.status, 202, JSON.stringify(cancelStarted));
    const planningOverlap = await authenticatedFetch("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "dev-e2e-project",
        cwd: canonicalWorkspace,
        sessionId: status.result.sessionId,
        prompt: "This turn must be rejected while the planning Run is still active.",
        workflow: "minimal-pi-coding-agent",
      }),
    });
    assert.equal(planningOverlap.status, 400);
    assert.match(await planningOverlap.text(), /Session已有规划执行Workflow/);
    const cancelQuery = new URLSearchParams({
      projectId: "dev-e2e-project",
      workflowInvocationId: cancelStarted.workflowInvocationId,
    });
    const cancelStatusPath = `/runs/${encodeURIComponent(cancelStarted.runId)}?${cancelQuery.toString()}`;
    const cancelReviewDeadline = Date.now() + 15_000;
    let cancelReviewStatus;
    while (Date.now() < cancelReviewDeadline) {
      const response = await authenticatedFetch(cancelStatusPath);
      cancelReviewStatus = await response.json();
      if (cancelReviewStatus.phase === "waiting_review") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(cancelReviewStatus?.phase, "waiting_review", `${JSON.stringify(cancelReviewStatus)}\n${output}`);
    assert.equal(modelRequests.length, 4);

    const cancelledResponse = await authenticatedFetch(cancelStatusPath, { method: "DELETE" });
    assert.equal(cancelledResponse.status, 200, await cancelledResponse.text());
    const cancelledDeadline = Date.now() + 5_000;
    let cancelled;
    while (Date.now() < cancelledDeadline) {
      const response = await authenticatedFetch(cancelStatusPath);
      cancelled = await response.json();
      if (cancelled.status === "cancelled") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(cancelled?.status, "cancelled", JSON.stringify(cancelled));
    assert.equal(modelRequests.length, 4, "cancelling during review must not call the executor");

    const continuedResponse = await authenticatedFetch("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "dev-e2e-project",
        cwd: canonicalWorkspace,
        sessionId: status.result.sessionId,
        prompt: "Continue this same Session after cancelling the reviewed plan.",
        workflow: "minimal-pi-coding-agent",
      }),
    });
    const continuedStarted = await continuedResponse.json();
    assert.equal(continuedResponse.status, 202, JSON.stringify(continuedStarted));
    const continueDeadline = Date.now() + 10_000;
    let continued;
    while (Date.now() < continueDeadline) {
      const response = await authenticatedFetch(`/runs/${encodeURIComponent(continuedStarted.runId)}`);
      continued = await response.json();
      if (["completed", "failed", "cancelled"].includes(continued.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(continued?.status, "completed", `${JSON.stringify(continued)}\n${output}`);
    assert.equal(continued.result.sessionId, status.result.sessionId);
    assert.equal(modelRequests.length, 5);
  } finally {
    await stopProcess(devServer);
    if (modelServer?.listening) {
      await new Promise((resolve) => modelServer.close(resolve));
    }
    fs.rmSync(buildDir, { recursive: true, force: true });
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

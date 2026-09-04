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

function writeToolCalls(response, completionId, toolCalls) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({
    id: completionId,
    object: "chat.completion.chunk",
    created: 0,
    model: "dev-e2e-model",
    choices: [{
      index: 0,
      delta: { role: "assistant", tool_calls: toolCalls },
      finish_reason: null,
    }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: completionId,
    object: "chat.completion.chunk",
    created: 0,
    model: "dev-e2e-model",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function childAgentCapabilities(agentId, tools = [], skills = []) {
  return [{ agentId, tools, skills }];
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

async function crashProcess(process) {
  if (process === undefined || process.exitCode !== null) return;
  process.kill("SIGKILL");
  await new Promise((resolve) => process.once("exit", resolve));
}

test("Nitro dev executes Frontend's Run contract through Workflow, Pi SDK, and a local model", {
  timeout: 90_000,
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
  let restartGeneration = 0;
  let releaseRestartModelRequest;
  let markRestartReady;
  const restartReady = new Promise((resolve) => { markRestartReady = resolve; });
  let releaseUiCancelParent;
  let markUiCancelParentReady;
  const uiCancelParentReady = new Promise((resolve) => { markUiCancelParentReady = resolve; });

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
      const systemText = modelRequest.messages
        .filter((message) => message.role === "system")
        .map((message) => JSON.stringify(message.content))
        .join("\n");
      const latestMessageText = JSON.stringify(modelRequest.messages.at(-1)?.content ?? "");
      const conversationText = JSON.stringify(modelRequest.messages);
      const hasToolResult = modelRequest.messages.some((message) => message.role === "tool");
      const currentCallId = latestMessageText.match(/callId=([^\\s"\\]+)/)?.[1];
      const latestToolText = JSON.stringify(
        [...modelRequest.messages].reverse().find((message) => message.role === "tool")?.content ?? "",
      );
      const latestToolCallId = latestToolText.match(/callId=([^\\s"\\]+)/)?.[1];
      let responseText;
      if (systemText.includes("Planner Orchestrator Workflow中的Coordinator")
        && !modelRequest.messages.some((message) => message.role === "tool")) {
        const toolCalls = Array.from({ length: 5 }, (_, index) => ({
          index,
          id: `orchestration-call-${String(index + 1)}`,
          type: "function",
          function: {
            name: "workflow_call",
            arguments: JSON.stringify({
              action: "start",
              workflowId: "minimal-pi-coding-agent",
              prompt: `ORCH_CHILD_${String(index + 1)}: Execute approved independent package ${String(index + 1)} and return its marker.`,
              agents: childAgentCapabilities("pi-coding-agent"),
            }),
          },
        }));
        writeToolCalls(response, "chatcmpl-dev-orchestration", toolCalls);
        return;
      }
      if (latestMessageText.includes("DIRECT_CALL_MEMORY") && !hasToolResult) {
        writeToolCalls(response, "chatcmpl-dev-direct-memory", [{
          index: 0,
          id: "direct-memory-call",
          type: "function",
          function: {
            name: "workflow_call",
            arguments: JSON.stringify({
              action: "start",
              workflowId: "memory",
              prompt: "DIRECT_MEMORY_CHILD: Confirm that the Memory Workflow received this delegated request without changing memory.",
              agents: childAgentCapabilities("memory-agent"),
            }),
          },
        }]);
        return;
      }
      if (latestMessageText.includes("DIRECT_CALL_REVIEW") && !hasToolResult) {
        writeToolCalls(response, "chatcmpl-dev-direct-review", [{
          index: 0,
          id: "direct-review-call",
          type: "function",
          function: {
            name: "workflow_call",
            arguments: JSON.stringify({
              action: "start",
              workflowId: "planning-execution",
              prompt: "CHILD_REVIEW_PLAN: Plan and execute this delegated package after the user approves it.",
              agents: [
                ...childAgentCapabilities("planner"),
                ...childAgentCapabilities("pi-coding-agent"),
              ],
              waitTimeoutMs: 30_000,
            }),
          },
        }]);
        return;
      }
      if (latestMessageText.includes("DIRECT_CALL_SELF") && !hasToolResult) {
        writeToolCalls(response, "chatcmpl-dev-direct-self", [{
          index: 0,
          id: "direct-self-call",
          type: "function",
          function: {
            name: "workflow_call",
            arguments: JSON.stringify({
              action: "start",
              workflowId: "minimal-pi-coding-agent",
              prompt: "DIRECT_SELF_CHILD: Complete one bounded child task and return its marker without further delegation.",
              agents: childAgentCapabilities("pi-coding-agent"),
            }),
          },
        }]);
        return;
      }
      if (latestMessageText.includes("DIRECT_CALL_WAIT") && !hasToolResult) {
        writeToolCalls(response, "chatcmpl-dev-direct-wait-start", [{
          index: 0,
          id: "direct-wait-start",
          type: "function",
          function: {
            name: "workflow_call",
            arguments: JSON.stringify({
              action: "start",
              workflowId: "minimal-pi-coding-agent",
              prompt: "DIRECT_WAIT_CHILD: Complete this delayed child task without further delegation.",
              agents: childAgentCapabilities("pi-coding-agent"),
              waitTimeoutMs: 0,
            }),
          },
        }]);
        return;
      }
      if (conversationText.includes("DIRECT_CALL_WAIT")
        && latestMessageText.includes("is still running") && currentCallId !== undefined) {
        writeToolCalls(response, "chatcmpl-dev-direct-wait-resume", [{
          index: 0,
          id: "direct-wait-resume",
          type: "function",
          function: {
            name: "workflow_call",
            arguments: JSON.stringify({
              action: "wait",
              callId: currentCallId,
              waitTimeoutMs: 5_000,
            }),
          },
        }]);
        return;
      }
      if (latestMessageText.includes("DIRECT_CALL_CANCEL") && !hasToolResult) {
        writeToolCalls(response, "chatcmpl-dev-direct-cancel-start", [{
          index: 0,
          id: "direct-cancel-start",
          type: "function",
          function: {
            name: "workflow_call",
            arguments: JSON.stringify({
              action: "start",
              workflowId: "minimal-pi-coding-agent",
              prompt: "DIRECT_CANCEL_CHILD: Keep this child busy until its parent cancels it.",
              agents: childAgentCapabilities("pi-coding-agent"),
              waitTimeoutMs: 0,
            }),
          },
        }]);
        return;
      }
      if (latestMessageText.includes("DIRECT_CALL_UI_CANCEL") && !hasToolResult) {
        writeToolCalls(response, "chatcmpl-dev-direct-ui-cancel-start", [{
          index: 0,
          id: "direct-ui-cancel-start",
          type: "function",
          function: {
            name: "workflow_call",
            arguments: JSON.stringify({
              action: "start",
              workflowId: "minimal-pi-coding-agent",
              prompt: "DIRECT_UI_CANCEL_CHILD: Stay busy until the user stops this call from the control API.",
              agents: childAgentCapabilities("pi-coding-agent"),
              waitTimeoutMs: 0,
            }),
          },
        }]);
        return;
      }
      if (conversationText.includes("DIRECT_CALL_CANCEL")
        && latestMessageText.includes("is still running") && currentCallId !== undefined) {
        writeToolCalls(response, "chatcmpl-dev-direct-cancel-stop", [{
          index: 0,
          id: "direct-cancel-stop",
          type: "function",
          function: {
            name: "workflow_call",
            arguments: JSON.stringify({ action: "cancel", callId: currentCallId }),
          },
        }]);
        return;
      }
      if (latestMessageText.includes("DIRECT_CALL_RESTART") && !hasToolResult) {
        writeToolCalls(response, "chatcmpl-dev-direct-restart-start", [{
          index: 0,
          id: "direct-restart-start",
          type: "function",
          function: {
            name: "workflow_call",
            arguments: JSON.stringify({
              action: "start",
              workflowId: "minimal-pi-coding-agent",
              prompt: "DIRECT_RESTART_CHILD: Complete after the Backend restarts.",
              agents: childAgentCapabilities("pi-coding-agent"),
              waitTimeoutMs: 0,
            }),
          },
        }]);
        return;
      }
      if (conversationText.includes("DIRECT_CALL_RESTART")
        && latestToolText.includes("is still running") && latestToolCallId !== undefined) {
        if (restartGeneration === 0) {
          markRestartReady?.();
          await new Promise((resolve) => { releaseRestartModelRequest = resolve; });
          if (response.destroyed) return;
        }
        writeToolCalls(response, "chatcmpl-dev-direct-restart-wait", [{
          index: 0,
          id: "direct-restart-wait",
          type: "function",
          function: {
            name: "workflow_call",
            arguments: JSON.stringify({
              action: "wait",
              callId: latestToolCallId,
              waitTimeoutMs: 5_000,
            }),
          },
        }]);
        return;
      }
      if (conversationText.includes("DIRECT_CALL_UI_CANCEL") && hasToolResult) {
        markUiCancelParentReady?.();
        await new Promise((resolve) => { releaseUiCancelParent = resolve; });
        if (response.destroyed) return;
        responseText = "DIRECT_UI_CANCEL_PARENT_OK";
      } else if (systemText.includes("Planner Orchestrator Workflow中的Coordinator")) {
        responseText = "ORCHESTRATION_5_OK";
      } else if (systemText.includes("你是Chat的Memory Agent")
        && latestMessageText.includes("DIRECT_MEMORY_CHILD")) {
        responseText = "DIRECT_MEMORY_CHILD_OK";
      } else if (conversationText.includes("DIRECT_CALL_MEMORY") && hasToolResult) {
        responseText = "DIRECT_MEMORY_PARENT_OK";
      } else if (conversationText.includes("DIRECT_CALL_REVIEW") && hasToolResult) {
        responseText = "DIRECT_REVIEW_PARENT_OK";
      } else if (conversationText.includes("DIRECT_CALL_SELF") && hasToolResult) {
        responseText = "DIRECT_SELF_PARENT_OK";
      } else if (conversationText.includes("DIRECT_CALL_WAIT") && hasToolResult) {
        responseText = "DIRECT_WAIT_PARENT_OK";
      } else if (conversationText.includes("DIRECT_CALL_CANCEL") && hasToolResult) {
        responseText = "DIRECT_CANCEL_PARENT_OK";
      } else if (conversationText.includes("DIRECT_CALL_RESTART") && hasToolResult) {
        responseText = "DIRECT_RESTART_PARENT_OK";
      } else if (latestMessageText.includes("DIRECT_SELF_CHILD")) {
        responseText = "DIRECT_SELF_CHILD_OK";
      } else if (latestMessageText.includes("DIRECT_WAIT_CHILD")) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        responseText = "DIRECT_WAIT_CHILD_OK";
      } else if (latestMessageText.includes("DIRECT_CANCEL_CHILD")) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        responseText = "DIRECT_CANCEL_CHILD_SHOULD_NOT_COMPLETE";
      } else if (latestMessageText.includes("DIRECT_UI_CANCEL_CHILD")) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        responseText = "DIRECT_UI_CANCEL_CHILD_SHOULD_NOT_COMPLETE";
      } else if (latestMessageText.includes("DIRECT_RESTART_CHILD")) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        responseText = "DIRECT_RESTART_CHILD_OK";
      } else if (latestMessageText.includes("workflow_execution_task_brief")
        && latestMessageText.includes("CHILD_REVIEW_PLAN")) {
        responseText = "CHILD_REVIEW_EXECUTED";
      } else if (systemText.includes("你是Planning Execution Workflow中的Planner Agent")) {
        if (latestMessageText.includes("CHILD_REVIEW_PLAN")) {
          responseText = '<!-- chat-planner-output {"schemaVersion":1,"readiness":"ready_for_review","blockingQuestions":[]} -->\nCHILD_REVIEW_PLAN_READY';
        } else if (latestMessageText.includes("ORCHESTRATE_FIVE")) {
          responseText = '<!-- chat-planner-output {"schemaVersion":1,"readiness":"ready_for_review","blockingQuestions":[]} -->\n# Five work packages\n1. ORCH_CHILD_1\n2. ORCH_CHILD_2\n3. ORCH_CHILD_3\n4. ORCH_CHILD_4\n5. ORCH_CHILD_5\n\nAll five packages are independent and target minimal-pi-coding-agent.';
        } else
        if (latestMessageText.includes("Add an explicit rollback step before execution.")) {
          responseText = '<!-- chat-planner-output {"schemaVersion":1,"readiness":"ready_for_review","blockingQuestions":[]} -->\nPLAN_V2';
        } else if (latestMessageText.includes("Create a plan that will be cancelled during review.")) {
          responseText = '<!-- chat-planner-output {"schemaVersion":1,"readiness":"ready_for_review","blockingQuestions":[]} -->\nCANCEL_PLAN';
        } else {
          responseText = '<!-- chat-planner-output {"schemaVersion":1,"readiness":"needs_clarification","blockingQuestions":["Should the execution include an explicit rollback step?"]} -->\nPLAN_V1';
        }
      } else if (latestMessageText.includes("ORCH_CHILD_")) {
        const marker = latestMessageText.match(/ORCH_CHILD_\d+/)?.[0] ?? "ORCH_CHILD_UNKNOWN";
        responseText = `${marker}_OK`;
      } else {
        responseText = latestMessageText.includes("workflow_execution_task_brief")
          ? "DEV_E2E_OK"
          : "DEV_CONTINUED_OK";
      }
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
    const collect = (chunk) => { output += chunk.toString(); };
    const startDevServer = () => {
      const child = spawn(process.execPath, [nitroCli, "dev", "--host", "127.0.0.1", "--port", String(port)], {
        cwd: projectRoot,
        env: {
          ...process.env,
          CHAT_HOME: chatHome,
          CHAT_NITRO_BUILD_DIR: buildDir,
          WORKFLOW_TARGET_WORLD: "local",
          WORKFLOW_LOCAL_DATA_DIR: path.join(chatHome, "runtime", "workflow-data"),
          // Nitro dev进程同时监听内部watcher端口；Queue自动探测可能选中错误端口导致消息悬挂，
          // 必须显式指向本测试保留的HTTP端口。
          WORKFLOW_LOCAL_BASE_URL: baseUrl,
          CHAT_WEB_AUTH_ENABLED: "1",
          CHAT_WEB_AUTH_USERNAME: "later",
          CHAT_WEB_AUTH_PASSWORD: "123456",
          CHAT_WEB_AUTH_SESSION_SECRET: "dev-server-test-session-secret-at-least-32-characters",
          CHAT_PUBLIC_URL: "https://chat.ai4child.asia",
          MEM0_TELEMETRY: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      return child;
    };
    const waitForDevServer = async (child) => {
      const startupDeadline = Date.now() + 20_000;
      while (Date.now() < startupDeadline && child.exitCode === null) {
        try {
          if ((await fetch(`${baseUrl}/api/health`)).ok) return true;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    };
    devServer = startDevServer();
    assert.equal(await waitForDevServer(devServer), true, output);

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
    assert.equal(typeof started.sessionId, "string");
    assert.equal(started.isNewSession, true);
    const acceptedSessionsResponse = await authenticatedFetch("/api/sessions?projectId=dev-e2e-project");
    const acceptedSessions = await acceptedSessionsResponse.json();
    assert.equal(acceptedSessionsResponse.status, 200, JSON.stringify(acceptedSessions));
    assert.ok(acceptedSessions.sessions.some((session) => session.id === started.sessionId));

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
    assert.equal(firstReview.sessionId, started.sessionId);
    assert.equal(firstReview.plan, "PLAN_V1");
    assert.equal(firstReview.readiness, "needs_clarification");
    assert.deepEqual(firstReview.blockingQuestions, ["Should the execution include an explicit rollback step?"]);
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
    const blockedApproval = await authenticatedFetch(`/runs/${encodeURIComponent(started.runId)}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "dev-e2e-project",
        decision: {
          kind: "approve",
          reviewId: firstReview.reviewId,
          workflowInvocationId: firstReview.workflowInvocationId,
          planRevision: firstReview.planRevision,
          planSha256: firstReview.planSha256,
        },
      }),
    });
    assert.equal(blockedApproval.status, 409);
    assert.match(await blockedApproval.text(), /不能批准执行/);
    await submitReview(firstReview, {
      kind: "request_revision",
      feedback: "Add an explicit rollback step before execution.",
    });
    const secondReview = await waitForReview(2);
    assert.equal(secondReview.plan, "PLAN_V2");
    assert.equal(secondReview.readiness, "ready_for_review");
    assert.deepEqual(secondReview.blockingQuestions, []);
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
    assert.match(JSON.stringify(modelRequests[2]), /已通过执行计划 v2，开始执行。/);
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
    assert.equal(cancelStarted.sessionId, status.result.sessionId);
    assert.equal(cancelStarted.isNewSession, false);
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
    assert.match(await planningOverlap.text(), /Session已有planning-execution Workflow/);
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
    assert.equal(continuedStarted.sessionId, status.result.sessionId);
    assert.equal(continuedStarted.isNewSession, false);
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

    const directMemoryStartResponse = await authenticatedFetch("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "dev-e2e-project",
        cwd: canonicalWorkspace,
        prompt: "DIRECT_CALL_MEMORY: Delegate a no-write confirmation request to the Memory Workflow.",
        workflow: "minimal-pi-coding-agent",
      }),
    });
    const directMemoryStarted = await directMemoryStartResponse.json();
    assert.equal(directMemoryStartResponse.status, 202, JSON.stringify(directMemoryStarted));
    const directMemoryDeadline = Date.now() + 15_000;
    let directMemoryStatus;
    while (Date.now() < directMemoryDeadline) {
      const response = await authenticatedFetch(`/runs/${encodeURIComponent(directMemoryStarted.runId)}`);
      directMemoryStatus = await response.json();
      assert.equal(response.status, 200, JSON.stringify(directMemoryStatus));
      if (["completed", "failed", "cancelled"].includes(directMemoryStatus.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(
      directMemoryStatus?.status,
      "completed",
      `${JSON.stringify(directMemoryStatus)}\n${output}`,
    );
    assert.equal(directMemoryStatus.result.text, "DIRECT_MEMORY_PARENT_OK");

    const directMemoryParentResponse = await authenticatedFetch(
      `/api/sessions/${encodeURIComponent(directMemoryStarted.sessionId)}?projectId=dev-e2e-project`,
    );
    const directMemoryParent = await directMemoryParentResponse.json();
    assert.equal(directMemoryParentResponse.status, 200, JSON.stringify(directMemoryParent));
    assert.equal(directMemoryParent.workflowCalls.length, 1);
    assert.equal(directMemoryParent.workflowCalls[0].child.workflowId, "memory");
    assert.equal(directMemoryParent.workflowCalls[0].status, "completed");
    assert.equal(typeof directMemoryParent.workflowCalls[0].durationMs, "number");
    const directMemoryChildResponse = await authenticatedFetch(
      `/api/sessions/${encodeURIComponent(directMemoryParent.workflowCalls[0].child.sessionId)}?projectId=dev-e2e-project`,
    );
    const directMemoryChild = await directMemoryChildResponse.json();
    assert.equal(directMemoryChildResponse.status, 200, JSON.stringify(directMemoryChild));
    const delegatedMemoryTask = directMemoryChild.context.messages.find((message) => (
      message.role === "user" && JSON.stringify(message.content).includes("DIRECT_MEMORY_CHILD")
    ));
    assert.ok(delegatedMemoryTask, JSON.stringify(directMemoryChild.context.messages));
    assert.deepEqual(delegatedMemoryTask.chatWorkflow, {
      invocationId: directMemoryStarted.workflowInvocationId,
      workflowId: "minimal-pi-coding-agent",
      stageId: "execute",
      agentId: "pi-coding-agent",
    });
    assert.deepEqual(
      directMemoryChild.workflowTurnConfigurations[0].agentConfigs["memory-agent"],
      {
        tools: { mode: "none" },
        resources: { mode: "explicit", skillPaths: [], extensionPaths: [], pluginSources: [] },
      },
    );
    const directMemoryInitialRequest = modelRequests.find((request) => (
      JSON.stringify(request.messages.at(-1)?.content ?? "").includes("DIRECT_CALL_MEMORY")
      && !request.messages.some((message) => message.role === "tool")
    ));
    assert.ok(directMemoryInitialRequest);
    const directWorkflowCallDefinition = directMemoryInitialRequest.tools.find((tool) => (
      tool.function?.name === "workflow_call"
    ));
    assert.ok(directWorkflowCallDefinition);
    assert.match(JSON.stringify(directWorkflowCallDefinition), /memory/);
    assert.match(JSON.stringify(directWorkflowCallDefinition), /长期记忆/);
    assert.match(JSON.stringify(directWorkflowCallDefinition), /minimal-pi-coding-agent/);
    assert.match(JSON.stringify(directWorkflowCallDefinition), /planning-execution/);
    assert.match(JSON.stringify(directWorkflowCallDefinition), /planner-orchestrator/);
    assert.equal(modelRequests.some((request) => (
      JSON.stringify(request.messages.filter((message) => message.role === "system"))
        .includes("你是Chat的Memory Agent")
      && JSON.stringify(request.messages.at(-1)?.content ?? "").includes("DIRECT_MEMORY_CHILD")
    )), true);
    const directMemoryChildRequest = modelRequests.find((request) => (
      JSON.stringify(request.messages.filter((message) => message.role === "system"))
        .includes("你是Chat的Memory Agent")
      && JSON.stringify(request.messages.at(-1)?.content ?? "").includes("DIRECT_MEMORY_CHILD")
    ));
    assert.deepEqual(directMemoryChildRequest?.tools ?? [], []);
    assert.doesNotMatch(JSON.stringify(directMemoryChildRequest?.messages ?? []), /<skill name=\\?"memory/);

    const directReviewStartResponse = await authenticatedFetch("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "dev-e2e-project",
        cwd: canonicalWorkspace,
        prompt: "DIRECT_CALL_REVIEW: Delegate a package to a reviewed child Workflow.",
        workflow: "minimal-pi-coding-agent",
      }),
    });
    const directReviewStarted = await directReviewStartResponse.json();
    assert.equal(directReviewStartResponse.status, 202, JSON.stringify(directReviewStarted));

    const childReviewDeadline = Date.now() + 15_000;
    let childReviewSession;
    let childReviewSessionsPage;
    while (Date.now() < childReviewDeadline) {
      const response = await authenticatedFetch("/api/sessions?projectId=dev-e2e-project");
      childReviewSessionsPage = await response.json();
      assert.equal(response.status, 200, JSON.stringify(childReviewSessionsPage));
      childReviewSession = childReviewSessionsPage.sessions.find((session) => (
        session.parentSessionId === directReviewStarted.sessionId
        && session.attention?.kind === "review"
      ));
      if (childReviewSession !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(childReviewSession, `reviewed Child Session was not discoverable\n${output}`);
    assert.equal(childReviewSession.attention.workflowId, "planning-execution");

    const childReviewDetailResponse = await authenticatedFetch(
      `/api/sessions/${encodeURIComponent(childReviewSession.id)}?projectId=dev-e2e-project`,
    );
    const childReviewDetail = await childReviewDetailResponse.json();
    assert.equal(childReviewDetailResponse.status, 200, JSON.stringify(childReviewDetail));
    assert.equal(childReviewDetail.activePlanningExecution?.phase, "waiting_review");
    assert.equal(childReviewDetail.activePlanningExecution?.review?.workflowId, "planning-execution");
    assert.equal(childReviewDetail.activePlanningExecution?.review?.plan, "CHILD_REVIEW_PLAN_READY");
    const childReviewRun = childReviewDetail.activePlanningExecution;
    const childReview = childReviewRun.review;
    const childReviewApproval = await authenticatedFetch(
      `/runs/${encodeURIComponent(childReviewRun.runId)}/review`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "dev-e2e-project",
          decision: {
            kind: "approve",
            reviewId: childReview.reviewId,
            workflowInvocationId: childReview.workflowInvocationId,
            planRevision: childReview.planRevision,
            planSha256: childReview.planSha256,
          },
        }),
      },
    );
    assert.equal(childReviewApproval.status, 202, await childReviewApproval.text());

    const directReviewDeadline = Date.now() + 20_000;
    let directReviewStatus;
    while (Date.now() < directReviewDeadline) {
      const response = await authenticatedFetch(`/runs/${encodeURIComponent(directReviewStarted.runId)}`);
      directReviewStatus = await response.json();
      assert.equal(response.status, 200, JSON.stringify(directReviewStatus));
      if (["completed", "failed", "cancelled"].includes(directReviewStatus.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(directReviewStatus?.status, "completed", `${JSON.stringify(directReviewStatus)}\n${output}`);
    assert.equal(directReviewStatus.result.text, "DIRECT_REVIEW_PARENT_OK");

    const directReviewParentResponse = await authenticatedFetch(
      `/api/sessions/${encodeURIComponent(directReviewStarted.sessionId)}?projectId=dev-e2e-project`,
    );
    const directReviewParent = await directReviewParentResponse.json();
    assert.equal(directReviewParentResponse.status, 200, JSON.stringify(directReviewParent));
    assert.equal(directReviewParent.workflowCalls.length, 1);
    assert.equal(directReviewParent.workflowCalls[0].child.sessionId, childReviewSession.id);
    assert.equal(directReviewParent.workflowCalls[0].status, "completed");
    assert.match(JSON.stringify(directReviewParent.context.messages), /CHILD_REVIEW_EXECUTED/);

    const completedChildResponse = await authenticatedFetch(
      `/api/sessions/${encodeURIComponent(childReviewSession.id)}?projectId=dev-e2e-project`,
    );
    const completedChild = await completedChildResponse.json();
    assert.equal(completedChildResponse.status, 200, JSON.stringify(completedChild));
    const completedChildHistory = JSON.stringify(completedChild.context.messages);
    assert.match(completedChildHistory, /CHILD_REVIEW_PLAN/);
    assert.match(completedChildHistory, /CHILD_REVIEW_PLAN_READY/);
    assert.match(completedChildHistory, /已通过执行计划 v1，开始执行。/);
    assert.match(completedChildHistory, /CHILD_REVIEW_EXECUTED/);
    assert.deepEqual(
      Object.keys(completedChild.workflowTurnConfigurations[0].agentConfigs).sort(),
      ["pi-coding-agent", "planner"],
    );

    const completedChildSessionsResponse = await authenticatedFetch(
      "/api/sessions?projectId=dev-e2e-project",
    );
    const completedChildSessions = await completedChildSessionsResponse.json();
    assert.equal(completedChildSessionsResponse.status, 200, JSON.stringify(completedChildSessions));
    const completedChildSummary = completedChildSessions.sessions.find(
      (session) => session.id === childReviewSession.id,
    );
    assert.equal(completedChildSummary?.parentSessionId, directReviewStarted.sessionId);
    assert.equal(completedChildSummary?.attention, undefined);

    const directSelfStartResponse = await authenticatedFetch("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "dev-e2e-project",
        cwd: canonicalWorkspace,
        prompt: "DIRECT_CALL_SELF: Delegate one child task to a new Direct Workflow run.",
        workflow: "minimal-pi-coding-agent",
      }),
    });
    const directSelfStarted = await directSelfStartResponse.json();
    assert.equal(directSelfStartResponse.status, 202, JSON.stringify(directSelfStarted));
    const directSelfDeadline = Date.now() + 15_000;
    let directSelfStatus;
    while (Date.now() < directSelfDeadline) {
      const response = await authenticatedFetch(`/runs/${encodeURIComponent(directSelfStarted.runId)}`);
      directSelfStatus = await response.json();
      assert.equal(response.status, 200, JSON.stringify(directSelfStatus));
      if (["completed", "failed", "cancelled"].includes(directSelfStatus.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(
      directSelfStatus?.status,
      "completed",
      `${JSON.stringify(directSelfStatus)}\n${output}`,
    );
    assert.equal(directSelfStatus.result.text, "DIRECT_SELF_PARENT_OK");

    const directSelfParentResponse = await authenticatedFetch(
      `/api/sessions/${encodeURIComponent(directSelfStarted.sessionId)}?projectId=dev-e2e-project`,
    );
    const directSelfParent = await directSelfParentResponse.json();
    assert.equal(directSelfParentResponse.status, 200, JSON.stringify(directSelfParent));
    assert.equal(directSelfParent.workflowCalls.length, 1);
    assert.equal(directSelfParent.workflowCalls[0].child.workflowId, "minimal-pi-coding-agent");
    assert.equal(directSelfParent.workflowCalls[0].status, "completed");
    assert.notEqual(directSelfParent.workflowCalls[0].child.sessionId, directSelfStarted.sessionId);
    assert.equal(typeof directSelfParent.workflowCalls[0].child.runId, "string");

    const directWaitStartResponse = await authenticatedFetch("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "dev-e2e-project",
        cwd: canonicalWorkspace,
        prompt: "DIRECT_CALL_WAIT: Start a delayed child, yield once, then wait for its result.",
        workflow: "minimal-pi-coding-agent",
      }),
    });
    const directWaitStarted = await directWaitStartResponse.json();
    assert.equal(directWaitStartResponse.status, 202, JSON.stringify(directWaitStarted));
    const directWaitDeadline = Date.now() + 15_000;
    let directWaitStatus;
    while (Date.now() < directWaitDeadline) {
      const response = await authenticatedFetch(`/runs/${encodeURIComponent(directWaitStarted.runId)}`);
      directWaitStatus = await response.json();
      assert.equal(response.status, 200, JSON.stringify(directWaitStatus));
      if (["completed", "failed", "cancelled"].includes(directWaitStatus.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(directWaitStatus?.status, "completed", `${JSON.stringify(directWaitStatus)}\n${output}`);
    assert.equal(directWaitStatus.result.text, "DIRECT_WAIT_PARENT_OK");
    const directWaitParentResponse = await authenticatedFetch(
      `/api/sessions/${encodeURIComponent(directWaitStarted.sessionId)}?projectId=dev-e2e-project`,
    );
    const directWaitParent = await directWaitParentResponse.json();
    assert.equal(directWaitParentResponse.status, 200, JSON.stringify(directWaitParent));
    assert.equal(directWaitParent.workflowCalls.length, 1);
    assert.equal(directWaitParent.workflowCalls[0].status, "completed");
    assert.equal(modelRequests.some((request) => (
      JSON.stringify(request.messages).includes('\\"action\\":\\"wait\\"')
    )), true);

    const directCancelStartResponse = await authenticatedFetch("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "dev-e2e-project",
        cwd: canonicalWorkspace,
        prompt: "DIRECT_CALL_CANCEL: Start a delayed child and intentionally cancel it.",
        workflow: "minimal-pi-coding-agent",
      }),
    });
    const directCancelStarted = await directCancelStartResponse.json();
    assert.equal(directCancelStartResponse.status, 202, JSON.stringify(directCancelStarted));
    const directCancelDeadline = Date.now() + 15_000;
    let directCancelStatus;
    while (Date.now() < directCancelDeadline) {
      const response = await authenticatedFetch(`/runs/${encodeURIComponent(directCancelStarted.runId)}`);
      directCancelStatus = await response.json();
      assert.equal(response.status, 200, JSON.stringify(directCancelStatus));
      if (["completed", "failed", "cancelled"].includes(directCancelStatus.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(
      directCancelStatus?.status,
      "completed",
      `${JSON.stringify(directCancelStatus)}\n${output}`,
    );
    assert.equal(directCancelStatus.result.text, "DIRECT_CANCEL_PARENT_OK");
    const directCancelParentResponse = await authenticatedFetch(
      `/api/sessions/${encodeURIComponent(directCancelStarted.sessionId)}?projectId=dev-e2e-project`,
    );
    const directCancelParent = await directCancelParentResponse.json();
    assert.equal(directCancelParentResponse.status, 200, JSON.stringify(directCancelParent));
    assert.equal(directCancelParent.workflowCalls.length, 1);
    assert.equal(directCancelParent.workflowCalls[0].status, "cancelled");
    assert.equal(typeof directCancelParent.workflowCalls[0].finishedAt, "string");
    assert.equal(typeof directCancelParent.workflowCalls[0].durationMs, "number");
    assert.equal(modelRequests.some((request) => (
      JSON.stringify(request.messages).includes('\\"action\\":\\"cancel\\"')
    )), true);

    const uiCancelStartResponse = await authenticatedFetch("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "dev-e2e-project",
        cwd: canonicalWorkspace,
        prompt: "DIRECT_CALL_UI_CANCEL: Start a child that the user will stop through the control API.",
        workflow: "minimal-pi-coding-agent",
      }),
    });
    const uiCancelStarted = await uiCancelStartResponse.json();
    assert.equal(uiCancelStartResponse.status, 202, JSON.stringify(uiCancelStarted));
    await Promise.race([
      uiCancelParentReady,
      new Promise((_, reject) => setTimeout(() => reject(new Error("UI cancellation did not reach watch boundary")), 15_000)),
    ]);
    const watchPath = `/api/sessions/${encodeURIComponent(uiCancelStarted.sessionId)}/workflow-calls?projectId=dev-e2e-project`;
    const activeWatchResponse = await authenticatedFetch(watchPath);
    const activeWatch = await activeWatchResponse.json();
    assert.equal(activeWatchResponse.status, 200, JSON.stringify(activeWatch));
    assert.equal(activeWatch.workflowCallStatistics.capacity.active, 1);
    assert.equal(activeWatch.workflowCallTree.length, 1);
    assert.equal(activeWatch.workflowCallTree[0].depth, 1);
    assert.equal(activeWatch.workflowCallTree[0].call.status, "running");
    const watchedCall = activeWatch.workflowCallTree[0].call;

    const wrongOwnerCancelResponse = await authenticatedFetch(
      `/api/sessions/${encodeURIComponent(watchedCall.child.sessionId)}/workflow-calls/${encodeURIComponent(watchedCall.callId)}?projectId=dev-e2e-project`,
      { method: "DELETE" },
    );
    assert.equal(wrongOwnerCancelResponse.status, 409);

    const watchCancelResponse = await authenticatedFetch(
      `/api/sessions/${encodeURIComponent(watchedCall.parent.sessionId)}/workflow-calls/${encodeURIComponent(watchedCall.callId)}?projectId=dev-e2e-project`,
      { method: "DELETE" },
    );
    const watchCancelled = await watchCancelResponse.json();
    assert.equal(watchCancelResponse.status, 200, JSON.stringify(watchCancelled));
    assert.equal(watchCancelled.result.status, "cancelled");
    assert.equal(watchCancelled.result.callId, watchedCall.callId);

    const terminalWatchResponse = await authenticatedFetch(watchPath);
    const terminalWatch = await terminalWatchResponse.json();
    assert.equal(terminalWatchResponse.status, 200, JSON.stringify(terminalWatch));
    assert.equal(terminalWatch.workflowCallStatistics.capacity.active, 0);
    assert.equal(terminalWatch.workflowCallTree[0].call.status, "cancelled");
    releaseUiCancelParent?.();

    const uiCancelDeadline = Date.now() + 15_000;
    let uiCancelStatus;
    while (Date.now() < uiCancelDeadline) {
      const response = await authenticatedFetch(`/runs/${encodeURIComponent(uiCancelStarted.runId)}`);
      uiCancelStatus = await response.json();
      if (["completed", "failed", "cancelled"].includes(uiCancelStatus.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(uiCancelStatus?.status, "completed", `${JSON.stringify(uiCancelStatus)}\n${output}`);
    assert.equal(uiCancelStatus.result.text, "DIRECT_UI_CANCEL_PARENT_OK");

    const directRestartStartResponse = await authenticatedFetch("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "dev-e2e-project",
        cwd: canonicalWorkspace,
        prompt: "DIRECT_CALL_RESTART: Start a child, then recover its wait after a Backend crash.",
        workflow: "minimal-pi-coding-agent",
      }),
    });
    const directRestartStarted = await directRestartStartResponse.json();
    assert.equal(directRestartStartResponse.status, 202, JSON.stringify(directRestartStarted));
    await Promise.race([
      restartReady,
      new Promise((_, reject) => setTimeout(() => reject(new Error("restart call did not reach wait boundary")), 15_000)),
    ]);
    const preCrashCallDeadline = Date.now() + 5_000;
    let preCrashParent;
    while (Date.now() < preCrashCallDeadline) {
      const response = await authenticatedFetch(
        `/api/sessions/${encodeURIComponent(directRestartStarted.sessionId)}?projectId=dev-e2e-project`,
      );
      preCrashParent = await response.json();
      assert.equal(response.status, 200, JSON.stringify(preCrashParent));
      if (preCrashParent.workflowCalls?.[0]?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(preCrashParent?.workflowCalls?.[0]?.status, "completed", JSON.stringify(preCrashParent));
    const originalChildSessionId = preCrashParent.workflowCalls[0].child.sessionId;
    await crashProcess(devServer);
    restartGeneration = 1;
    releaseRestartModelRequest?.();
    devServer = startDevServer();
    assert.equal(await waitForDevServer(devServer), true, output);

    const interruptedParentResponse = await authenticatedFetch(
      `/runs/${encodeURIComponent(directRestartStarted.runId)}`,
      { method: "DELETE" },
    );
    assert.equal(interruptedParentResponse.status, 200, await interruptedParentResponse.text());
    const continuationResponse = await authenticatedFetch("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "dev-e2e-project",
        cwd: canonicalWorkspace,
        sessionId: directRestartStarted.sessionId,
        prompt: "DIRECT_CALL_RESTART_CONTINUE: Continue supervising the existing child call; do not start another one.",
        workflow: "minimal-pi-coding-agent",
      }),
    });
    const continuation = await continuationResponse.json();
    assert.equal(continuationResponse.status, 202, JSON.stringify(continuation));
    const directRestartDeadline = Date.now() + 30_000;
    let directRestartStatus;
    while (Date.now() < directRestartDeadline) {
      const response = await authenticatedFetch(`/runs/${encodeURIComponent(continuation.runId)}`);
      directRestartStatus = await response.json();
      assert.equal(response.status, 200, JSON.stringify(directRestartStatus));
      if (["completed", "failed", "cancelled"].includes(directRestartStatus.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(
      directRestartStatus?.status,
      "completed",
      `${JSON.stringify(directRestartStatus)}\n${output}`,
    );
    assert.equal(directRestartStatus.result.text, "DIRECT_RESTART_PARENT_OK");
    const directRestartParentResponse = await authenticatedFetch(
      `/api/sessions/${encodeURIComponent(directRestartStarted.sessionId)}?projectId=dev-e2e-project`,
    );
    const directRestartParent = await directRestartParentResponse.json();
    assert.equal(directRestartParentResponse.status, 200, JSON.stringify(directRestartParent));
    assert.equal(directRestartParent.workflowCalls.length, 1);
    assert.equal(directRestartParent.workflowCalls[0].status, "completed");
    assert.equal(directRestartParent.workflowCalls[0].child.sessionId, originalChildSessionId);
    assert.equal(directRestartParent.workflowCallStatistics.direct.completed, 1);
    assert.equal(directRestartParent.workflowCallStatistics.tree.subsessionCount, 1);
    assert.equal(modelRequests.some((request) => (
      JSON.stringify(request.messages).includes('\\"action\\":\\"wait\\"')
      && JSON.stringify(request.messages).includes("DIRECT_CALL_RESTART")
    )), true);

    const orchestrationStartResponse = await authenticatedFetch("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "dev-e2e-project",
        cwd: canonicalWorkspace,
        prompt: "ORCHESTRATE_FIVE: Plan exactly five independent execution work packages.",
        workflow: "planner-orchestrator",
      }),
    });
    const orchestrationStarted = await orchestrationStartResponse.json();
    assert.equal(orchestrationStartResponse.status, 202, JSON.stringify(orchestrationStarted));
    const orchestrationQuery = new URLSearchParams({
      projectId: "dev-e2e-project",
      workflowInvocationId: orchestrationStarted.workflowInvocationId,
    });
    const orchestrationStatusPath = `/runs/${encodeURIComponent(orchestrationStarted.runId)}?${orchestrationQuery.toString()}`;
    const orchestrationReviewDeadline = Date.now() + 15_000;
    let orchestrationReview;
    while (Date.now() < orchestrationReviewDeadline) {
      const response = await authenticatedFetch(orchestrationStatusPath);
      const current = await response.json();
      assert.equal(response.status, 200, JSON.stringify(current));
      if (current.phase === "waiting_review") {
        orchestrationReview = current.review;
        break;
      }
      if (["failed", "cancelled"].includes(current.status)) {
        assert.fail(`${JSON.stringify(current)}\n${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(orchestrationReview?.workflowId, "planner-orchestrator");
    assert.equal(orchestrationReview?.readiness, "ready_for_review");
    assert.match(orchestrationReview?.plan ?? "", /ORCH_CHILD_5/);
    const sessionsBeforeApprovalResponse = await authenticatedFetch("/api/sessions?projectId=dev-e2e-project");
    const sessionsBeforeApproval = await sessionsBeforeApprovalResponse.json();
    assert.equal(
      sessionsBeforeApproval.sessions.filter((session) => session.parentSessionId === orchestrationStarted.sessionId).length,
      0,
      "no child Session may exist before human approval",
    );
    const orchestrationApproval = await authenticatedFetch(
      `/runs/${encodeURIComponent(orchestrationStarted.runId)}/review`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "dev-e2e-project",
          decision: {
            kind: "approve",
            reviewId: orchestrationReview.reviewId,
            workflowInvocationId: orchestrationReview.workflowInvocationId,
            planRevision: orchestrationReview.planRevision,
            planSha256: orchestrationReview.planSha256,
          },
        }),
      },
    );
    assert.equal(orchestrationApproval.status, 202, await orchestrationApproval.text());

    const orchestrationDeadline = Date.now() + 30_000;
    let orchestrationStatus;
    while (Date.now() < orchestrationDeadline) {
      const response = await authenticatedFetch(orchestrationStatusPath);
      orchestrationStatus = await response.json();
      assert.equal(response.status, 200, JSON.stringify(orchestrationStatus));
      if (["completed", "failed", "cancelled"].includes(orchestrationStatus.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(
      orchestrationStatus?.status,
      "completed",
      `${JSON.stringify(orchestrationStatus)}\n${output}`,
    );
    assert.equal(orchestrationStatus.result.text, "ORCHESTRATION_5_OK");

    const parentSessionResponse = await authenticatedFetch(
      `/api/sessions/${encodeURIComponent(orchestrationStarted.sessionId)}?projectId=dev-e2e-project`,
    );
    const parentSession = await parentSessionResponse.json();
    assert.equal(parentSessionResponse.status, 200, JSON.stringify(parentSession));
    assert.equal(parentSession.workflowCalls.length, 5);
    assert.deepEqual(parentSession.workflowCalls.map((call) => call.status), [
      "completed", "completed", "completed", "completed", "completed",
    ]);
    assert.equal(new Set(parentSession.workflowCalls.map((call) => call.child.sessionId)).size, 5);
    assert.equal(new Set(parentSession.workflowCalls.map((call) => call.child.runId)).size, 5);
    assert.equal(new Set(parentSession.workflowCalls.map((call) => call.child.workflowInvocationId)).size, 5);
    assert.equal(parentSession.workflowCalls.every((call) => (
      typeof call.durationMs === "number"
      && typeof call.finishedAt === "string"
    )), true);
    assert.deepEqual(parentSession.workflowCallStatistics.capacity, { active: 0, limit: 8 });
    assert.equal(parentSession.workflowCallStatistics.direct.completed, 5);
    assert.equal(parentSession.workflowCallStatistics.tree.total, 5);
    assert.equal(parentSession.workflowCallStatistics.tree.subsessionCount, 5);
    assert.equal(parentSession.workflowCallStatistics.tree.maxDepth, 1);
    assert.equal(parentSession.workflowCallTree.length, 5);
    assert.deepEqual(parentSession.workflowCallTree.map((node) => node.depth), [1, 1, 1, 1, 1]);
    assert.equal(parentSession.workflowCallTree.every((node) => node.parentCallId === undefined), true);

    const orchestrationWatchResponse = await authenticatedFetch(
      `/api/sessions/${encodeURIComponent(orchestrationStarted.sessionId)}/workflow-calls?projectId=dev-e2e-project`,
    );
    const orchestrationWatch = await orchestrationWatchResponse.json();
    assert.equal(orchestrationWatchResponse.status, 200, JSON.stringify(orchestrationWatch));
    assert.deepEqual(orchestrationWatch, {
      workflowCallStatistics: parentSession.workflowCallStatistics,
      workflowCallTree: parentSession.workflowCallTree,
    });

    const orchestrationEventsResponse = await authenticatedFetch(
      `/runs/${encodeURIComponent(orchestrationStarted.runId)}/events?startIndex=0`,
    );
    assert.equal(orchestrationEventsResponse.status, 200);
    const orchestrationEvents = (await orchestrationEventsResponse.text())
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const workflowCallUpdates = orchestrationEvents.filter((event) => (
      event.type === "agent_event"
      && event.event?.type === "tool_execution_update"
      && event.event?.toolName === "workflow_call"
    ));
    assert.equal(new Set(workflowCallUpdates.map((event) => event.event.partialResult?.details?.callId)).size, 5);
    assert.equal(workflowCallUpdates.every((event) => (
      typeof event.event.partialResult?.details?.elapsedMs === "number"
      && !JSON.stringify(event.event.partialResult).includes("Execute approved independent package")
    )), true);

    const sessionsAfterApprovalResponse = await authenticatedFetch("/api/sessions?projectId=dev-e2e-project");
    const sessionsAfterApproval = await sessionsAfterApprovalResponse.json();
    const childSessions = sessionsAfterApproval.sessions.filter(
      (session) => session.parentSessionId === orchestrationStarted.sessionId,
    );
    assert.equal(childSessions.length, 5);
    assert.equal(childSessions.every((session) => session.id !== orchestrationStarted.sessionId), true);
    const childRequests = modelRequests.filter((request) => (
      !JSON.stringify(request.messages.filter((message) => message.role === "system"))
        .includes("Planner Orchestrator Workflow中的Coordinator")
      && JSON.stringify(request.messages.at(-1)?.content ?? "").includes("ORCH_CHILD_")
    ));
    assert.equal(childRequests.length, 5);
    assert.equal(childRequests.every((request) => (request.tools ?? []).length === 0), true);
    assert.match(output, /\[workflow-coordinator\] tool started name=workflow_call/);
    assert.doesNotMatch(output, /Workflow不允许由Agent调用|Workflow不能直接调用自身/);
  } finally {
    await stopProcess(devServer);
    if (modelServer?.listening) {
      await new Promise((resolve) => modelServer.close(resolve));
    }
    fs.rmSync(buildDir, { recursive: true, force: true });
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

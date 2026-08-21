import { createServer } from "node:http";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "45311", 10);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
  throw new Error("trajectory fixture PORT必须是有效的非特权TCP端口");
}
const timestamp = "2026-08-18T00:00:00.000Z";
const sessionId = "psn_trajectory1";
const productRunId = "run_trajectory1";
const userMessageId = "msg_trajectoryuser1";
const assistantMessageId = "msg_trajectoryassistant1";
const schemaVersion = "chat-product-api.v1";
let submitted = false;
let tracePhase = 0;
let completed = false;
let productSessionTitle = "未创建";
let submittedText = "";

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function run() {
  return {
    schemaVersion,
    productRunId,
    sessionId,
    sourceMessageId: userMessageId,
    runKind: "planning",
    status: completed ? "succeeded" : "running",
    phase: completed ? "completed" : "executing",
    ...(completed ? { finalMessageId: assistantMessageId } : {}),
    allowedActions: [],
    revision: completed ? 2 : 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function productSession() {
  return {
    schemaVersion,
    sessionId,
    status: "active",
    title: productSessionTitle,
    revision: completed ? 2 : 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function userMessage() {
  return {
    schemaVersion,
    messageId: userMessageId,
    sessionId,
    sessionSequence: 1,
    role: "user",
    content: { format: "markdown", text: submittedText },
    sha256: "a".repeat(64),
    createdAt: timestamp,
  };
}

function assistantMessage() {
  return {
    schemaVersion,
    messageId: assistantMessageId,
    sessionId,
    sessionSequence: 2,
    role: "assistant",
    content: { format: "markdown", text: "TRAJECTORY_E2E_COMPLETED" },
    sourceRunId: productRunId,
    sha256: "b".repeat(64),
    createdAt: timestamp,
  };
}

function tracePage(afterSequence) {
  const all = [];
  if (tracePhase >= 1) {
    all.push({
      sequence: 1,
      timestamp,
      type: "tool_call",
      toolCallId: "call_trajectory1",
      toolName: "bash",
      input: '{"command":"node --version","path":"."}',
      inputTruncated: false,
    });
  }
  if (tracePhase >= 2) {
    all.push({
      sequence: 2,
      timestamp: "2026-08-18T00:00:01.000Z",
      type: "tool_result",
      toolCallId: "call_trajectory1",
      toolName: "bash",
      outcome: "success",
      output: "TRACE_UI_RESULT_OK",
      outputTruncated: false,
      durationMs: 750,
    });
  }
  return {
    schemaVersion: "chat-execution-trace.v1",
    productRunId,
    items: all.filter((item) => item.sequence > afterSequence),
    nextCursor: all.length,
    hasMore: false,
  };
}

function workflowTrace() {
  const status = completed ? "succeeded" : "running";
  const runtimeStatus = completed ? "completed" : "running";
  const updatedAt = completed ? "2026-08-18T00:00:03.000Z" : timestamp;
  const completedFields = completed ? { completedAt: updatedAt, durationMs: 3_000 } : {};
  const nodeCompletedFields = completed ? { finishedAt: updatedAt, durationMs: 3_000 } : {};
  const activityCompletedFields = completed ? { completedAt: updatedAt, durationMs: 2_000 } : {};
  const toolActivities =
    tracePhase === 0
      ? []
      : [
          {
            activityKey: "pi-tool-1",
            parentActivityKey: "pi-agent-1",
            attemptId: "att_trajectory1",
            workflowNodeRunId: "wnr_trajectory1",
            executionStepId: "step_trajectory1",
            sequence: 3,
            kind: "tool",
            label: "工具：bash",
            status: tracePhase >= 2 ? "succeeded" : "running",
            nodeKind: "executor",
            toolName: "bash",
            inputDisplay: '{"command":"node --version","path":"."}',
            inputDisplayTruncated: false,
            startedAt: timestamp,
            ...(tracePhase >= 2
              ? {
                  resultDisplay: "TRACE_UI_RESULT_OK",
                  resultDisplayTruncated: false,
                  completedAt: "2026-08-18T00:00:01.000Z",
                  durationMs: 750,
                }
              : {}),
          },
        ];
  return {
    schemaVersion: "chat-workflow-execution-trace.v1",
    productRunId,
    traceRevision: (completed ? "3" : tracePhase >= 2 ? "2" : "1").repeat(64),
    updatedAt,
    run: {
      status,
      phase: completed ? "completed" : "executing",
      createdAt: timestamp,
      updatedAt,
    },
    workflow: {
      title: "轨迹验证工作流",
      nodeRuns: [
        {
          workflowNodeRunId: "wnr_trajectory1",
          definitionNodeId: "planning.execute",
          nodeType: "execute.plan",
          title: "执行轨迹验证",
          kind: "composite",
          optional: false,
          executionPath: [],
          attemptNumber: 1,
          status,
          publicSummary: completed ? "轨迹验证完成" : "正在验证轨迹",
          startedAt: timestamp,
          ...nodeCompletedFields,
          revision: completed ? 2 : 1,
          updatedAt,
          allowedActions: ["inspect"],
        },
      ],
      nodeDetails: [
        {
          workflowNodeRunId: "wnr_trajectory1",
          input: [
            {
              label: "用户请求",
              format: "markdown",
              text: submittedText || "验证Pi执行轨迹实时显示",
              truncated: false,
            },
          ],
          output: completed
            ? [
                {
                  label: "执行结果",
                  format: "text",
                  text: "TRAJECTORY_E2E_COMPLETED",
                  truncated: false,
                },
              ]
            : [],
        },
      ],
      executionSteps: [
        {
          parentWorkflowNodeRunId: "wnr_trajectory1",
          stepId: "step_trajectory1",
          title: "运行node --version",
          status,
          startedAt: timestamp,
          ...completedFields,
          input: [
            {
              label: "执行步骤输入",
              format: "json",
              text: '{"command":"node --version"}',
              truncated: false,
            },
          ],
          output: completed
            ? [
                {
                  label: "执行步骤输出",
                  format: "text",
                  text: "TRACE_UI_RESULT_OK",
                  truncated: false,
                },
              ]
            : [],
        },
      ],
    },
    runtime: {
      schemaVersion: "chat-workflow-runtime-trace.v1",
      productRunId,
      sourceKind: "vercel_workflow",
      availability: "available",
      workflowName: "trajectoryFixtureWorkflow",
      runtimeStatus,
      isLive: !completed,
      refreshAfterMs: completed ? null : 350,
      refreshedAt: updatedAt,
      createdAt: timestamp,
      startedAt: timestamp,
      ...completedFields,
      durationMs: completed ? 3_000 : 0,
      knownDurationMs: completed ? 3_000 : 0,
      eventCount: 1,
      truncated: false,
      spans: [
        {
          spanKey: "runtime-run-0",
          sequence: 0,
          kind: "run",
          name: "trajectoryFixtureWorkflow",
          status: runtimeStatus,
          createdAt: timestamp,
          startedAt: timestamp,
          ...completedFields,
          offsetMs: 0,
          durationMs: completed ? 3_000 : 0,
          segments: [],
          eventSequences: [1],
        },
      ],
      events: [
        {
          sequence: 1,
          type: "run_started",
          resourceKind: "run",
          spanKey: "runtime-run-0",
          recordedAt: timestamp,
          offsetMs: 0,
        },
      ],
    },
    piActivities: [
      {
        activityKey: "pi-agent-1",
        attemptId: "att_trajectory1",
        workflowNodeRunId: "wnr_trajectory1",
        executionStepId: "step_trajectory1",
        sequence: 1,
        kind: "agent",
        label: "执行 Agent",
        status,
        nodeKind: "executor",
        startedAt: timestamp,
        ...activityCompletedFields,
      },
      {
        activityKey: "pi-model-1",
        parentActivityKey: "pi-agent-1",
        attemptId: "att_trajectory1",
        workflowNodeRunId: "wnr_trajectory1",
        executionStepId: "step_trajectory1",
        sequence: 2,
        kind: "model",
        label: "模型调用：fixture/model",
        status,
        nodeKind: "executor",
        provider: "fixture",
        model: "model",
        startedAt: timestamp,
        ...activityCompletedFields,
        ...(completed
          ? { tokenUsage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } }
          : {}),
      },
      ...toolActivities,
    ],
    truncated: false,
  };
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", `http://${host}:${String(port)}`);
    if (request.method === "GET" && url.pathname === "/api/readyz") {
      json(response, 200, { status: "ok", service: "chat-trajectory-fixture" });
      return;
    }
    if (request.method === "POST" && url.pathname === "/__trajectory/intent") {
      tracePhase = Math.max(tracePhase, 1);
      json(response, 200, { tracePhase });
      return;
    }
    if (request.method === "POST" && url.pathname === "/__trajectory/result") {
      tracePhase = 2;
      json(response, 200, { tracePhase });
      return;
    }
    if (request.method === "POST" && url.pathname === "/__trajectory/complete") {
      completed = true;
      json(response, 200, { completed });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/workflow/definitions") {
      json(response, 200, { definitions: { schemaVersion, definitions: [] } });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/messages") {
      const body = await requestBody(request);
      const text = body?.payload?.text;
      submittedText = typeof text === "string" ? text : "trajectory";
      productSessionTitle = submittedText.trim().replaceAll(/\s+/gu, " ").slice(0, 200);
      submitted = true;
      json(response, 201, {
        session: productSession(),
        message: userMessage(),
        run: run(),
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/sessions") {
      const body = await requestBody(request);
      productSessionTitle = body?.payload?.title;
      if (typeof productSessionTitle !== "string" || productSessionTitle.trim() === "") {
        throw new Error("Product Session title was not derived from the first prompt");
      }
      json(response, 201, { session: productSession() });
      return;
    }
    if (request.method === "GET" && url.pathname === `/api/sessions/${sessionId}`) {
      json(response, submitted ? 200 : 404, submitted ? { session: productSession() } : {});
      return;
    }
    if (request.method === "POST" && url.pathname === `/api/sessions/${sessionId}/messages`) {
      const body = await requestBody(request);
      const text = body?.payload?.text;
      submittedText = typeof text === "string" ? text : "trajectory";
      submitted = true;
      json(response, 202, {
        message: userMessage(),
        run: run(),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === `/api/sessions/${sessionId}/messages`) {
      json(response, 200, {
        items: submitted ? [userMessage(), ...(completed ? [assistantMessage()] : [])] : [],
      });
      return;
    }
    if (request.method === "GET" && url.pathname === `/api/runs/${productRunId}`) {
      json(response, submitted ? 200 : 404, submitted ? { run: run() } : { code: "not_found" });
      return;
    }
    if (request.method === "GET" && url.pathname === `/api/runs/${productRunId}/execution-trace`) {
      const raw = url.searchParams.get("afterSequence") ?? "0";
      json(response, 200, tracePage(Number(raw)));
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === `/api/runs/${productRunId}/workflow-execution-trace`
    ) {
      json(response, 200, workflowTrace());
      return;
    }
    if (request.method === "GET" && url.pathname === `/api/runs/${productRunId}/plans`) {
      json(response, 200, { items: [] });
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === `/api/runs/${productRunId}/approvals/current`
    ) {
      json(response, 200, { approval: null });
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === `/api/sessions/${sessionId}/messages/${assistantMessageId}`
    ) {
      json(response, 200, { message: assistantMessage() });
      return;
    }
    json(response, 404, {
      type: "about:blank",
      title: "not found",
      status: 404,
      code: "not_found",
      retryable: false,
      recoveryAction: "none",
    });
  })().catch((error) => {
    if (!response.headersSent) json(response, 500, { code: "fixture_failed" });
    else response.destroy();
    console.error(`[trajectory-api] ${error instanceof Error ? error.message : String(error)}`);
  });
});

server.listen(port, host, () => {
  console.log(`chat trajectory fixture listening on http://${host}:${String(port)}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close());
}

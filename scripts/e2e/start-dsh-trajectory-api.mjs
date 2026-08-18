import { createServer } from "node:http";

const host = "127.0.0.1";
const port = 43_111;
const timestamp = "2026-08-18T00:00:00.000Z";
const sessionId = "psn_trajectory1";
const productRunId = "run_trajectory1";
const userMessageId = "msg_trajectoryuser1";
const assistantMessageId = "msg_trajectoryassistant1";
const schemaVersion = "chat-product-api.v1";
let submitted = false;
let tracePhase = 0;
let completed = false;

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
    status: completed ? "succeeded" : "running",
    phase: completed ? "completed" : "executing",
    ...(completed ? { finalMessageId: assistantMessageId } : {}),
    allowedActions: [],
    revision: completed ? 2 : 1,
    createdAt: timestamp,
    updatedAt: timestamp,
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
    if (request.method === "POST" && url.pathname === "/api/sessions") {
      json(response, 201, {
        session: {
          schemaVersion,
          sessionId,
          status: "active",
          title: "DeepSeek Harness",
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      });
      return;
    }
    if (request.method === "POST" && url.pathname === `/api/sessions/${sessionId}/messages`) {
      const body = await requestBody(request);
      const text = body?.payload?.text;
      submitted = true;
      json(response, 202, {
        message: {
          schemaVersion,
          messageId: userMessageId,
          sessionId,
          sessionSequence: 1,
          role: "user",
          content: { format: "markdown", text: typeof text === "string" ? text : "trajectory" },
          sha256: "a".repeat(64),
          createdAt: timestamp,
        },
        run: run(),
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
      json(response, 200, {
        message: {
          schemaVersion,
          messageId: assistantMessageId,
          sessionId,
          sessionSequence: 2,
          role: "assistant",
          content: { format: "markdown", text: "TRAJECTORY_E2E_COMPLETED" },
          sourceRunId: productRunId,
          sha256: "b".repeat(64),
          createdAt: timestamp,
        },
      });
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

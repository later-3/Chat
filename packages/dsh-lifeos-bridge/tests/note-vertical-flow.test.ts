import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createUserMessage, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { LifeosLlmAdapter } from "../src/adapter.ts";
import { LifeosBridgeService } from "../src/bridge-service.ts";
import { ChatProductClient } from "../src/chat-client.ts";
import { AtomicBridgeStateStore } from "../src/state-store.ts";

const productSchemaVersion = "chat-product-api.v1";
const noteSchemaVersion = "chat-note-api.v1";
const timestamp = "2026-08-18T00:00:00.000Z";
const sessionId = "psn_notebridge1";
const runId = "run_notebridge1";
const candidateId = "ntc_notebridge1";
const candidateSha256 = "d".repeat(64);

const session = {
  schemaVersion: productSchemaVersion,
  sessionId,
  status: "active",
  title: "DeepSeek Harness",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
} as const;
const userMessage = {
  schemaVersion: productSchemaVersion,
  messageId: "msg_noteuser1",
  sessionId,
  sessionSequence: 1,
  role: "user",
  content: { format: "markdown", text: "请把这段信息整理成笔记" },
  sha256: "a".repeat(64),
  createdAt: timestamp,
} as const;
const assistantMessage = {
  schemaVersion: productSchemaVersion,
  messageId: "msg_noteassistant1",
  sessionId,
  sessionSequence: 2,
  role: "assistant",
  content: { format: "markdown", text: "笔记已经确认并保存。" },
  sourceRunId: runId,
  sha256: "b".repeat(64),
  createdAt: timestamp,
} as const;
const candidate = {
  schemaVersion: noteSchemaVersion,
  noteCandidateId: candidateId,
  productRunId: runId,
  candidateSequence: 1,
  proposed: {
    title: "Bridge 笔记审核",
    kind: "general",
    contentMarkdown: "这是一段必须先经用户确认的候选正文。",
    tags: [{ key: "bridge", label: "Bridge" }],
  },
  sourceRefs: [
    {
      kind: "full_message",
      sourceMessageId: userMessage.messageId,
      sourceMessageSha256: userMessage.sha256,
    },
  ],
  sha256: candidateSha256,
  revision: 1,
  status: "under_review",
  allowedActions: ["confirm", "request_revision", "reject"],
  createdAt: timestamp,
  updatedAt: timestamp,
} as const;

function run(confirmed: boolean) {
  return confirmed
    ? {
        schemaVersion: productSchemaVersion,
        productRunId: runId,
        sessionId,
        sourceMessageId: userMessage.messageId,
        runKind: "note_capture",
        status: "succeeded",
        phase: "completed",
        finalMessageId: assistantMessage.messageId,
        allowedActions: [],
        revision: 4,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
    : {
        schemaVersion: productSchemaVersion,
        productRunId: runId,
        sessionId,
        sourceMessageId: userMessage.messageId,
        runKind: "note_capture",
        status: "waiting_human",
        phase: "note_review",
        allowedActions: [],
        revision: 2,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
}

async function requestBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function json(res: ServerResponse, value: unknown): void {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(value));
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

test("native DSH Note workflow exposes candidate review and resumes after confirm", async () => {
  let confirmed = false;
  let submittedResolve!: () => void;
  const submitted = new Promise<void>((resolve) => {
    submittedResolve = resolve;
  });
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const body = req.method === "POST" ? await requestBody(req) : undefined;
      requests.push({
        method: req.method ?? "",
        path: url.pathname,
        ...(body === undefined ? {} : { body }),
      });
      if (req.method === "POST" && url.pathname === "/api/sessions") {
        json(res, { session });
      } else if (req.method === "POST" && url.pathname === `/api/sessions/${sessionId}/messages`) {
        submittedResolve();
        json(res, { message: userMessage, run: run(false) });
      } else if (req.method === "GET" && url.pathname === `/api/runs/${runId}`) {
        json(res, { run: run(confirmed) });
      } else if (req.method === "GET" && url.pathname === `/api/runs/${runId}/plans`) {
        json(res, { items: [] });
      } else if (req.method === "GET" && url.pathname === `/api/runs/${runId}/approvals/current`) {
        json(res, { approval: null });
      } else if (
        req.method === "GET" &&
        url.pathname === `/api/runs/${runId}/note-candidates/current`
      ) {
        json(
          res,
          confirmed
            ? { ...candidate, status: "confirmed", allowedActions: [], revision: 2 }
            : candidate,
        );
      } else if (req.method === "POST" && url.pathname === `/api/runs/${runId}/note-decisions`) {
        const envelope = body as {
          expectedRevision?: unknown;
          payload?: { kind?: unknown; noteCandidateId?: unknown; candidateSha256?: unknown };
        };
        assert.equal(envelope.expectedRevision, 2);
        assert.deepEqual(envelope.payload, {
          productRunId: runId,
          noteCandidateId: candidateId,
          candidateRevision: 1,
          candidateSha256,
          kind: "confirm",
        });
        confirmed = true;
        json(res, {
          decision: {
            schemaVersion: noteSchemaVersion,
            noteDecisionId: "ntd_notebridge1",
            productRunId: runId,
            noteCandidateId: candidateId,
            candidateRevision: 1,
            candidateSha256,
            principalId: "usr_notebridge1",
            kind: "confirm",
            createdAt: timestamp,
          },
          candidate: { ...candidate, status: "confirmed", allowedActions: [], revision: 2 },
        });
      } else if (
        req.method === "GET" &&
        url.pathname === `/api/sessions/${sessionId}/messages/${assistantMessage.messageId}`
      ) {
        json(res, { message: assistantMessage });
      } else {
        res.statusCode = 404;
        res.end();
      }
    })().catch((error: unknown) => {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : "fixture failed");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-note-vertical-"));
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const chat = new ChatProductClient(new URL(`http://127.0.0.1:${address.port}`));
    const adapter = new LifeosLlmAdapter(chat, state);
    const bridge = new LifeosBridgeService(chat, state);
    const input: GenerateOptions = {
      provider: "lifeos",
      model: "workflow",
      sessionId: "dsh-note-session-1" as never,
      messages: [
        createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text: userMessage.content.text }],
        }),
      ],
    };
    const generation = collect(adapter.stream(input));
    await submitted;

    let waiting = await bridge.projection("dsh-note-session-1");
    for (let attempt = 0; waiting.run === null && attempt < 20; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      waiting = await bridge.projection("dsh-note-session-1");
    }
    assert.equal(waiting.run?.status, "waiting_human");
    assert.equal(waiting.run?.phase, "note_review");
    assert.equal(waiting.noteCandidate?.proposed.title, candidate.proposed.title);
    assert.deepEqual(waiting.noteCandidate?.allowedActions, [
      "confirm",
      "request_revision",
      "reject",
    ]);
    assert.equal(waiting.pendingNoteDecision, null);
    assert.doesNotMatch(JSON.stringify(waiting), /workflow(run)?id|hook(token)?|pi(session)?id/i);
    assert.equal(
      requests.some(
        (request) =>
          request.path === `/api/runs/${runId}/plans` ||
          request.path === `/api/runs/${runId}/approvals/current`,
      ),
      false,
    );

    assert.ok(waiting.run !== null && waiting.noteCandidate !== null);
    const afterDecision = await bridge.decideNote("dsh-note-session-1", {
      kind: "confirm",
      binding: {
        productRunId: waiting.run.productRunId,
        runRevision: waiting.run.revision,
        noteCandidateId: waiting.noteCandidate.noteCandidateId,
        candidateRevision: waiting.noteCandidate.revision,
        candidateSha256: waiting.noteCandidate.sha256,
      },
    });
    assert.equal(afterDecision.run?.status, "succeeded");
    const chunks = await generation;
    const delta = chunks.find((chunk) => chunk.type === "text-delta");
    assert.equal(
      delta?.type === "text-delta" ? delta.text : undefined,
      assistantMessage.content.text,
    );
    assert.deepEqual(
      requests.filter((request) => request.method === "POST").map((request) => request.path),
      ["/api/sessions", `/api/sessions/${sessionId}/messages`, `/api/runs/${runId}/note-decisions`],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

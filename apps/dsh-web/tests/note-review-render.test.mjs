import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LifeosDock } from "../../../packages/dsh-lifeos-bridge/src/client/LifeosDock.tsx";

const timestamp = "2026-08-18T00:00:00.000Z";
const noteCandidate = {
  schemaVersion: "chat-note-api.v1",
  noteCandidateId: "ntc_render1",
  productRunId: "run_render1",
  candidateSequence: 1,
  proposed: {
    title: "手机端候选笔记",
    kind: "general",
    contentMarkdown: "正文会作为文本显示，不执行 Markdown 中的 HTML。",
    tags: [{ key: "mobile", label: "手机" }],
  },
  sourceRefs: [
    {
      kind: "full_message",
      sourceMessageId: "msg_render1",
      sourceMessageSha256: "a".repeat(64),
    },
  ],
  sha256: "b".repeat(64),
  revision: 1,
  status: "under_review",
  allowedActions: ["confirm", "request_revision", "reject"],
  createdAt: timestamp,
  updatedAt: timestamp,
};

test("Note waiting_human projection renders the readable review card and three actions", () => {
  const state = {
    status: "ready",
    projection: {
      schemaVersion: "chat-dsh-lifeos-bridge.v3",
      dshSessionId: "dsh-render-1",
      run: {
        productRunId: "run_render1",
        status: "waiting_human",
        phase: "note_review",
        allowedActions: [],
        revision: 2,
        updatedAt: timestamp,
      },
      plan: null,
      approval: null,
      pendingDecision: null,
      noteCandidate,
      pendingNoteDecision: null,
      workflowSelection: null,
    },
    submitting: false,
    error: null,
    workflows: null,
    workflowError: null,
    selectingWorkflow: false,
  };
  const html = renderToStaticMarkup(
    createElement(LifeosDock, {
      useLifeos: (selector) => selector(state),
      decide: async () => false,
      decideNote: async () => true,
    }),
  );
  assert.match(html, /data-testid="lifeos-note-card"/u);
  assert.match(html, /手机端候选笔记/u);
  assert.match(html, /等待你审核笔记/u);
  assert.match(html, /正文会作为文本显示/u);
  assert.match(html, /data-testid="lifeos-request-note-revision"/u);
  assert.match(html, /data-testid="lifeos-reject-note"/u);
  assert.match(html, /data-testid="lifeos-confirm-note"/u);
});

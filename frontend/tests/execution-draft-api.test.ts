import assert from "node:assert/strict";
import test from "node:test";

import {
  EXECUTION_DRAFT_SECTION_ORDER,
  reviseExecutionDraft,
  type ExecutionDraftView,
} from "../src/execution-draft-api.js";

test("ExecutionDraft workbench keeps all 17 fixed sections in contract order", () => {
  assert.equal(EXECUTION_DRAFT_SECTION_ORDER.length, 17);
  assert.deepEqual(EXECUTION_DRAFT_SECTION_ORDER.slice(0, 4), [
    "identity_lineage",
    "intent_goal",
    "project_work_binding",
    "background",
  ]);
  assert.equal(EXECUTION_DRAFT_SECTION_ORDER.at(-1), "stop_escalation");
});

test("ExecutionDraft revision sends CAS identity and the complete payload", async () => {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; init?: RequestInit } | null = null;
  const payload = Object.fromEntries(
    EXECUTION_DRAFT_SECTION_ORDER.map((key) => [key, { value: key }]),
  ) as ExecutionDraftView["payload"];
  const draft: ExecutionDraftView = {
    id: "draft-1",
    status: "reviewable",
    row_version: 4,
    revision_id: "revision-4",
    revision: 4,
    revision_status: "reviewable",
    draft_hash: "hash-4",
    context_hash: "context-4",
    execution_brief: "旧摘要",
    payload,
  };
  globalThis.fetch = (async (input, init) => {
    captured = { url: String(input), init };
    return new Response(JSON.stringify({ ...draft, revision: 5, revision_id: "revision-5" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const result = await reviseExecutionDraft(draft, "新摘要", payload);
    assert.equal(result.revision_id, "revision-5");
    assert.ok(captured);
    const request = captured as { url: string; init?: RequestInit };
    assert.match(request.url, /\/api\/execution-drafts\/draft-1$/);
    const body = JSON.parse(String(request.init?.body));
    assert.equal(body.expected_revision_id, "revision-4");
    assert.equal(body.expected_draft_hash, "hash-4");
    assert.equal(body.expected_row_version, 4);
    assert.deepEqual(Object.keys(body.payload), [...EXECUTION_DRAFT_SECTION_ORDER]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LEDGER_SCHEMA_VERSION,
  appendRecord,
  appendSample,
  evaluateLedger,
  initLedger,
  readLedger,
  windowsFor,
} from "./la6-acceptance-ledger.mjs";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "chat-la6-ledger-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test("the 24h ledger only passes with real elapsed time, a date boundary and explained occurrences", (t) => {
  const home = fixture(t);
  const startedAt = "2026-09-21T00:00:00.000Z";
  const expected = windowsFor("2026-09-21").map((window) => window.id);
  const ledger = initLedger(home, { startedAt, timeZone: "UTC", expected, maxSampleGapMs: 8 * 60 * 60 * 1000 });
  assert.equal(ledger.schemaVersion, LEDGER_SCHEMA_VERSION);
  assert.equal(readLedger(home).candidate.parentHead.length > 0, true);

  // Cover the four natural windows on the start date.
  for (const iso of ["2026-09-21T06:00:00.000Z", "2026-09-21T12:00:00.000Z", "2026-09-21T18:00:00.000Z", "2026-09-21T23:00:00.000Z"]) {
    appendSample(home, new Date(iso), { backend: true, nano: true });
  }
  for (const id of expected) appendRecord(home, { kind: "occurrence", expectedId: id, outcome: "success" }, new Date("2026-09-21T23:30:00.000Z"));

  // Same local date and only 23h elapsed: not a pass.
  const early = evaluateLedger(readLedger(home), new Date("2026-09-21T23:00:00.000Z"));
  assert.equal(early.elapsedReal24h, false);
  assert.equal(early.passed, false);

  // 24h later, across the date boundary, everything covered and explained.
  appendSample(home, new Date("2026-09-22T06:00:00.000Z"));
  const complete = evaluateLedger(readLedger(home), new Date("2026-09-22T00:30:00.000Z"));
  assert.equal(complete.elapsedReal24h, true);
  assert.equal(complete.crossedDateBoundary, true);
  assert.deepEqual(complete.missingWindows, []);
  assert.deepEqual(complete.unexplained, []);
  assert.equal(complete.passed, true);
});

test("an uncovered window or an unexplained occurrence fails the run", (t) => {
  const home = fixture(t);
  const expected = windowsFor("2026-09-21").map((window) => window.id);
  initLedger(home, { startedAt: "2026-09-21T00:00:00.000Z", timeZone: "UTC", expected, maxSampleGapMs: 8 * 60 * 60 * 1000 });
  appendSample(home, new Date("2026-09-21T06:00:00.000Z"));
  appendSample(home, new Date("2026-09-21T12:00:00.000Z"));
  appendSample(home, new Date("2026-09-21T18:00:00.000Z"));
  appendRecord(home, { kind: "occurrence", expectedId: expected[0], outcome: "success" }, new Date("2026-09-21T07:00:00.000Z"));
  const missingWindow = evaluateLedger(readLedger(home), new Date("2026-09-22T01:00:00.000Z"));
  assert.equal(missingWindow.passed, false);
  assert.ok(missingWindow.missingWindows.includes("2026-09-21#night"));
  assert.ok(missingWindow.unexplained.length >= 1, "an occurrence without a terminal state is not a pass");

  // A failure or unknown state is surfaced, not treated as success.
  appendSample(home, new Date("2026-09-21T23:00:00.000Z"));
  for (const id of expected.slice(1)) appendRecord(home, { kind: "occurrence", expectedId: id, outcome: "approved-skip" }, new Date("2026-09-21T22:00:00.000Z"));
  appendRecord(home, { kind: "occurrence", expectedId: expected[0], outcome: "failed" }, new Date("2026-09-21T22:30:00.000Z"));
  const failed = evaluateLedger(readLedger(home), new Date("2026-09-22T01:00:00.000Z"));
  assert.equal(failed.passed, false);
  assert.deepEqual(failed.unexplained, [{ id: expected[0], outcome: "failed" }]);
});

test("the reviewer's all-samples-before-start, empty-scenario ledger can never pass", (t) => {
  const home = fixture(t);
  initLedger(home, { startedAt: "2026-09-21T23:59:00.000Z", timeZone: "UTC", expected: [], maxSampleGapMs: 60 * 60 * 1000 });
  for (const iso of ["2026-09-21T00:30:00.000Z", "2026-09-21T06:30:00.000Z", "2026-09-21T12:30:00.000Z", "2026-09-21T18:30:00.000Z"]) {
    appendSample(home, new Date(iso), { backend: true, nano: true });
  }
  const result = evaluateLedger(readLedger(home), new Date("2026-09-22T00:30:00.000Z"));
  assert.equal(result.passed, false);
  assert.equal(result.runSampleCount, 0, "samples before the run start do not count");
  assert.ok(result.reasons.some((reason) => reason.includes("预期发生清单为空")));
  assert.ok(result.reasons.some((reason) => reason.includes("业务发生账本为空")));
  assert.ok(result.reasons.some((reason) => reason.includes("Backend 与 Nano 存活")));
});

test("a candidate change or a sampling gap fails the run", (t) => {
  const home = fixture(t);
  const expected = windowsFor("2026-09-21").map((window) => window.id);
  const ledger = initLedger(home, { startedAt: "2026-09-21T05:30:00.000Z", timeZone: "UTC", expected, maxSampleGapMs: 2 * 60 * 60 * 1000 });
  for (const iso of ["2026-09-21T06:00:00.000Z", "2026-09-21T12:00:00.000Z", "2026-09-21T18:00:00.000Z", "2026-09-21T23:00:00.000Z"]) {
    appendSample(home, new Date(iso), { backend: true, nano: true });
  }
  for (const id of expected) appendRecord(home, { kind: "occurrence", expectedId: id, outcome: "success" }, new Date("2026-09-21T23:30:00.000Z"));
  const changed = evaluateLedger(readLedger(home), new Date("2026-09-22T06:00:00.000Z"), { currentCandidate: { parentHead: "different" } });
  assert.equal(changed.passed, false);
  assert.ok(changed.reasons.some((reason) => reason.includes("候选版本已变化")));
  const gapped = evaluateLedger(readLedger(home), new Date("2026-09-22T06:00:00.000Z"));
  assert.equal(gapped.passed, false);
  assert.ok(gapped.gaps.length >= 1);
  void ledger;
});

test("the ledger rejects a missing tail sample, one-sample liveness, future records and submodule drift", (t) => {
  const home = fixture(t);
  const expected = windowsFor("2026-09-21").map((window) => window.id);
  const base = () => {
    const ledger = initLedger(home, { startedAt: "2026-09-21T05:00:00.000Z", timeZone: "UTC", expected, maxSampleGapMs: 90 * 60 * 1000 });
    for (const iso of ["2026-09-21T06:00:00.000Z", "2026-09-21T12:00:00.000Z", "2026-09-21T18:00:00.000Z", "2026-09-21T23:00:00.000Z"]) {
      // Only the first sample sees both services alive.
      appendSample(home, new Date(iso), { backend: iso.endsWith("06:00:00.000Z"), nano: iso.endsWith("06:00:00.000Z") });
    }
    for (const id of expected) appendRecord(home, { kind: "occurrence", expectedId: id, outcome: "success" }, new Date("2026-09-21T23:30:00.000Z"));
    return ledger;
  };

  // (a) The last hour has no sample at all.
  base();
  const tail = evaluateLedger(readLedger(home), new Date("2026-09-22T05:30:00.000Z"));
  assert.equal(tail.passed, false);
  assert.ok(tail.gaps.some((gap) => gap.gapMinutes >= 60), "a tail sampling gap must fail");

  // (b) Only one sample observed service liveness.
  const liveness = evaluateLedger(readLedger(home), new Date("2026-09-21T23:30:00.000Z"));
  assert.equal(liveness.passed, false);
  assert.equal(liveness.servicesMissing, true);

  // (c) A business record dated in the future is not evidence of a completed occurrence.
  const future = fixture(t);
  initLedger(future, { startedAt: "2026-09-21T05:00:00.000Z", timeZone: "UTC", expected, maxSampleGapMs: 8 * 60 * 60 * 1000 });
  for (const iso of ["2026-09-21T06:00:00.000Z", "2026-09-21T12:00:00.000Z", "2026-09-21T18:00:00.000Z", "2026-09-21T23:00:00.000Z"]) appendSample(future, new Date(iso), { backend: true, nano: true });
  for (const id of expected) appendRecord(future, { kind: "occurrence", expectedId: id, outcome: "success" }, new Date("2026-09-23T09:00:00.000Z"));
  const futureResult = evaluateLedger(readLedger(future), new Date("2026-09-22T05:30:00.000Z"));
  assert.equal(futureResult.passed, false);
  assert.equal(futureResult.outOfRunRecords.length, expected.length);
  assert.ok(futureResult.reasons.some((reason) => reason.includes("未来")));

  // (d) A Pi submodule change invalidates the candidate even when the parent head is unchanged.
  base();
  const ledger = readLedger(home);
  const drifted = JSON.parse(JSON.stringify(ledger.candidate));
  drifted.submodules.pi.head = "different-pi-commit";
  const drift = evaluateLedger(ledger, new Date("2026-09-22T05:30:00.000Z"), { currentCandidate: drifted });
  assert.equal(drift.passed, false);
  assert.ok(drift.reasons.some((reason) => reason.includes("候选版本已变化")));
});

test("the real acceptance entry requires durable business facts and dirty-content candidate binding", (t) => {
  const home = fixture(t);
  const expected = windowsFor("2026-09-21").map((window) => window.id);
  const ledger = initLedger(home, { startedAt: "2026-09-21T05:00:00.000Z", timeZone: "UTC", expected, maxSampleGapMs: 8 * 60 * 60 * 1000 });
  for (const iso of ["2026-09-21T06:00:00.000Z", "2026-09-21T12:00:00.000Z", "2026-09-21T18:00:00.000Z", "2026-09-21T23:00:00.000Z"]) {
    appendSample(home, new Date(iso), { backend: true, nano: true });
  }
  for (const id of expected) appendRecord(home, { kind: "occurrence", expectedId: id, outcome: "success" }, new Date("2026-09-21T23:30:00.000Z"));
  appendSample(home, new Date("2026-09-22T06:00:00.000Z"), { backend: true, nano: true });
  const now = new Date("2026-09-22T06:30:00.000Z");
  // Math-only evaluation can pass, but the real entry must also require durable facts.
  assert.equal(evaluateLedger(readLedger(home), now).passed, true);
  const unverified = evaluateLedger(readLedger(home), now, { requireVerified: true });
  assert.equal(unverified.passed, false);
  assert.ok(unverified.reasons.some((reason) => reason.includes("缺少耐久业务事实核验")));
  const at = "2026-09-21T23:30:00.000Z";
  const durable = Object.fromEntries(expected.map((id, index) => [id, { status: "success", at, source: `delivery:conversation-${String(index)}:delivery-${String(index)}` }]));
  assert.equal(evaluateLedger(readLedger(home), now, { requireVerified: true, verifiedFacts: durable }).passed, true);
  const mismatched = evaluateLedger(readLedger(home), now, { requireVerified: true, verifiedFacts: { ...durable, [expected[0]]: { ...durable[expected[0]], status: "failed" } } });
  assert.equal(mismatched.passed, false);
  assert.equal(mismatched.unverified.length, 1);
  // A caller-declared status string is not a durable fact.
  assert.equal(evaluateLedger(readLedger(home), now, { requireVerified: true, verifiedFacts: { [expected[0]]: "success" } }).passed, false);

  // Dirty content changes must invalidate the candidate even with the same HEAD/count.
  const drifted = JSON.parse(JSON.stringify(ledger.candidate));
  drifted.submodules.pi.dirtyHash = "sha256:changed-content";
  const drift = evaluateLedger(readLedger(home), now, { currentCandidate: drifted });
  assert.equal(drift.passed, false);
  assert.ok(drift.reasons.some((reason) => reason.includes("候选版本已变化")));
});

test("service liveness comes from a real probe, not a declared JSON", async (t) => {
  const { probeServices } = await import("./la6-acceptance-ledger.mjs");
  const http = await import("node:http");
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const up = await probeServices({ backendUrl: `http://127.0.0.1:${String(server.address().port)}`, nanoUrl: `http://127.0.0.1:${String(server.address().port)}` });
  assert.equal(up.backend, true);
  assert.equal(up.nano, true);
  const down = await probeServices({ backendUrl: "http://127.0.0.1:1", nanoUrl: null, timeoutMs: 500 });
  assert.equal(down.backend, false);
  assert.equal(down.nano, false);
});

test("durable facts are resolved from the referenced object, not a declared status", async (t) => {
  const { resolveDurableFacts } = await import("./la6-acceptance-ledger.mjs");
  const home = fixture(t);
  const dir = path.join(home, "projects", "proj-1", "conversations", "conv-1");
  fs.mkdirSync(dir, { recursive: true });
  const at = "2026-09-21T23:30:00.000Z";
  fs.writeFileSync(path.join(dir, "deliveries.json"), JSON.stringify({
    schemaVersion: 1, revision: 1,
    deliveries: [
      { deliveryId: "delivered-1", updatedAt: at, status: "delivered" },
      { deliveryId: "failed-1", updatedAt: at, status: "failed" },
      { deliveryId: "pending-1", updatedAt: at, status: "queued" },
    ],
  }));
  const facts = await resolveDurableFacts(home, [
    { kind: "occurrence", expectedId: "ok", durableRef: { kind: "delivery", storageProjectId: "proj-1", conversationId: "conv-1", deliveryId: "delivered-1" } },
    { kind: "occurrence", expectedId: "bad", durableRef: { kind: "delivery", storageProjectId: "proj-1", conversationId: "conv-1", deliveryId: "failed-1" } },
    { kind: "occurrence", expectedId: "pending", durableRef: { kind: "delivery", storageProjectId: "proj-1", conversationId: "conv-1", deliveryId: "pending-1" } },
    { kind: "occurrence", expectedId: "missing", durableRef: { kind: "delivery", storageProjectId: "proj-1", conversationId: "conv-1", deliveryId: "absent" } },
    { kind: "occurrence", expectedId: "wrong-kind", durableRef: { kind: "duty", id: "duty-1" } },
    { kind: "occurrence", expectedId: "declared-only" },
  ]);
  assert.equal(facts.ok.status, "success");
  assert.equal(facts.ok.at, at);
  assert.equal(facts.ok.source, "delivery:conv-1:delivered-1");
  assert.equal(facts.bad.status, "failed");
  assert.equal(facts.pending.status, "pending");
  assert.equal(facts.missing, undefined);
  assert.equal(facts["wrong-kind"], undefined);
  assert.equal(facts["declared-only"], undefined);
});

test("durable facts cover duty, task, discussion and artifact objects", async (t) => {
  const { resolveDurableFacts } = await import("./la6-acceptance-ledger.mjs");
  const home = fixture(t);
  const at = "2026-09-21T09:00:00.000Z";
  fs.mkdirSync(path.join(home, "long-agents", "friend"), { recursive: true });
  fs.writeFileSync(path.join(home, "long-agents", "friend", "duties.json"), JSON.stringify({ schemaVersion: 1, duties: [
    { id: "duty-1", updatedAt: at, progress: [{ id: "p1", applied: false, at }, { id: "p2", applied: true, at }], advancements: [] },
    { id: "duty-2", updatedAt: at, progress: [], advancements: [{ advancementKey: "a1", status: "failed", at }] },
  ], revisions: [] }));
  fs.writeFileSync(path.join(home, "long-agents", "friend", "tasks.json"), JSON.stringify({ schemaVersion: 1, tasks: [], revisions: [], occurrences: [
    { id: "occ-1", taskId: "task-1", state: "started", workId: "work-11111111111111111111111111111111", receivedAt: at, scheduledAt: at },
    { id: "occ-2", taskId: "task-1", state: "skipped", receivedAt: at, scheduledAt: at },
  ], migration: "complete" }));
  fs.mkdirSync(path.join(home, "runtime"), { recursive: true });
  fs.writeFileSync(path.join(home, "runtime", "long-agent-state.json"), JSON.stringify({ schemaVersion: 5, works: [], dailySessions: [], projectBindings: [], projectAgents: [], bindings: [], pendingEvents: [], processedEvents: [], turns: [
    { turnId: "turn-1", workId: "work-11111111111111111111111111111111", status: "completed", sequence: 1, acceptedAt: at, settledAt: "2026-09-21T10:00:00.000Z" },
  ] }));
  fs.writeFileSync(path.join(home, "long-agents", "friend", "artifacts.json"), JSON.stringify({ schemaVersion: 1, artifacts: [
    { id: "art-1", state: "committed", updatedAt: at },
    { id: "art-2", state: "failed", updatedAt: at },
  ] }));
  const conv = path.join(home, "projects", "a", "conversations", "conv-1");
  fs.mkdirSync(conv, { recursive: true });
  fs.writeFileSync(path.join(conv, "discussions.json"), JSON.stringify({ schemaVersion: 1, discussions: [
    { discussionId: "d-1", status: "completed", updatedAt: at },
    { discussionId: "d-2", status: "failed", updatedAt: at },
  ] }));

  const facts = await resolveDurableFacts(home, [
    { kind: "occurrence", expectedId: "duty-ok", durableRef: { kind: "duty", longAgentId: "friend", dutyId: "duty-1" } },
    { kind: "occurrence", expectedId: "duty-specific", durableRef: { kind: "duty", longAgentId: "friend", dutyId: "duty-1", progressEntryId: "p1" } },
    { kind: "occurrence", expectedId: "duty-failed", durableRef: { kind: "duty", longAgentId: "friend", dutyId: "duty-2" } },
    { kind: "occurrence", expectedId: "task-run", durableRef: { kind: "task", longAgentId: "friend", taskId: "task-1", occurrenceId: "occ-1" } },
    { kind: "occurrence", expectedId: "task-skip", durableRef: { kind: "task", longAgentId: "friend", taskId: "task-1", occurrenceId: "occ-2" } },
    { kind: "occurrence", expectedId: "artifact-ok", durableRef: { kind: "artifact", longAgentId: "friend", artifactId: "art-1" } },
    { kind: "occurrence", expectedId: "artifact-failed", durableRef: { kind: "artifact", longAgentId: "friend", artifactId: "art-2" } },
    { kind: "occurrence", expectedId: "discussion-ok", durableRef: { kind: "discussion", storageProjectId: "a", conversationId: "conv-1", discussionId: "d-1" } },
    { kind: "occurrence", expectedId: "discussion-failed", durableRef: { kind: "discussion", storageProjectId: "a", conversationId: "conv-1", discussionId: "d-2" } },
    { kind: "occurrence", expectedId: "unknown", durableRef: { kind: "payroll", id: "x" } },
  ]);
  assert.equal(facts["duty-ok"].status, "success");
  assert.equal(facts["duty-ok"].source, "duty:duty-1:progress:p2");
  assert.equal(facts["duty-specific"], undefined, "an unaplied progress entry is not a durable success");
  assert.equal(facts["duty-failed"].status, "failed");
  assert.equal(facts["task-run"].status, "success");
  assert.equal(facts["task-run"].at, "2026-09-21T10:00:00.000Z", "success uses the work turn's completion time");
  assert.equal(facts["task-skip"].status, "skipped");
  assert.equal(facts["artifact-ok"].status, "success");
  assert.equal(facts["artifact-failed"].status, "failed");
  assert.equal(facts["discussion-ok"].status, "success");
  assert.equal(facts["discussion-failed"].status, "failed");
  assert.equal(facts.unknown, undefined);

  // An approved skip is verified by a skipped durable occurrence, never by a bare success string.
  const expected = windowsFor("2026-09-21").map((window) => window.id);
  initLedger(home, { startedAt: "2026-09-21T05:00:00.000Z", timeZone: "UTC", expected, maxSampleGapMs: 8 * 60 * 60 * 1000 });
  for (const iso of ["2026-09-21T06:00:00.000Z", "2026-09-21T12:00:00.000Z", "2026-09-21T18:00:00.000Z", "2026-09-21T23:00:00.000Z", "2026-09-22T06:00:00.000Z"]) {
    appendSample(home, new Date(iso), { backend: true, nano: true });
  }
  for (const id of expected) appendRecord(home, { kind: "occurrence", expectedId: id, outcome: id === expected[0] ? "approved-skip" : "success" }, new Date(at));
  const verifiedFacts = Object.fromEntries(expected.map((id) => [id, { status: "success", at, source: `delivery:${id}` }]));
  verifiedFacts[expected[0]] = facts["task-skip"];
  const verified = evaluateLedger(readLedger(home), new Date("2026-09-22T06:30:00.000Z"), { requireVerified: true, verifiedFacts });
  assert.equal(verified.passed, true, JSON.stringify(verified.reasons));
  const wrongFact = evaluateLedger(readLedger(home), new Date("2026-09-22T06:30:00.000Z"), {
    requireVerified: true, verifiedFacts: { ...verifiedFacts, [expected[0]]: { status: "success", at, source: "delivery:x" } },
  });
  assert.equal(wrongFact.passed, false, "a skipped occurrence cannot be proven by a success fact");
});

test("the durable occurrence export links expected occurrences to real objects", async (t) => {
  const { collectDurableOccurrences, resolveDurableFacts } = await import("./la6-acceptance-ledger.mjs");
  const home = fixture(t);
  const at = "2026-09-21T09:00:00.000Z";
  const outOfWindow = "2026-09-20T09:00:00.000Z";
  fs.mkdirSync(path.join(home, "long-agents", "friend"), { recursive: true });
  fs.writeFileSync(path.join(home, "long-agents", "friend", "duties.json"), JSON.stringify({ schemaVersion: 1, duties: [
    { id: "duty-1", updatedAt: at, progress: [{ id: "p1", applied: true, at }], advancements: [{ advancementKey: "a1", status: "failed", at: outOfWindow }] },
  ], revisions: [] }));
  fs.writeFileSync(path.join(home, "long-agents", "friend", "tasks.json"), JSON.stringify({ schemaVersion: 1, tasks: [], revisions: [], occurrences: [
    { id: "occ-1", taskId: "task-1", state: "started", workId: "work-11111111111111111111111111111111", receivedAt: at, scheduledAt: at },
    { id: "occ-2", taskId: "task-1", state: "skipped", receivedAt: at, scheduledAt: at },
  ], migration: "complete" }));
  fs.mkdirSync(path.join(home, "runtime"), { recursive: true });
  fs.writeFileSync(path.join(home, "runtime", "long-agent-state.json"), JSON.stringify({ schemaVersion: 5, works: [], dailySessions: [], projectBindings: [], projectAgents: [], bindings: [], pendingEvents: [], processedEvents: [], turns: [
    { turnId: "turn-1", workId: "work-11111111111111111111111111111111", status: "completed", sequence: 1, acceptedAt: at, settledAt: "2026-09-21T10:00:00.000Z" },
  ] }));
  fs.writeFileSync(path.join(home, "long-agents", "friend", "artifacts.json"), JSON.stringify({ schemaVersion: 1, artifacts: [{ id: "art-1", state: "committed", updatedAt: at }] }));
  const conv = path.join(home, "projects", "a", "conversations", "conv-1");
  fs.mkdirSync(conv, { recursive: true });
  fs.writeFileSync(path.join(conv, "discussions.json"), JSON.stringify({ schemaVersion: 1, discussions: [{ discussionId: "d-1", status: "completed", updatedAt: at }] }));
  fs.writeFileSync(path.join(conv, "deliveries.json"), JSON.stringify({ schemaVersion: 1, revisions: [], deliveries: [{ deliveryId: "cdel-1", status: "delivered", updatedAt: at }] }));

  const occurrences = await collectDurableOccurrences(home, { from: "2026-09-21T00:00:00.000Z", to: "2026-09-22T00:00:00.000Z" });
  const kinds = new Set(occurrences.map((entry) => entry.kind));
  assert.deepEqual([...kinds].sort(), ["artifact", "delivery", "discussion", "duty", "task"]);
  const taskStatuses = occurrences.filter((entry) => entry.kind === "task").map((entry) => entry.status).sort();
  assert.deepEqual(taskStatuses, ["skipped", "success"]);
  for (const kind of ["duty", "artifact", "discussion", "delivery"]) {
    assert.equal(occurrences.find((entry) => entry.kind === kind)?.status, "success", kind);
  }
  // The out-of-window failed advancement is not part of this run.
  assert.equal(occurrences.some((entry) => entry.source.includes("advancement")), false);

  // The export and the verifier agree: each exported ref resolves back to the exported status.
  const facts = await resolveDurableFacts(home, occurrences.map((entry) => ({ kind: "occurrence", expectedId: entry.expectedId, durableRef: entry.durableRef })));
  for (const entry of occurrences) {
    assert.equal(facts[entry.expectedId]?.status, entry.status, `${entry.expectedId} resolves to its exported status`);
  }
});

test("a dispatched task occurrence is not success until the work turn completes", async (t) => {
  const { collectDurableOccurrences, resolveDurableFacts } = await import("./la6-acceptance-ledger.mjs");
  const home = fixture(t);
  const at = "2026-09-21T09:00:00.000Z";
  const workId = "work-22222222222222222222222222222222";
  fs.mkdirSync(path.join(home, "long-agents", "friend"), { recursive: true });
  fs.mkdirSync(path.join(home, "runtime"), { recursive: true });
  fs.writeFileSync(path.join(home, "long-agents", "friend", "tasks.json"), JSON.stringify({ schemaVersion: 1, tasks: [], revisions: [], occurrences: [
    { id: "occ-run", taskId: "task-1", state: "started", workId, receivedAt: at, scheduledAt: at },
    { id: "occ-started", taskId: "task-1", state: "started", workId: null, receivedAt: at, scheduledAt: at },
  ], migration: "complete" }));
  const stateFile = (turns) => fs.writeFileSync(path.join(home, "runtime", "long-agent-state.json"), JSON.stringify({ schemaVersion: 5, works: [], dailySessions: [], projectAgents: [], bindings: [], pendingEvents: [], processedEvents: [], turns }));
  const refs = [
    { kind: "occurrence", expectedId: "run", durableRef: { kind: "task", longAgentId: "friend", taskId: "task-1", occurrenceId: "occ-run" } },
    { kind: "occurrence", expectedId: "started", durableRef: { kind: "task", longAgentId: "friend", taskId: "task-1", occurrenceId: "occ-started" } },
  ];

  // Work still running: `started` must not be reported as success anywhere.
  stateFile([{ turnId: "turn-1", workId, status: "running", sequence: 1, acceptedAt: at, settledAt: null }]);
  const running = await resolveDurableFacts(home, refs);
  assert.equal(running.run.status, "pending", "a running work is not success");
  const runningExport = await collectDurableOccurrences(home, { from: "2026-09-21T00:00:00.000Z", to: "2026-09-22T00:00:00.000Z" });
  assert.equal(runningExport.filter((entry) => entry.expectedId.endsWith("occ-run")).every((entry) => entry.status !== "success"), true);

  // No work dispatched at all: `started` is still not success.
  assert.equal((await resolveDurableFacts(home, refs)).started.status, "pending");

  // Terminal work with a completion time: now it is success, and the exported fact agrees.
  stateFile([{ turnId: "turn-1", workId, status: "completed", sequence: 1, acceptedAt: at, settledAt: "2026-09-21T10:30:00.000Z" }]);
  const completed = await resolveDurableFacts(home, refs);
  assert.equal(completed.run.status, "success");
  assert.equal(completed.run.at, "2026-09-21T10:30:00.000Z");
  const exported = (await collectDurableOccurrences(home, { from: "2026-09-21T00:00:00.000Z", to: "2026-09-22T00:00:00.000Z" })).find((entry) => entry.expectedId.endsWith("occ-run"));
  assert.equal(exported.status, "success");
  assert.equal(exported.at, "2026-09-21T10:30:00.000Z");

  // A failed work is a failed fact, not success.
  stateFile([{ turnId: "turn-1", workId, status: "failed", sequence: 1, acceptedAt: at, settledAt: "2026-09-21T10:30:00.000Z" }]);
  assert.equal((await resolveDurableFacts(home, refs)).run.status, "failed");
});

test("a later turn under the same work cannot replace the original task result", async (t) => {
  const { collectDurableOccurrences, resolveDurableFacts } = await import("./la6-acceptance-ledger.mjs");
  const home = fixture(t);
  const at = "2026-09-21T09:00:00.000Z";
  const workId = "work-33333333333333333333333333333333";
  fs.mkdirSync(path.join(home, "long-agents", "friend"), { recursive: true });
  fs.mkdirSync(path.join(home, "runtime"), { recursive: true });
  fs.writeFileSync(path.join(home, "long-agents", "friend", "tasks.json"), JSON.stringify({ schemaVersion: 1, tasks: [], revisions: [], occurrences: [
    { id: "occ-orig", taskId: "task-1", state: "started", workId, receivedAt: at, scheduledAt: at },
  ], migration: "complete" }));
  const stateFile = (turns) => fs.writeFileSync(path.join(home, "runtime", "long-agent-state.json"), JSON.stringify({ schemaVersion: 5, works: [], dailySessions: [], projectAgents: [], bindings: [], pendingEvents: [], processedEvents: [], turns }));
  const refs = [{ kind: "occurrence", expectedId: "orig", durableRef: { kind: "task", longAgentId: "friend", taskId: "task-1", occurrenceId: "occ-orig" } }];

  // Original execution failed, then another chat turn under the same work succeeded.
  stateFile([
    { turnId: "t1", workId, status: "failed", sequence: 1, acceptedAt: at, settledAt: "2026-09-21T09:10:00.000Z" },
    { turnId: "t2", workId, status: "completed", sequence: 2, acceptedAt: at, settledAt: "2026-09-21T09:20:00.000Z" },
  ]);
  const failed = await resolveDurableFacts(home, refs);
  assert.equal(failed.orig.status, "failed", "the original task result must win over a later chat turn");
  assert.equal(failed.orig.at, "2026-09-21T09:10:00.000Z");
  const exportedFailed = (await collectDurableOccurrences(home, { from: "2026-09-21T00:00:00.000Z", to: "2026-09-22T00:00:00.000Z" })).find((entry) => entry.expectedId.endsWith("occ-orig"));
  assert.equal(exportedFailed.status, "failed");

  // Original succeeded first: a later failure does not erase the original success.
  stateFile([
    { turnId: "t1", workId, status: "completed", sequence: 1, acceptedAt: at, settledAt: "2026-09-21T09:10:00.000Z" },
    { turnId: "t2", workId, status: "failed", sequence: 2, acceptedAt: at, settledAt: "2026-09-21T09:20:00.000Z" },
  ]);
  assert.equal((await resolveDurableFacts(home, refs)).orig.status, "success");
});

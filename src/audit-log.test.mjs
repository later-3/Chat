import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { appendChatAuditEvent } from "./audit-log.ts";

test("audit log appends versioned JSONL management facts", async (t) => {
  const chatHome = await mkdtemp(resolve(tmpdir(), "chat-audit-"));
  t.after(() => rm(chatHome, { recursive: true, force: true }));
  await Promise.all([
    appendChatAuditEvent({ action: "memory.create", target: { type: "personal" } }, chatHome),
    appendChatAuditEvent({ action: "project.trust", target: { type: "project", projectId: "chat" } }, chatHome),
  ]);
  const events = (await readFile(resolve(chatHome, "logs", "audit.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.schemaVersion === 1 && event.actor === "local-user"));
});

import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { projectNavigationTree } from "../src/session-tree-projection.ts";

test("browser tree keeps all branch identities and labels without copying message bodies", () => {
  const session = SessionManager.inMemory("/tmp");
  const root = session.appendMessage({ role: "user", content: "question", timestamp: Date.now() });
  session.appendCustomEntry("large-config", { content: "x".repeat(1_000_000) });
  const a = session.appendMessage({ role: "assistant", content: [{ type: "text", text: "answer A" }], timestamp: Date.now() });
  session.branch(root);
  const b = session.appendMessage({ role: "assistant", content: [{ type: "text", text: "answer B" }], timestamp: Date.now() });
  session.appendLabelChange(b, "Branch B");
  const tree = projectNavigationTree(session.getTree());
  const ids = [];
  const walk = nodes => nodes.forEach(node => { ids.push(node.entry.id, ...node.compressedEntryIds); walk(node.children); });
  walk(tree);
  for (const entry of session.getEntries()) assert.ok(ids.includes(entry.id));
  assert.ok(ids.includes(a) && ids.includes(b));
  assert.ok(JSON.stringify(tree).length < 3_000);
  assert.match(JSON.stringify(tree), /Branch B/);
  assert.equal(session.getEntries().find(entry => entry.type === "custom").data.content.length, 1_000_000);
});

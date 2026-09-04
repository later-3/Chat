import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkflowAgentDefinition } from "./agent-config.ts";
import { defineChatWorkflow, parseChatWorkflowManifest } from "./framework.ts";

const agent = parseWorkflowAgentDefinition({
  schemaVersion: 1,
  id: "worker",
  name: "Worker",
  description: "Works",
  systemPrompt: { mode: "pi-default" },
  customInstructions: [],
  tools: { mode: "none" },
});

const manifest = {
  schemaVersion: 1,
  id: "framework-test",
  name: "Framework Test",
  description: "Tests both node kinds",
  agentCallable: true,
  planReview: false,
  nodes: [
    { kind: "task", id: "prepare", name: "Prepare", description: "Prepare input" },
    { kind: "agent", id: "execute", name: "Execute", description: "Run agent", agentId: "worker" },
  ],
  agents: [{ id: "worker", config: "./agents/worker/agent.json" }],
};

test("Workflow framework accepts task and Agent nodes and preserves config paths", () => {
  const definition = defineChatWorkflow({
    manifest: parseChatWorkflowManifest(manifest, "framework-test"),
    agents: [agent],
    run: async () => ({ text: "done", sessionId: "session", sessionFile: "file", model: null }),
  });
  assert.deepEqual(definition.nodes.map((node) => node.kind), ["task", "agent"]);
  assert.equal(definition.agentConfigPaths.worker, "./agents/worker/agent.json");
  assert.equal(definition.agentCallable, true);
  assert.equal(definition.planReview, false);
});

test("Workflow framework defaults invocation capabilities closed and validates their types", () => {
  const parsed = parseChatWorkflowManifest({
    ...manifest,
    agentCallable: undefined,
    planReview: undefined,
  }, "framework-test");
  assert.equal(parsed.agentCallable, false);
  assert.equal(parsed.planReview, false);
  assert.throws(
    () => parseChatWorkflowManifest({ ...manifest, agentCallable: "yes" }, "framework-test"),
    /agentCallable必须是布尔值/,
  );
});

test("Workflow framework rejects unknown Agent references and duplicate Nodes", () => {
  assert.throws(
    () => defineChatWorkflow({
      manifest: parseChatWorkflowManifest({
        ...manifest,
        nodes: [{ kind: "agent", id: "execute", name: "Execute", description: "", agentId: "missing" }],
      }, "framework-test"),
      agents: [agent],
      run: async () => ({ text: "", sessionId: "", sessionFile: "", model: null }),
    }),
    /引用不存在的Agent: missing/,
  );
  assert.throws(
    () => defineChatWorkflow({
      manifest: parseChatWorkflowManifest({
        ...manifest,
        nodes: [manifest.nodes[1], manifest.nodes[1]],
      }, "framework-test"),
      agents: [agent],
      run: async () => ({ text: "", sessionId: "", sessionFile: "", model: null }),
    }),
    /重复Node: execute/,
  );
});

import { randomUUID } from "node:crypto";
import { acceptedRunRuntime } from "../../src/workflows/accepted-run-runtime.ts";
import { getChatWorkflowDefinition } from "../../src/workflows/registry.ts";

/** Domain tests execute the production Workflow body + Pi against the local model. Only the SDK
 * transport is replaced; Nitro/production/browser tests exercise the real transport separately. */
export function installWorkflowTransport(t) {
  const runs = new Map();
  t.mock.method(acceptedRunRuntime, "start", async (input, options) => {
    const runId = `wrun_unit_${randomUUID()}`;
    const workflowInvocationId = options.workflowInvocationId;
    await options.onRunBound(runId);
    const { workflow, ...rest } = input;
    const result = Promise.resolve().then(() => getChatWorkflowDefinition(workflow).run({ ...rest, workflowInvocationId }));
    void result.catch(() => {});
    runs.set(runId, result);
    return { run: { runId }, workflow, workflowInvocationId };
  });
  t.mock.method(acceptedRunRuntime, "result", async id => {
    if (!runs.has(id)) throw new Error(`In-process SDK fixture has no run ${id}`);
    return runs.get(id);
  });
  t.mock.method(acceptedRunRuntime, "cancel", async () => {});
}

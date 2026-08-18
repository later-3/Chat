import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowRuntimeTraceHttpClient } from "./workflow-runtime-trace-client.js";

afterEach(() => vi.unstubAllGlobals());

describe("Workflow Runtime Trace HTTP Client", () => {
  it("validates the runtime projection and sends only Product Run identity", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          schemaVersion: "chat-workflow-runtime-trace.v1",
          productRunId: "run_client1",
          sourceKind: "vercel_workflow",
          availability: "pending",
          reason: "not_started",
          refreshAfterMs: 750,
          refreshedAt: "2026-08-17T08:00:00.000Z",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new WorkflowRuntimeTraceHttpClient({
      workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
      credential: "rtk_test",
    });
    await expect(client.read({ productRunId: "run_client1" as never })).resolves.toMatchObject({
      availability: "pending",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:43112/internal/workflow/v1/runs/run_client1/trace",
      expect.objectContaining({ headers: { "x-chat-runtime-key": "rtk_test" } }),
    );
  });

  it("fails closed when the runtime is offline or leaks an invalid shape", async () => {
    const client = new WorkflowRuntimeTraceHttpClient({
      workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
      credential: "rtk_test",
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(client.read({ productRunId: "run_client1" as never })).rejects.toMatchObject({
      code: "internal_error",
      httpStatus: 503,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ workflowRunId: "wrun_private" }))),
    );
    await expect(client.read({ productRunId: "run_client1" as never })).rejects.toMatchObject({
      code: "internal_error",
      httpStatus: 503,
    });
  });
});

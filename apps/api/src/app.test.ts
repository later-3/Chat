import { problemDetailSchema, serviceStatusSchema } from "@chat/contracts";
import { describe, expect, it } from "vitest";
import { createApiApp } from "./app.js";

describe("chat api skeleton", () => {
  const app = createApiApp();

  it("GET /api/healthz 返回合同形状并回显requestId", async () => {
    const res = await app.request("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toMatch(/^req_/);
    expect(serviceStatusSchema.parse(await res.json()).status).toBe("ok");
  });

  it("未知路由返回Problem Detail错误族", async () => {
    const res = await app.request("/api/nope", {
      headers: { "x-request-id": "req_test-1" },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("x-request-id")).toBe("req_test-1");
    const problem = problemDetailSchema.parse(await res.json());
    expect(problem.code).toBe("not_found");
    expect(problem.retryable).toBe(false);
  });
});

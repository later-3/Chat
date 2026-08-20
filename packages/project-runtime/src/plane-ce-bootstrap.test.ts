import { describe, expect, it, vi } from "vitest";
import { projectBootstrapOperationIdSchema, type ProjectBootstrapProposal } from "@chat/contracts";
import { PlaneCeProjectBootstrap, createPlaneCeProjectBootstrap } from "./plane-ce-bootstrap.js";

const projectId = "66cf0460-84e0-4d3d-b1ef-d193b83b7562";
const moduleId = "15a02252-87e1-4b5e-98bc-7bccb775d0fe";
const sha256 = "b".repeat(64);
const operationId = projectBootstrapOperationIdSchema.parse("pbo_create1");

function proposal(): ProjectBootstrapProposal {
  return {
    name: "AI 学习",
    objective: "学习公开课、论文与开源项目。",
    planeWorkspaceSlug: "learning",
    planeProjectIdentifier: "AI2026",
    workspaceRootId: "root_code",
    directoryName: "ai-learning",
    initializerProfile: "ai_learning",
    initialModules: ["公开课"],
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Plane CE 1.4.1项目初始化Adapter", () => {
  it("使用受控workspace、稳定external id创建项目与Module，并能查询对账", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    fetchFn
      .mockResolvedValueOnce(json({ results: [], next_page_results: false }))
      .mockResolvedValueOnce(
        json({
          id: projectId,
          name: "AI 学习",
          identifier: "AI2026",
          external_source: "chat",
          external_id: "pbo_create1",
        }),
      )
      .mockResolvedValueOnce(json({ results: [], next_page_results: false }))
      .mockResolvedValueOnce(
        json({
          id: moduleId,
          name: "公开课",
          external_source: "chat",
          external_id: "pbo_create1:module:1",
        }),
      )
      .mockResolvedValueOnce(
        json({
          results: [
            {
              id: projectId,
              name: "AI 学习",
              identifier: "AI2026",
              external_source: "chat",
              external_id: "pbo_create1",
            },
          ],
          next_page_results: false,
        }),
      )
      .mockResolvedValueOnce(
        json({
          results: [
            {
              id: moduleId,
              name: "公开课",
              external_source: "chat",
              external_id: "pbo_create1:module:1",
            },
          ],
          next_page_results: false,
        }),
      );
    const adapter = new PlaneCeProjectBootstrap({
      baseUrl: new URL("http://127.0.0.1:8080"),
      apiToken: "test-token",
      workspaces: [{ slug: "learning", displayName: "Learning" }],
      fetchFn,
    });
    const input = {
      operationId,
      candidateSha256: sha256,
      proposal: proposal(),
    };
    await expect(adapter.provision(input)).resolves.toEqual({
      status: "completed",
      planeProjectId: projectId,
    });
    await expect(adapter.reconcile(input)).resolves.toEqual({
      status: "completed",
      planeProjectId: projectId,
    });
    const projectCreate = fetchFn.mock.calls[1];
    expect(projectCreate?.[0].toString()).toContain("/api/v1/workspaces/learning/projects/");
    expect(JSON.parse(String(projectCreate?.[1]?.body))).toMatchObject({
      external_source: "chat",
      external_id: "pbo_create1",
      identifier: "AI2026",
      module_view: true,
    });
  });

  it("写请求断线标记outcome_unknown，拒绝非HTTPS远程地址和不完整配置", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ results: [], next_page_results: false }))
      .mockRejectedValueOnce(new Error("connection reset"));
    const adapter = new PlaneCeProjectBootstrap({
      baseUrl: new URL("http://localhost:8080"),
      apiToken: "test-token",
      workspaces: [{ slug: "learning", displayName: "Learning" }],
      fetchFn,
    });
    await expect(
      adapter.provision({
        operationId,
        candidateSha256: sha256,
        proposal: proposal(),
      }),
    ).resolves.toEqual({ status: "outcome_unknown", errorCode: "plane_ce_write_outcome_unknown" });

    expect(() =>
      createPlaneCeProjectBootstrap({
        CHAT_PLANE_CE_BASE_URL: "http://plane.internal",
        CHAT_PLANE_CE_API_TOKEN: "token",
        CHAT_PLANE_CE_WORKSPACES_JSON: '[{"slug":"learning","displayName":"Learning"}]',
      }),
    ).toThrowError();
    expect(() =>
      createPlaneCeProjectBootstrap({ CHAT_PLANE_CE_API_TOKEN: "token" }),
    ).toThrowError();
  });
});

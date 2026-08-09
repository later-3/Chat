import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RulesPanel } from "./RulesPanel.js";

const mocks = vi.hoisted(() => ({
  listRules: vi.fn(),
  listTags: vi.fn(),
  getRule: vi.fn(),
}));

vi.mock("../api/client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api/client.js")>();
  return {
    ...original,
    apiListRules: mocks.listRules,
    apiListRuleTags: mocks.listTags,
    apiGetRule: mocks.getRule,
  };
});

const revisionSummary = {
  schemaVersion: "chat-rules-api.v1" as const,
  ruleRevisionId: "rrv_quality1" as never,
  revision: 1,
  sha256: "a".repeat(64) as never,
  risk: "low" as const,
  scopes: [
    {
      schemaVersion: "rule-scope.v1" as const,
      ruleScopeId: "rsc_global1" as never,
      kind: "global" as const,
    },
  ],
  tagIds: [],
  conflictsWithRuleIds: [],
  createdAt: "2026-08-10T00:00:00.000Z",
};

describe("RulesPanel", () => {
  it("列表只显示摘要，主动打开后才读取正文，并提供可访问的管理入口", async () => {
    mocks.listRules.mockResolvedValue({
      schemaVersion: "chat-rules-api.v1",
      items: [
        {
          schemaVersion: "chat-rules-api.v1",
          ruleId: "rul_quality1",
          title: "交付前验证",
          lifecycle: "trial",
          enforcement: "user_selectable",
          priority: 500,
          currentRevision: revisionSummary,
          allowedActions: ["activate", "disable", "reject", "revise"],
          revision: 2,
          createdAt: "2026-08-10T00:00:00.000Z",
          updatedAt: "2026-08-10T00:00:01.000Z",
        },
      ],
    });
    mocks.listTags.mockResolvedValue({ schemaVersion: "chat-rules-api.v1", items: [] });
    mocks.getRule.mockResolvedValue({
      schemaVersion: "chat-rules-api.v1",
      decisions: [],
      rule: {
        schemaVersion: "chat-rules-api.v1",
        ruleId: "rul_quality1",
        title: "交付前验证",
        lifecycle: "trial",
        enforcement: "user_selectable",
        priority: 500,
        currentRevision: {
          ...revisionSummary,
          ruleId: "rul_quality1",
          body: "交付前必须运行测试。",
          rationale: "完成需要证据。",
          appliesWhen: [],
          doesNotApplyWhen: [],
          positiveExamples: [],
          negativeExamples: [],
          origin: { kind: "user_authored", principalId: "usr_owner1" },
          sourceCases: [],
        },
        allowedActions: ["activate", "disable", "reject", "revise"],
        revision: 2,
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:01.000Z",
      },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <RulesPanel />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("button", { name: /交付前验证/u })).toBeTruthy();
    expect(screen.queryByText("交付前必须运行测试。")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /交付前验证/u }));
    expect(await screen.findByText("交付前必须运行测试。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "启用" })).toBeTruthy();
    expect(screen.getByLabelText("新标签名称")).toBeTruthy();
  });
});

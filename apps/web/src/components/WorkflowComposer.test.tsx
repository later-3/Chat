import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDefinitionPublishedDto } from "@chat/contracts/public";
import type { WorkflowSelectionDraft } from "../workflow/run-config-draft.js";
import { RunConfigPanel, WorkflowPicker, isSupportedComposerField } from "./WorkflowComposer.js";

const now = "2026-08-10T00:00:00.000Z";
const memoryNode = {
  definitionNodeId: "memory-context" as never,
  nodeType: "context.memory" as const,
  schemaVersion: 1,
  displayName: "读取记忆",
  optional: true,
  defaultActivation: "enabled" as const,
  publicConfigFields: [
    {
      type: "resource_selector" as const,
      name: "selection",
      label: "记忆来源",
      multiple: true,
      required: false,
    },
  ],
};
const reviewNode = {
  definitionNodeId: "plan-review" as never,
  nodeType: "human.plan_review" as const,
  schemaVersion: 1,
  displayName: "计划审核",
  optional: false,
  defaultActivation: "enabled" as const,
  publicConfigFields: [
    {
      type: "review_mode" as const,
      name: "reviewMode",
      label: "审核方式",
      defaultValue: "manual",
      options: ["manual", "auto_continue_if_policy_allows"],
    },
  ],
};
const noteExtractNode = {
  definitionNodeId: "note-extract" as never,
  nodeType: "note.extract" as const,
  schemaVersion: 1,
  displayName: "提取笔记",
  optional: false,
  defaultActivation: "enabled" as const,
  publicConfigFields: [
    {
      type: "note_source_selector" as const,
      name: "source",
      label: "笔记来源",
      multiple: false,
      required: true,
    },
    {
      type: "enum_select" as const,
      name: "defaultKind",
      label: "默认类型",
      defaultValue: "general",
      options: ["idea", "project_idea", "learning", "general"],
    },
    {
      type: "tag_list" as const,
      name: "suggestedTagLabels",
      label: "建议标签",
      maxItems: 20,
      maxLabelLength: 64,
    },
  ],
};
const noteReviewNode = {
  ...reviewNode,
  definitionNodeId: "note-review" as never,
  nodeType: "human.note_review" as const,
  displayName: "审核笔记",
};

function definition(id = "wfr_plan1", title = "系统 Planning"): WorkflowDefinitionPublishedDto {
  return {
    schemaVersion: "chat-product-api.v1",
    workflowDefinitionId: "wfd_plan1" as never,
    workflowDefinitionRevisionId: id as never,
    definitionRevision: id === "wfr_plan1" ? 1 : 2,
    title,
    description: "先整理上下文，再生成可审核计划。",
    blueprintKey: "planning",
    blueprintVersion: 1,
    definitionSha256: (id === "wfr_plan1" ? "a" : "b").repeat(64) as never,
    ownerKind: "system",
    nodes: [memoryNode, reviewNode],
    publishedAt: now,
    updatedAt: now,
  };
}

function noteDefinition(): WorkflowDefinitionPublishedDto {
  return {
    ...definition("wfr_note1", "系统 Note Capture"),
    workflowDefinitionId: "wfd_note1" as never,
    blueprintKey: "note",
    definitionSha256: "d".repeat(64) as never,
    nodes: [
      noteExtractNode,
      {
        definitionNodeId: "note-classify" as never,
        nodeType: "note.classify",
        schemaVersion: 1,
        displayName: "分类笔记",
        optional: false,
        defaultActivation: "enabled",
        publicConfigFields: [],
      },
      noteReviewNode,
      {
        definitionNodeId: "note-commit" as never,
        nodeType: "note.commit",
        schemaVersion: 1,
        displayName: "保存笔记",
        optional: false,
        defaultActivation: "enabled",
        publicConfigFields: [],
      },
    ],
  };
}

function installApi(definitions = [definition()]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json", ETag: '"composer"' },
        });
      if (url === "/api/workflow/definitions") {
        return json({ definitions: { schemaVersion: "chat-product-api.v1", definitions } });
      }
      if (url === "/api/workflow/catalog") {
        return json({
          catalog: {
            schemaVersion: "chat-product-api.v1",
            nodes: [
              {
                nodeType: "context.memory",
                schemaVersion: 1,
                displayName: "读取记忆",
                description: "选择记忆",
                category: "context",
                executorKind: "step",
                riskPolicy: "read_context",
                canDefaultSkip: true,
                supportedBlueprints: ["planning"],
                publicConfigFields: memoryNode.publicConfigFields,
                outcomes: ["success"],
              },
              {
                nodeType: "human.plan_review",
                schemaVersion: 1,
                displayName: "计划审核",
                description: "等待确认",
                category: "human",
                executorKind: "human_review",
                riskPolicy: "human_decision",
                canDefaultSkip: false,
                supportedBlueprints: ["planning"],
                publicConfigFields: reviewNode.publicConfigFields,
                outcomes: ["approved"],
              },
              {
                nodeType: "note.extract",
                schemaVersion: 1,
                displayName: "提取笔记",
                description: "生成候选",
                category: "note",
                executorKind: "step",
                riskPolicy: "generate_candidate",
                canDefaultSkip: false,
                supportedBlueprints: ["note"],
                publicConfigFields: noteExtractNode.publicConfigFields,
                outcomes: ["extracted", "no_note"],
              },
              {
                nodeType: "note.classify",
                schemaVersion: 1,
                displayName: "分类笔记",
                description: "分类候选",
                category: "note",
                executorKind: "step",
                riskPolicy: "generate_candidate",
                canDefaultSkip: false,
                supportedBlueprints: ["note"],
                publicConfigFields: [],
                outcomes: ["classified", "needs_review"],
              },
              {
                nodeType: "human.note_review",
                schemaVersion: 1,
                displayName: "审核笔记",
                description: "等待确认",
                category: "human",
                executorKind: "human_review",
                riskPolicy: "human_decision",
                canDefaultSkip: false,
                supportedBlueprints: ["note"],
                publicConfigFields: noteReviewNode.publicConfigFields,
                outcomes: ["approved", "request_revision", "rejected"],
              },
              {
                nodeType: "note.commit",
                schemaVersion: 1,
                displayName: "保存笔记",
                description: "正式提交",
                category: "commit",
                executorKind: "step",
                riskPolicy: "product_commit",
                canDefaultSkip: false,
                supportedBlueprints: ["note"],
                publicConfigFields: [],
                outcomes: ["committed", "failed"],
              },
            ],
          },
        });
      }
      if (url === "/api/workflow/blueprints") {
        return json({
          blueprints: {
            schemaVersion: "chat-product-api.v1",
            blueprints: [
              {
                schemaVersion: "chat-product-api.v1",
                blueprintKey: "planning",
                blueprintVersion: 1,
                title: "Planning",
                description: "规划",
                runnerFamily: "configurable-planning.v1",
                terminalNodeType: "product.commit",
                optionalNodeTypes: ["context.memory"],
                loopRules: [
                  {
                    outcomeNodeType: "human.plan_review",
                    continueOutcomes: ["request_revision"],
                    exitOutcomes: ["approved", "rejected"],
                    maxIterations: 5,
                  },
                ],
                perRunOverrides: [
                  { nodeType: "context.memory", fields: ["enabled", "selection"] },
                  { nodeType: "human.plan_review", fields: ["reviewMode"] },
                ],
                reviewModes: ["manual", "auto_continue_if_policy_allows"],
              },
              {
                schemaVersion: "chat-product-api.v1",
                blueprintKey: "note",
                blueprintVersion: 1,
                title: "Note Capture",
                description: "笔记捕获",
                runnerFamily: "note-capture.v1",
                terminalNodeType: "note.commit",
                optionalNodeTypes: ["human.note_review"],
                loopRules: [
                  {
                    outcomeNodeType: "human.note_review",
                    continueOutcomes: ["request_revision"],
                    exitOutcomes: ["approved", "rejected"],
                    maxIterations: 2,
                  },
                ],
                perRunOverrides: [{ nodeType: "human.note_review", fields: ["reviewMode"] }],
                reviewModes: ["manual", "auto_continue_if_policy_allows", "always_auto"],
              },
            ],
          },
        });
      }
      if (url === "/api/workflow/resources") {
        return json({
          resources: {
            schemaVersion: "chat-product-api.v1",
            resources: [
              {
                schemaVersion: "chat-product-api.v1",
                resourceKind: "memory",
                resourceId: "mem_source1",
                revision: 3,
                sha256: "c".repeat(64),
                status: "active",
                label: "项目回顾",
                source: "memmy",
              },
            ],
          },
        });
      }
      return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
    }),
  );
}

function Harness({
  stale = false,
  definitions = [definition()],
  messageText = "",
  messageSelection = null,
}: {
  readonly stale?: boolean;
  readonly definitions?: WorkflowDefinitionPublishedDto[];
  readonly messageText?: string;
  readonly messageSelection?: { readonly startUtf16: number; readonly endUtf16: number } | null;
}) {
  const [selection, setSelection] = useState<WorkflowSelectionDraft | null>(null);
  const [blocked, setBlocked] = useState(false);
  installApi(definitions);
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <WorkflowPicker value={selection} disabled={false} onChange={setSelection} />
      <RunConfigPanel
        selection={selection}
        messageText={messageText}
        messageSelection={messageSelection}
        disabled={false}
        stale={stale}
        onChange={setSelection}
        onBlockedChange={setBlocked}
      />
      <output aria-label="配置是否被阻止">{String(blocked)}</output>
      <output aria-label="选择摘要">
        {selection === null ? "none" : JSON.stringify(selection)}
      </output>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Workflow Composer", () => {
  it("默认选择系统Planning，并提交有限Memory与审核选择", async () => {
    render(<Harness />);
    await screen.findByDisplayValue(/系统 Planning/u);
    expect(screen.getByText("本次运行配置")).toBeTruthy();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: /项目回顾/u }));
    await user.selectOptions(screen.getByLabelText("审核方式"), "auto_continue_if_policy_allows");
    await waitFor(() =>
      expect(screen.getByLabelText("选择摘要").textContent).toContain("mem_source1"),
    );
    const payload = screen.getByLabelText("选择摘要").textContent ?? "";
    expect(payload).toContain("workflow-run-configuration.v1");
    expect(payload).not.toContain("secret");
  });

  it("可改选另一个已发布Definition", async () => {
    render(<Harness definitions={[definition(), definition("wfr_plan2", "团队 Planning")]} />);
    const user = userEvent.setup();
    await screen.findByDisplayValue(/系统 Planning/u);
    await user.selectOptions(screen.getByLabelText("选择规划工作流"), "wfr_plan2");
    await waitFor(() =>
      expect(screen.getByLabelText("选择摘要").textContent).toContain("wfr_plan2"),
    );
  });

  it("Note选择显式提交full message、kind与建议标签，切回Planning清除Note输入", async () => {
    render(<Harness definitions={[definition(), noteDefinition()]} messageText="项目新想法" />);
    const user = userEvent.setup();
    await screen.findByDisplayValue(/系统 Planning/u);
    await user.selectOptions(screen.getByLabelText("选择规划工作流"), "wfr_note1");
    await user.selectOptions(screen.getByLabelText("默认 Note 类型"), "project_idea");
    await user.type(screen.getByLabelText("Note 建议标签"), "项目,路线");
    await waitFor(() => {
      const payload = screen.getByLabelText("选择摘要").textContent ?? "";
      expect(payload).toContain('"kind":"note_capture"');
      expect(payload).toContain('"source":{"kind":"full_message"}');
      expect(payload).toContain('"defaultKind":"project_idea"');
      expect(payload).toContain('"suggestedTagLabels":["项目","路线"]');
    });
    await user.selectOptions(screen.getByLabelText("选择规划工作流"), "wfr_plan1");
    expect(screen.getByLabelText("选择摘要").textContent).not.toContain("businessInput");
  });

  it("Note复用消息输入框选区并冻结UTF-16范围与原文SHA", async () => {
    render(
      <Harness
        definitions={[definition(), noteDefinition()]}
        messageText="A😀项目B"
        messageSelection={{ startUtf16: 1, endUtf16: 3 }}
      />,
    );
    const user = userEvent.setup();
    await screen.findByDisplayValue(/系统 Planning/u);
    await user.selectOptions(screen.getByLabelText("选择规划工作流"), "wfr_note1");
    await user.click(screen.getByRole("radio", { name: "消息输入框当前选区" }));
    await waitFor(() => {
      const payload = screen.getByLabelText("选择摘要").textContent ?? "";
      expect(payload).toContain('"source":{"kind":"selection","startUtf16":1,"endUtf16":3');
      expect(payload).toMatch(/"selectedTextSha256":"[a-f0-9]{64}"/u);
    });
  });

  it("没有有效选区时不能误切为selection或发送伪范围", async () => {
    render(
      <Harness
        definitions={[definition(), noteDefinition()]}
        messageText="A😀项目B"
        messageSelection={{ startUtf16: 1, endUtf16: 2 }}
      />,
    );
    const user = userEvent.setup();
    await screen.findByDisplayValue(/系统 Planning/u);
    await user.selectOptions(screen.getByLabelText("选择规划工作流"), "wfr_note1");
    await user.click(screen.getByRole("radio", { name: "消息输入框当前选区" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/完整文字/u);
    expect((screen.getByRole("radio", { name: "完整消息" }) as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it("stale草稿保留但禁止编辑和发送前使用", async () => {
    render(<Harness stale />);
    expect(await screen.findByText(/版本已变化/u)).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /启用此可选步骤/u }).hasAttribute("disabled")).toBe(
      true,
    );
    await waitFor(() => expect(screen.getByLabelText("配置是否被阻止").textContent).toBe("true"));
  });

  it("未知未来字段不走通用编辑器", () => {
    expect(isSupportedComposerField({ type: "provider_secret", name: "token" })).toBe(false);
    expect(isSupportedComposerField({ type: "review_mode" })).toBe(true);
    expect(isSupportedComposerField({ type: "note_source_selector" })).toBe(true);
    expect(isSupportedComposerField({ type: "tag_list" })).toBe(true);
  });
});

import { createEmptySnapshot, type PromptFragmentRevision } from "@chat/contracts";
import { computePromptFragmentRevisionSha256 } from "@chat/domain";
import { describe, expect, it } from "vitest";
import type { ApplicationDeps } from "./deps.js";
import {
  previewDirectPromptAssembly,
  previewDirectPromptConfiguration,
} from "./prompt-assembly-use-cases.js";

const NOW = "2026-08-20T00:00:00.000Z";
const SHA = "a".repeat(64);

function region(
  regionKey: string,
  title: string,
  plannedPlacement: "system" | "messages",
  stableOrder: number,
) {
  return {
    schemaVersion: "chat-prompt-studio-api.v1" as const,
    regionKey,
    title,
    description: `${title}说明`,
    category: plannedPlacement === "system" ? ("identity" as const) : ("context" as const),
    plannedPlacement,
    contentKind: "markdown" as const,
    cardinality: "multiple" as const,
    userManageable: true,
    availability: "active" as const,
    stableOrder,
    catalogRevision: 1,
    sha256: SHA as never,
    sourceRelativePath: "prompts/regions/catalog.md",
  };
}

function revision(input: {
  id: string;
  fragmentId: string;
  regionKey: string;
  title: string;
  body: string;
}): PromptFragmentRevision {
  const body = {
    promptFragmentId: input.fragmentId as never,
    revision: 1,
    regionKey: input.regionKey,
    title: input.title,
    content: { kind: "markdown" as const, bodyMarkdown: input.body },
    authoredByPrincipalId: "usr_promptassembly" as never,
  };
  return {
    schemaVersion: "prompt-fragment-revision.v1",
    promptFragmentRevisionId: input.id as never,
    ...body,
    sha256: computePromptFragmentRevisionSha256(body) as never,
    createdAt: NOW,
  };
}

function fixture(): {
  deps: ApplicationDeps;
  globalRevision: PromptFragmentRevision;
  workspaceRevision: PromptFragmentRevision;
} {
  const snapshot = createEmptySnapshot(NOW);
  const globalRevision = revision({
    id: "pfr_globalbackground1",
    fragmentId: "pfg_globalbackground",
    regionKey: "background",
    title: "全局背景",
    body: "全局背景正文",
  });
  const workspaceRevision = revision({
    id: "pfr_workspacerules1",
    fragmentId: "pfg_workspacerules",
    regionKey: "rules",
    title: "Chat 工作区规则",
    body: "工作区规则正文",
  });
  snapshot.entities.promptFragmentRevisions[globalRevision.promptFragmentRevisionId] =
    globalRevision;
  snapshot.entities.promptFragmentRevisions[workspaceRevision.promptFragmentRevisionId] =
    workspaceRevision;
  snapshot.entities.promptFragments[globalRevision.promptFragmentId] = {
    schemaVersion: "prompt-fragment.v1",
    promptFragmentId: globalRevision.promptFragmentId,
    ownerPrincipalId: "usr_promptassembly" as never,
    scope: { kind: "global" },
    status: "active",
    currentRevisionId: globalRevision.promptFragmentRevisionId,
    currentRevisionNumber: 1,
    currentRevisionSha256: globalRevision.sha256,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.promptFragments[workspaceRevision.promptFragmentId] = {
    schemaVersion: "prompt-fragment.v1",
    promptFragmentId: workspaceRevision.promptFragmentId,
    ownerPrincipalId: "usr_promptassembly" as never,
    scope: { kind: "workspace", rootId: "root_chat" },
    status: "active",
    currentRevisionId: workspaceRevision.promptFragmentRevisionId,
    currentRevisionNumber: 1,
    currentRevisionSha256: workspaceRevision.sha256,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const deps = {
    store: {
      read: async () => ({ snapshot: structuredClone(snapshot) }),
      transact: async () => {
        throw new Error("测试不写Store");
      },
    },
    now: () => NOW,
    ids: {},
    promptCatalog: {
      load: async () => ({
        catalogSha256: SHA,
        regions: [
          region("agent_identity", "Agent 身份", "system", 10),
          region("background", "背景", "messages", 20),
          region("rules", "规则", "messages", 30),
        ],
        builtinFragments: [
          {
            promptFragmentId: "pfg_builtinagentidentity" as never,
            promptFragmentRevisionId: "pfr_builtinagentidentityv2" as never,
            revision: 2,
            regionKey: "agent_identity",
            title: "通用身份",
            content: { kind: "markdown" as const, bodyMarkdown: "你是Chat Agent。" },
            sha256: SHA,
            sourceRelativePath: "prompts/fragments/agent-identity/general-chat-agent.md",
            createdAt: NOW,
          },
        ],
      }),
    },
    projectRoots: {
      list: () => [
        {
          rootId: "root_chat",
          displayName: "Chat 工作区",
          enabledAdapters: ["local-git-workspace.v1" as const],
        },
      ],
      observe: async () => {
        throw new Error("测试不观察Workspace");
      },
    },
  } as unknown as ApplicationDeps;
  return { deps, globalRevision, workspaceRevision };
}

describe("Direct Prompt Assembly", () => {
  it("每个Region独立执行default/replace/append并保留全局与Workspace精确来源", async () => {
    const { deps, globalRevision, workspaceRevision } = fixture();
    const preview = await previewDirectPromptAssembly(deps, {
      principalId: "usr_promptassembly" as never,
      text: "这是一个什么项目？",
      selection: {
        schemaVersion: "prompt-turn-selection-input.v1",
        workspaceRootId: "root_chat",
        regions: [
          {
            regionKey: "background",
            mode: "replace",
            selected: [
              {
                promptFragmentRevisionId: globalRevision.promptFragmentRevisionId,
                sha256: globalRevision.sha256,
              },
            ],
          },
          {
            regionKey: "rules",
            mode: "append",
            selected: [
              {
                promptFragmentRevisionId: workspaceRevision.promptFragmentRevisionId,
                sha256: workspaceRevision.sha256,
              },
            ],
          },
        ],
      },
    });

    expect(preview.regions.map((item) => [item.regionKey, item.mode])).toEqual([
      ["agent_identity", "default"],
      ["background", "replace"],
      ["rules", "append"],
    ]);
    expect(preview.systemPromptAppend).toContain("你是Chat Agent");
    expect(preview.userPrompt).toContain("全局背景正文");
    expect(preview.userPrompt).toContain("工作区规则正文");
    expect(preview.userPrompt).toContain("这是一个什么项目？");
    expect(preview.regions[2]?.fragments[0]?.scope).toEqual({
      kind: "workspace",
      rootId: "root_chat",
    });

    const configuration = await previewDirectPromptConfiguration(deps, {
      principalId: "usr_promptassembly" as never,
      selection: {
        schemaVersion: "prompt-turn-selection-input.v1",
        workspaceRootId: "root_chat",
        regions: [],
      },
    });
    expect(configuration.systemPromptAppend).toContain("你是Chat Agent");
    expect(configuration.messageContext).toBe("");
    expect(JSON.stringify(configuration)).not.toContain("当前输入");
  });

  it("拒绝把其他Workspace组件选入当前会话", async () => {
    const { deps, workspaceRevision } = fixture();
    await expect(
      previewDirectPromptAssembly(deps, {
        principalId: "usr_promptassembly" as never,
        text: "检查",
        selection: {
          schemaVersion: "prompt-turn-selection-input.v1",
          regions: [
            {
              regionKey: "rules",
              mode: "replace",
              selected: [
                {
                  promptFragmentRevisionId: workspaceRevision.promptFragmentRevisionId,
                  sha256: workspaceRevision.sha256,
                },
              ],
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

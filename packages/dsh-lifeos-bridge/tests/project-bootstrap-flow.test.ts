import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProjectBootstrapSessionProjection } from "@chat/contracts/public";
import { stableCommandId } from "../src/adapter.ts";
import { LifeosBridgeService } from "../src/bridge-service.ts";
import type { ChatProductClient } from "../src/chat-client.ts";
import { AtomicBridgeStateStore } from "../src/state-store.ts";

const dshSessionId = "dsh-project-bootstrap";
const productSessionId = "psn_projectbootstrap1";
const candidateId = "pbc_projectbootstrap1";
const operationId = "pbo_projectbootstrap1";
const candidateSha256 = "a".repeat(64);
const timestamp = "2026-08-21T00:00:00.000Z";

function preparedProjection(): ProjectBootstrapSessionProjection {
  return {
    candidate: {
      schemaVersion: "project-bootstrap.v1",
      projectBootstrapCandidateId: candidateId as never,
      ownerPrincipalId: "usr_debug" as never,
      sourceProductSessionId: productSessionId as never,
      sourceProductRunId: "run_projectbootstrap1" as never,
      proposal: {
        name: "AI学习",
        objective: "学习公开课程、论文和开源项目，并形成自己的实践项目。",
        planeWorkspaceSlug: "learning",
        planeProjectIdentifier: "AI2026",
        workspaceRootId: "root_code" as never,
        directoryName: "ai-learning",
        initializerProfile: "ai_learning",
        initialModules: ["公开课", "论文", "开源项目", "实践项目"],
      },
      preview: {
        planeProjectLabel: "学习项目/AI2026",
        workspaceLabel: "Code/ai-learning",
        gitAction: "initialize",
        initialModules: ["公开课", "论文", "开源项目", "实践项目"],
      },
      status: "prepared",
      sha256: candidateSha256 as never,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

test("专用入口冻结项目Prompt和Direct能力，确认后恢复ready目标", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-project-bootstrap-"));
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    let current = preparedProjection();
    const calls: string[] = [];
    const configuration = {
      enabled: true as const,
      providerKind: "plane_ce" as const,
      providerVersion: "1.4.1",
      providerWebBaseUrl: "http://127.0.0.1:8088",
      planeWorkspaceSlugs: ["learning"],
      creationRoots: [{ rootId: "root_code" as never, displayName: "Code" }],
    };
    const chat = {
      getProjectBootstrapConfiguration: async () => configuration,
      listWorkflows: async () => [
        {
          workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
          definitionSha256: "b".repeat(64),
          title: "执行 Agent（逐次提示词审核）",
          blueprintKey: "direct",
          ownerKind: "system",
          configurableNodes: [
            {
              definitionNodeId: "direct.agent",
              fields: [{ name: "capabilityMode" }],
            },
          ],
        },
      ],
      getPromptFragment: async () => ({
        fragment: {
          ownerKind: "system",
          status: "builtin",
          regionKey: "agent_identity",
        },
        currentRevision: {
          promptFragmentRevisionId: "pfr_builtinprojectbootstrapv1",
          sha256: "c".repeat(64),
        },
      }),
      getCurrentProjectBootstrap: async () => current,
      decideProjectBootstrap: async () => {
        calls.push("decide");
        const operation = {
          schemaVersion: "project-bootstrap.v1" as const,
          projectBootstrapOperationId: operationId as never,
          projectBootstrapCandidateId: candidateId as never,
          projectBootstrapDecisionId: "pbd_projectbootstrap1" as never,
          candidateSha256: candidateSha256 as never,
          ownerPrincipalId: "usr_debug" as never,
          status: "queued" as const,
          workspaceStep: "pending" as const,
          planeStep: "pending" as const,
          bindingStep: "pending" as const,
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        current = {
          candidate: { ...current.candidate, status: "confirmed", revision: 2 },
          decision: {
            schemaVersion: "project-bootstrap.v1",
            projectBootstrapDecisionId: "pbd_projectbootstrap1" as never,
            projectBootstrapCandidateId: candidateId as never,
            candidateRevision: 1,
            candidateSha256: candidateSha256 as never,
            decidedByPrincipalId: "usr_debug" as never,
            kind: "confirm",
            decidedAt: timestamp,
          },
          operation,
        };
        return { candidate: current.candidate, operation };
      },
      executeProjectBootstrap: async () => {
        calls.push("execute");
        const operation = {
          ...current.operation!,
          status: "ready" as const,
          workspaceStep: "completed" as const,
          planeStep: "completed" as const,
          bindingStep: "completed" as const,
          planeProjectId: "66cf0460-84e0-4d3d-b1ef-d193b83b7562" as never,
          revision: 3,
        };
        current = {
          ...current,
          candidate: { ...current.candidate, status: "ready", revision: 4 },
          operation,
          binding: {
            schemaVersion: "project-bootstrap.v1",
            projectWorkspaceBindingId: "pwb_projectbootstrap1" as never,
            ownerPrincipalId: "usr_debug" as never,
            productSessionId: productSessionId as never,
            projectBootstrapOperationId: operationId as never,
            providerKind: "plane_ce",
            planeWorkspaceSlug: "learning",
            planeProjectId: "66cf0460-84e0-4d3d-b1ef-d193b83b7562" as never,
            planeProjectIdentifier: "AI2026",
            workspaceRootId: "root_code" as never,
            directoryName: "ai-learning",
            status: "active",
            revision: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        };
        return operation;
      },
    } as unknown as ChatProductClient;
    const service = new LifeosBridgeService(chat, state, undefined, undefined, {
      resolve: () => null,
      resolveCreationTarget: async (rootId, directoryName) => {
        assert.equal(rootId, "root_code");
        assert.equal(directoryName, "ai-learning");
        return "/srv/code/ai-learning";
      },
    });

    const preset = await service.projectBootstrapPreset();
    assert.equal(preset.enabled, true);
    if (!preset.enabled) throw new Error("项目初始化应已启用");
    assert.deepEqual(preset.workflowSelection.runConfiguration?.overrides, [
      {
        kind: "node_config",
        definitionNodeId: "direct.agent",
        field: "capabilityMode",
        value: "project_bootstrap",
      },
    ]);
    assert.deepEqual(preset.promptSelection.regions, [
      {
        regionKey: "agent_identity",
        mode: "replace",
        selected: [
          {
            promptFragmentRevisionId: "pfr_builtinprojectbootstrapv1",
            sha256: "c".repeat(64),
          },
        ],
      },
    ]);

    await service.initializeProjectBootstrapSession(dshSessionId);
    const initialized = await state.readSession(dshSessionId);
    assert.equal(initialized?.workflowSelection?.blueprintKey, "direct");
    assert.equal(initialized?.promptSelection?.regions[0]?.regionKey, "agent_identity");
    await state.mutateSession(
      dshSessionId,
      stableCommandId("create-session", dshSessionId),
      (binding) => {
        binding.chatSessionId = productSessionId;
      },
    );

    const ready = await service.decideProjectBootstrap(dshSessionId, {
      kind: "confirm",
      binding: {
        projectBootstrapCandidateId: candidateId as never,
        candidateRevision: 1,
        candidateSha256: candidateSha256 as never,
      },
    });
    assert.deepEqual(calls, ["decide", "execute"]);
    assert.equal(ready.projectBootstrap?.operation?.status, "ready");
    assert.deepEqual(ready.projectBootstrapTargets, {
      workspaceCwd: "/srv/code/ai-learning",
      planeUrl:
        "http://127.0.0.1:8088/learning/projects/66cf0460-84e0-4d3d-b1ef-d193b83b7562/issues",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LifeosBridgeService } from "../src/bridge-service.ts";
import type { ChatProductClient } from "../src/chat-client.ts";
import { AtomicBridgeStateStore } from "../src/state-store.ts";

test("普通DSH项目表面忠实呈现Application已编译的Provider可用性", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-project-management-"));
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const chat = {
      getProjectHome: async () => ({
        presentationSurfaces: [
          {
            capability: "work",
            availability: "fallback",
            fallbackIntent: "open_internal",
            binding: null,
          },
          {
            capability: "timeline",
            availability: "available",
            fallbackIntent: "open_internal",
            binding: { providerKind: "dsh-project-management.v1", externalRef: "timeline" },
          },
        ],
      }),
      getProjectWorkspace: async () => ({
        project: { projectId: "prj_contentlab1", name: "Content Lab" },
        providerBindings: [{ providerKind: "local_git", workspaceRootId: "root_contentlab" }],
      }),
    } as unknown as ChatProductClient;
    const service = new LifeosBridgeService(chat, state);

    const result = await service.projectOverview("prj_contentlab1");

    assert.deepEqual(result.projectHome.presentationSurfaces[0], {
      capability: "work",
      availability: "fallback",
      fallbackIntent: "open_internal",
      binding: null,
    });
    assert.deepEqual(result.projectHome.presentationSurfaces[1], {
      capability: "timeline",
      availability: "available",
      fallbackIntent: "open_internal",
      binding: { providerKind: "dsh-project-management.v1", externalRef: "timeline" },
    });
    assert.deepEqual(result.project.providerBindings, [
      { providerKind: "local_git", workspaceRootId: "root_contentlab" },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promptSelectionRequestSchema } from "../src/contracts.ts";
import {
  createPromptWorkspaceResolver,
  promptSelectionForWorkspace,
} from "../src/prompt-workspace-resolver.ts";

test("DSH session membership resolves only to configured Chat root identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-prompt-workspace-"));
  try {
    const canonicalDirectory = await realpath(directory);
    const resolver = await createPromptWorkspaceResolver(
      {
        list: () => [
          {
            path: canonicalDirectory,
            sessionIds: ["dsh-session-1"],
          },
        ],
      },
      {
        CHAT_PROJECT_ROOTS_JSON: JSON.stringify([
          {
            rootId: "root_chat",
            displayName: "Chat",
            canonicalPath: directory,
            enabledAdapters: ["local-git-workspace.v1"],
          },
        ]),
      },
    );

    assert.deepEqual(resolver.resolve("dsh-session-1"), {
      rootId: "root_chat",
      title: "Chat",
    });
    assert.equal(resolver.resolve("dsh-session-2"), null);
    assert.doesNotMatch(
      JSON.stringify(resolver.resolve("dsh-session-1")),
      /chat-prompt-workspace/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unmapped sessions remain global-only and a changed workspace drops stale selections", async () => {
  const resolver = await createPromptWorkspaceResolver({ list: () => [] }, {});
  assert.equal(resolver.resolve("dsh-session-1"), null);

  const selected = promptSelectionRequestSchema.shape.promptSelection.parse({
    schemaVersion: "prompt-turn-selection-input.v1" as const,
    workspaceRootId: "root_old",
    regions: [
      {
        regionKey: "rules",
        mode: "append" as const,
        selected: [{ promptFragmentRevisionId: "pfr_customrulesv1", sha256: "a".repeat(64) }],
      },
    ],
  });
  assert.deepEqual(promptSelectionForWorkspace(selected, null), {
    schemaVersion: "prompt-turn-selection-input.v1",
    regions: [],
  });
  assert.deepEqual(promptSelectionForWorkspace(undefined, { rootId: "root_chat", title: "Chat" }), {
    schemaVersion: "prompt-turn-selection-input.v1",
    workspaceRootId: "root_chat",
    regions: [],
  });
});

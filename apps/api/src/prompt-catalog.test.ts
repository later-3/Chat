import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFilePromptCatalog } from "./prompt-catalog.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("File Prompt Catalog workspace instructions", () => {
  it("只把配置根目录的AGENTS.md投影为可显式选择组件且不递归发现", async () => {
    const repoRoot = await realpath(resolve(import.meta.dirname, "../../.."));
    const target = await mkdtemp(join(tmpdir(), "chat-prompt-catalog-target-"));
    roots.push(target);
    await writeFile(join(target, "AGENTS.md"), "# Target instructions\n", "utf8");
    await mkdir(join(target, "nested"), { recursive: true });
    await writeFile(join(target, "nested/AGENTS.md"), "# Must not be discovered\n", "utf8");

    const catalog = await createFilePromptCatalog(repoRoot, {
      CHAT_PLATFORM_WORKSPACE_ROOT_ID: "root_chat",
      CHAT_PROJECT_ROOTS_JSON: JSON.stringify([
        {
          rootId: "root_chat",
          displayName: "Chat",
          canonicalPath: repoRoot,
          enabledAdapters: [],
        },
        {
          rootId: "root_target",
          displayName: "Target",
          canonicalPath: target,
          enabledAdapters: [],
        },
      ]),
    });
    const snapshot = await catalog.load();
    expect(snapshot.sharedSelectionProfile.profileId).toBe("chat-shared-default.v1");
    expect(snapshot.sharedSelectionProfile.defaultRevisionIds).not.toContain(
      "pfr_builtinagentidentityv2",
    );
    expect(snapshot.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentKey: "planner" }),
        expect.objectContaining({ agentKey: "direct" }),
        expect.objectContaining({ agentKey: "coding_executor" }),
        expect.objectContaining({ agentKey: "note_extractor" }),
      ]),
    );
    expect(snapshot.agents.map((agent) => agent.agentKey)).not.toContain("project_bootstrap");
    expect(snapshot.agents.find((agent) => agent.agentKey === "direct")?.defaultPrompt).toEqual({
      kind: "pi_coding_agent",
      defaultVariantKey: "pi_cli_default",
    });
    expect(
      snapshot.agents.find((agent) => agent.agentKey === "coding_executor")?.defaultPrompt,
    ).toEqual({
      kind: "pi_coding_agent",
      defaultVariantKey: "workspace_write_shell",
    });
    expect(snapshot.builtinFragments.map((fragment) => fragment.sourceRelativePath)).not.toEqual(
      expect.arrayContaining([
        "prompts/fragments/agent-identity/direct-agent.md",
        "prompts/fragments/agent-identity/coding-executor-agent.md",
      ]),
    );
    const workspace = snapshot.builtinFragments.filter(
      (fragment) => fragment.regionKey === "workspace_instructions",
    );
    expect(workspace).toHaveLength(2);
    expect(
      workspace.find((fragment) => fragment.sourceRelativePath === "root_chat/AGENTS.md")?.scope,
    ).toEqual({ kind: "global" });
    expect(
      workspace.find((fragment) => fragment.sourceRelativePath === "root_target/AGENTS.md")?.scope,
    ).toEqual({ kind: "workspace", rootId: "root_target" });
    expect(JSON.stringify(workspace)).not.toContain("Must not be discovered");
  });
});

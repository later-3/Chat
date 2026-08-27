import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFilePromptCatalog } from "./prompt-catalog.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("File Prompt Catalog workspace instructions", () => {
  it("Catalog发布日期变化不会改写已有Builtin Revision的创建时间或身份Hash", async () => {
    const repoRoot = await realpath(resolve(import.meta.dirname, "../../.."));
    const copiedRoot = await mkdtemp(join(tmpdir(), "chat-prompt-catalog-copy-"));
    roots.push(copiedRoot);
    await cp(join(repoRoot, "prompts"), join(copiedRoot, "prompts"), { recursive: true });

    const baseline = await (await createFilePromptCatalog(repoRoot, {})).load();
    const manifestPath = join(copiedRoot, "prompts/catalog.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.publishedAt = "2026-08-26T00:00:00.000Z";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const republished = await (await createFilePromptCatalog(copiedRoot, {})).load();

    const revisionId = "pfr_builtinevidencefirstv1";
    const before = baseline.builtinFragments.find(
      (fragment) => fragment.promptFragmentRevisionId === revisionId,
    );
    const after = republished.builtinFragments.find(
      (fragment) => fragment.promptFragmentRevisionId === revisionId,
    );
    expect(after?.sha256).toBe(before?.sha256);
    expect(after?.createdAt).toBe("2026-08-22T00:00:00.000Z");
  });

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
    const selectableGovernanceFragments = [
      {
        revisionId: "pfr_builtincontrolledprojectchangev3",
        identitySha256: "6dcdeed142c38bb6a674e061011b0b4b0693e31409e1c3ef3b56c6e7b4f2a578",
        regionKey: "rules",
        ruleIds: ["S1", "S2", "S3", "S5", "S6", "S10"],
        qualityClauses: ["状态/事务Owner", "公共API", "错误、部分成功和结果未知"],
      },
      {
        revisionId: "pfr_builtinengineeringevidencev3",
        identitySha256: "30b7515dbf151a0b55fb6c531f3db0aef69b02692daa6eb5bb8285f7431404f7",
        regionKey: "requirements",
        ruleIds: ["S7", "S8", "S9", "S11"],
        qualityClauses: ["完整`describe + it`路径", "共享Conformance", "最终消费者"],
      },
      {
        revisionId: "pfr_builtinmultiagentdeliveryv3",
        identitySha256: "f761911e1ff73182e7632f569d63a556b5e89fccc27a53f139def0d30879ebcf",
        regionKey: "experience",
        ruleIds: ["S4", "S8", "S9"],
        qualityClauses: ["权限只回答“能否写”", "同模型Agent", "最终组合"],
      },
    ] as const;
    for (const expected of selectableGovernanceFragments) {
      const fragment = snapshot.builtinFragments.find(
        (candidate) => candidate.promptFragmentRevisionId === expected.revisionId,
      );
      expect(fragment).toEqual(
        expect.objectContaining({
          promptFragmentRevisionId: expected.revisionId,
          revision: 3,
          regionKey: expected.regionKey,
          scope: { kind: "global" },
          sha256: expected.identitySha256,
          createdAt: "2026-08-25T00:00:00.000Z",
        }),
      );
      expect(fragment?.content).toEqual(
        expect.objectContaining({
          bodyMarkdown: expect.stringContaining("agent-engineering-standard.v0.2"),
        }),
      );
      const body = fragment?.content.kind === "markdown" ? fragment.content.bodyMarkdown : "";
      for (const ruleId of expected.ruleIds) {
        expect(body).toMatch(new RegExp(`(?:^|[^A-Z0-9])${ruleId}(?:[^0-9]|$)`, "u"));
      }
      for (const clause of expected.qualityClauses) {
        expect(body).toContain(clause);
      }
      expect(snapshot.regions.find((region) => region.regionKey === expected.regionKey)).toEqual(
        expect.objectContaining({
          category: "context",
          availability: "active",
          userManageable: true,
        }),
      );
      expect(snapshot.sharedSelectionProfile.defaultRevisionIds).not.toContain(expected.revisionId);
    }
    expect(
      snapshot.builtinFragments.find(
        (fragment) => fragment.promptFragmentRevisionId === "pfr_builtinevidencefirstv1",
      )?.createdAt,
    ).toBe("2026-08-22T00:00:00.000Z");
    expect(snapshot.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentKey: "planner" }),
        expect.objectContaining({ agentKey: "direct" }),
        expect.objectContaining({ agentKey: "coding_executor" }),
        expect.objectContaining({ agentKey: "note_extractor" }),
      ]),
    );
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

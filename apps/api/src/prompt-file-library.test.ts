import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashCanonical } from "@chat/domain";
import { createPromptFileLibrary } from "./prompt-file-library.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("Prompt Markdown File Library", () => {
  it("按全局与Workspace作用域发布不可变Revision并校验正文漂移", async () => {
    const repoRoot = await temporaryRoot("chat-prompt-files-repo-");
    const workspaceRoot = await temporaryRoot("chat-prompt-files-workspace-");
    await mkdir(join(repoRoot, ".data"), { recursive: true });
    const library = await createPromptFileLibrary({
      repoRoot,
      env: {
        CHAT_PROJECT_ROOTS_JSON: JSON.stringify([
          {
            rootId: "root_target",
            displayName: "Target",
            canonicalPath: workspaceRoot,
            enabledAdapters: [],
          },
        ]),
      },
    });
    const globalContent = { kind: "markdown" as const, bodyMarkdown: "只相信可复核证据。" };
    const global = await library.publishRevision({
      promptFragmentId: "pfg_globalrules" as never,
      promptFragmentRevisionId: "pfr_globalrulesv1" as never,
      revision: 1,
      regionKey: "rules",
      title: "证据规则",
      scope: { kind: "global" },
      content: globalContent,
      contentSha256: hashCanonical("prompt-file-content.v1", globalContent),
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    expect(global.sourceRelativePath).toBe(
      ".data/prompts/global/rules/pfg_globalrules/pfr_globalrulesv1.md",
    );
    const globalRaw = await readFile(join(repoRoot, global.sourceRelativePath), "utf8");
    expect(globalRaw).toContain("chat-prompt-metadata");
    expect(globalRaw).toContain("只相信可复核证据。");
    await expect(
      library.publishRevision({
        promptFragmentId: "pfg_globalrules" as never,
        promptFragmentRevisionId: "pfr_globalrulesv1" as never,
        revision: 1,
        regionKey: "rules",
        title: "证据规则",
        scope: { kind: "global" },
        content: globalContent,
        contentSha256: hashCanonical("prompt-file-content.v1", globalContent),
        createdAt: "2026-08-20T00:00:00.000Z",
      }),
    ).resolves.toEqual(global);

    const workspaceContent = { kind: "markdown" as const, bodyMarkdown: "只适用于Target。" };
    const workspace = await library.publishRevision({
      promptFragmentId: "pfg_workspacerules" as never,
      promptFragmentRevisionId: "pfr_workspacerulesv1" as never,
      revision: 1,
      regionKey: "rules",
      title: "Target规则",
      scope: { kind: "workspace", rootId: "root_target" as never },
      content: workspaceContent,
      contentSha256: hashCanonical("prompt-file-content.v1", workspaceContent),
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    expect(workspace.sourceRelativePath).toBe(
      "root_target/.chat/prompts/rules/pfg_workspacerules/pfr_workspacerulesv1.md",
    );
    const workspaceFile = join(
      workspaceRoot,
      ".chat/prompts/rules/pfg_workspacerules/pfr_workspacerulesv1.md",
    );
    await writeFile(workspaceFile, "被手工篡改", "utf8");
    await expect(
      library.readRevision({
        promptFragmentId: "pfg_workspacerules" as never,
        promptFragmentRevisionId: "pfr_workspacerulesv1" as never,
        regionKey: "rules",
        scope: { kind: "workspace", rootId: "root_target" as never },
        expectedContentSha256: hashCanonical("prompt-file-content.v1", workspaceContent),
      }),
    ).rejects.toThrow("受管元数据");
  });
});

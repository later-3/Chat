import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectBootstrapOperationIdSchema, type ProjectBootstrapProposal } from "@chat/contracts";
import { createProjectWorkspaceProvisioner } from "./workspace-provisioner.js";

const sha256 = "a".repeat(64);
const operation1 = projectBootstrapOperationIdSchema.parse("pbo_create1");
const operation2 = projectBootstrapOperationIdSchema.parse("pbo_create2");

function proposal(): ProjectBootstrapProposal {
  return {
    name: "AI 学习",
    objective: "学习公开课、论文与开源项目，并形成可验证的实践产物。",
    planeWorkspaceSlug: "learning",
    planeProjectIdentifier: "AI2026",
    workspaceRootId: "root_code",
    directoryName: "ai-learning",
    initializerProfile: "ai_learning",
    initialModules: ["公开课", "论文", "开源实践"],
  };
}

describe("本地项目Workspace初始化", () => {
  it("只在允许Root的直接子目录中初始化模板与Git，并可幂等对账", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-project-create-"));
    const provisioner = await createProjectWorkspaceProvisioner({
      CHAT_PROJECT_CREATION_ROOTS_JSON: JSON.stringify([
        { rootId: "root_code", displayName: "Code", canonicalPath: root },
      ]),
    });
    expect(provisioner).toBeDefined();
    const preview = await provisioner!.preflight({
      rootId: "root_code",
      directoryName: "ai-learning",
    });
    expect(preview.workspaceLabel).toBe("Code/ai-learning");

    const input = {
      operationId: operation1,
      candidateSha256: sha256,
      proposal: proposal(),
    };
    await expect(provisioner!.provision(input)).resolves.toEqual({
      status: "completed",
      workspaceLabel: "Code/ai-learning",
    });
    await expect(provisioner!.reconcile(input)).resolves.toEqual({
      status: "completed",
      workspaceLabel: "Code/ai-learning",
    });
    expect(await readFile(join(root, "ai-learning", "README.md"), "utf8")).toContain("# AI 学习");
    expect((await stat(join(root, "ai-learning", ".git"))).isDirectory()).toBe(true);
    expect((await stat(join(root, "ai-learning", "papers"))).isDirectory()).toBe(true);
  });

  it("拒绝路径逃逸、未知Root和绑定到另一操作的已有目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-project-create-"));
    const provisioner = await createProjectWorkspaceProvisioner({
      CHAT_PROJECT_CREATION_ROOTS_JSON: JSON.stringify([
        { rootId: "root_code", displayName: "Code", canonicalPath: root },
      ]),
    });
    await expect(
      provisioner!.preflight({ rootId: "root_unknown" as "root_code", directoryName: "demo" }),
    ).rejects.toMatchObject({ code: "project_creation_root_not_allowed" });
    await expect(
      provisioner!.preflight({ rootId: "root_code", directoryName: "../escape" }),
    ).rejects.toBeDefined();

    const input = {
      operationId: operation1,
      candidateSha256: sha256,
      proposal: proposal(),
    };
    await provisioner!.provision(input);
    await expect(
      provisioner!.provision({ ...input, operationId: operation2 }),
    ).resolves.toMatchObject({ status: "failed", errorCode: "project_workspace_marker_conflict" });
  });
});

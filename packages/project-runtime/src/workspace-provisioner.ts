import { execFile } from "node:child_process";
import { mkdir, lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  ProjectCreationRootDescriptor,
  ProjectWorkspaceProvisionerPort,
  ProjectWorkspaceProvisionResult,
} from "@chat/application";
import {
  projectBootstrapProposalSchema,
  projectBootstrapOperationIdSchema,
  promptWorkspaceRootIdSchema,
} from "@chat/contracts";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const MARKER_DIRECTORY = ".chat";
const MARKER_FILE = "project-bootstrap.json";

const creationRootConfigSchema = z
  .array(
    z
      .object({
        rootId: promptWorkspaceRootIdSchema,
        displayName: z.string().min(1).max(160),
        canonicalPath: z.string().min(1).max(2_000),
      })
      .strict(),
  )
  .max(20);

const markerSchema = z
  .object({
    schemaVersion: z.literal("project-workspace-bootstrap.v1"),
    operationId: projectBootstrapOperationIdSchema,
    candidateSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

interface CreationRoot {
  readonly descriptor: ProjectCreationRootDescriptor;
  readonly canonicalPath: string;
}

export class ProjectWorkspaceProvisionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectWorkspaceProvisionError";
  }
}

/** 未配置时保持现有Chat启动；只配置部分字段时失败关闭。 */
export async function createProjectWorkspaceProvisioner(
  env: NodeJS.ProcessEnv,
): Promise<ProjectWorkspaceProvisionerPort | undefined> {
  const raw = env.CHAT_PROJECT_CREATION_ROOTS_JSON;
  if (raw === undefined || raw.trim() === "") return undefined;
  let parsed: z.infer<typeof creationRootConfigSchema>;
  try {
    parsed = creationRootConfigSchema.parse(JSON.parse(raw));
  } catch {
    throw new ProjectWorkspaceProvisionError(
      "project_creation_root_config_invalid",
      "CHAT_PROJECT_CREATION_ROOTS_JSON不符合合同",
    );
  }
  const ids = new Set<string>();
  const roots: CreationRoot[] = [];
  for (const item of parsed) {
    if (ids.has(item.rootId)) {
      throw new ProjectWorkspaceProvisionError(
        "project_creation_root_config_invalid",
        `项目创建Root重复:${item.rootId}`,
      );
    }
    ids.add(item.rootId);
    const canonicalPath = await realpath(item.canonicalPath);
    if (!(await stat(canonicalPath)).isDirectory()) {
      throw new ProjectWorkspaceProvisionError(
        "project_creation_root_config_invalid",
        `${item.rootId}不是目录`,
      );
    }
    roots.push({
      canonicalPath,
      descriptor: { rootId: item.rootId, displayName: item.displayName },
    });
  }
  return new LocalProjectWorkspaceProvisioner(roots);
}

class LocalProjectWorkspaceProvisioner implements ProjectWorkspaceProvisionerPort {
  constructor(private readonly roots: readonly CreationRoot[]) {}

  listRoots(): readonly ProjectCreationRootDescriptor[] {
    return this.roots.map((item) => structuredClone(item.descriptor));
  }

  async preflight(input: { readonly rootId: string; readonly directoryName: string }): Promise<{
    root: ProjectCreationRootDescriptor;
    directoryName: string;
    workspaceLabel: string;
  }> {
    const proposal = projectBootstrapProposalSchema
      .pick({
        workspaceRootId: true,
        directoryName: true,
      })
      .parse({ workspaceRootId: input.rootId, directoryName: input.directoryName });
    const root = this.requireRoot(proposal.workspaceRootId);
    const target = targetPath(root.canonicalPath, proposal.directoryName);
    if (await exists(target)) {
      throw new ProjectWorkspaceProvisionError(
        "project_workspace_target_exists",
        "目标项目目录已经存在",
      );
    }
    return {
      root: structuredClone(root.descriptor),
      directoryName: proposal.directoryName,
      workspaceLabel: `${root.descriptor.displayName}/${proposal.directoryName}`,
    };
  }

  async provision(input: Parameters<ProjectWorkspaceProvisionerPort["provision"]>[0]) {
    const root = this.requireRoot(input.proposal.workspaceRootId);
    const target = targetPath(root.canonicalPath, input.proposal.directoryName);
    let crossedWriteBoundary = false;
    try {
      if (!(await exists(target))) {
        await mkdir(target, { mode: 0o755 });
        crossedWriteBoundary = true;
      }
      await ensureMarker(target, input.operationId, input.candidateSha256);
      crossedWriteBoundary = true;
      await writeTemplate(target, input.proposal);
      await ensureGitRepository(target);
      return {
        status: "completed" as const,
        workspaceLabel: `${root.descriptor.displayName}/${input.proposal.directoryName}`,
      };
    } catch (error) {
      if (error instanceof ProjectWorkspaceProvisionError) {
        return { status: "failed" as const, errorCode: error.code };
      }
      return crossedWriteBoundary
        ? {
            status: "outcome_unknown" as const,
            errorCode: "project_workspace_provision_outcome_unknown",
          }
        : { status: "failed" as const, errorCode: "project_workspace_provision_failed" };
    }
  }

  async reconcile(input: Parameters<ProjectWorkspaceProvisionerPort["reconcile"]>[0]) {
    const root = this.requireRoot(input.proposal.workspaceRootId);
    const target = targetPath(root.canonicalPath, input.proposal.directoryName);
    try {
      if (!(await exists(target))) {
        return { status: "failed" as const, errorCode: "project_workspace_not_found" };
      }
      await assertMarker(target, input.operationId, input.candidateSha256);
      const { stdout } = await execFileAsync(
        "git",
        ["-C", target, "rev-parse", "--is-inside-work-tree"],
        {
          encoding: "utf8",
          timeout: 8_000,
          windowsHide: true,
        },
      );
      if (stdout.trim() !== "true") {
        return { status: "failed" as const, errorCode: "project_workspace_git_invalid" };
      }
      return {
        status: "completed" as const,
        workspaceLabel: `${root.descriptor.displayName}/${input.proposal.directoryName}`,
      };
    } catch (error) {
      return {
        status: "failed" as const,
        errorCode:
          error instanceof ProjectWorkspaceProvisionError
            ? error.code
            : "project_workspace_reconcile_failed",
      } satisfies ProjectWorkspaceProvisionResult;
    }
  }

  private requireRoot(rootId: string): CreationRoot {
    const root = this.roots.find((item) => item.descriptor.rootId === rootId);
    if (root === undefined) {
      throw new ProjectWorkspaceProvisionError(
        "project_creation_root_not_allowed",
        "项目创建Root未配置或不允许访问",
      );
    }
    return root;
  }
}

function targetPath(root: string, directoryName: string): string {
  const target = resolve(root, directoryName);
  if (
    target === root ||
    !target.startsWith(`${root}${sep}`) ||
    relative(root, target) !== directoryName
  ) {
    throw new ProjectWorkspaceProvisionError(
      "project_workspace_path_escape",
      "项目目录越过允许Root",
    );
  }
  return target;
}

async function ensureMarker(target: string, operationId: string, candidateSha256: string) {
  const markerDirectory = resolve(target, MARKER_DIRECTORY);
  const markerPath = resolve(markerDirectory, MARKER_FILE);
  await mkdir(markerDirectory, { recursive: true, mode: 0o700 });
  if (await exists(markerPath)) {
    await assertMarker(target, operationId, candidateSha256);
    return;
  }
  await writeFile(
    markerPath,
    `${JSON.stringify({
      schemaVersion: "project-workspace-bootstrap.v1",
      operationId,
      candidateSha256,
    })}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
}

async function assertMarker(target: string, operationId: string, candidateSha256: string) {
  let marker: z.infer<typeof markerSchema>;
  try {
    marker = markerSchema.parse(
      JSON.parse(await readFile(resolve(target, MARKER_DIRECTORY, MARKER_FILE), "utf8")),
    );
  } catch {
    throw new ProjectWorkspaceProvisionError(
      "project_workspace_marker_invalid",
      "已有目录不属于当前项目初始化操作",
    );
  }
  if (marker.operationId !== operationId || marker.candidateSha256 !== candidateSha256) {
    throw new ProjectWorkspaceProvisionError(
      "project_workspace_marker_conflict",
      "已有目录绑定到其他项目初始化操作",
    );
  }
}

async function writeTemplate(
  target: string,
  proposal: z.infer<typeof projectBootstrapProposalSchema>,
) {
  await writeIfMissing(
    resolve(target, ".gitignore"),
    [".chat/", ".cache/", "downloads/", "media/", ""].join("\n"),
  );
  await writeIfMissing(
    resolve(target, "README.md"),
    [
      `# ${proposal.name}`,
      "",
      proposal.objective,
      "",
      `Plane: ${proposal.planeWorkspaceSlug}/${proposal.planeProjectIdentifier}`,
      "",
    ].join("\n"),
  );
  if (proposal.initializerProfile === "ai_learning") {
    for (const directory of ["sources", "courses", "papers", "opensource", "projects", "notes"]) {
      await mkdir(resolve(target, directory), { recursive: true, mode: 0o755 });
      await writeIfMissing(resolve(target, directory, ".gitkeep"), "");
    }
  }
}

async function ensureGitRepository(target: string) {
  if (!(await exists(resolve(target, ".git")))) {
    await execFileAsync("git", ["init", "--initial-branch=main", target], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
  }
}

async function writeIfMissing(path: string, content: string) {
  if (await exists(path)) return;
  await writeFile(path, content, { encoding: "utf8", mode: 0o644, flag: "wx" });
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

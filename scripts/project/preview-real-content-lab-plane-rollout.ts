import "../load-api-env.mjs";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createContentProductionProject,
  previewContentLabPlaneRollout,
  type ApplicationDeps,
  type ProjectIdFactory,
} from "../../packages/application/src/index.ts";
import { principalIdSchema } from "../../packages/contracts/src/index.ts";
import { JsonProductStore } from "../../packages/product-store-json/src/index.ts";
import {
  createPlaneCeProjectRolloutInspection,
  createProjectResourceRegistry,
  PlaneCeClientError,
} from "../../packages/project-runtime/src/index.ts";
import { createIdFactory } from "../../apps/api/src/composition.ts";

const execFileAsync = promisify(execFile);
if (process.env.CHAT_CONTENT_LAB_PLANE_ROLLOUT_REAL_READ !== "1") {
  throw new Error("真实P8 Dry Run需要显式设置CHAT_CONTENT_LAB_PLANE_ROLLOUT_REAL_READ=1");
}
const root = process.env.CHAT_CONTENT_LAB_REAL_ROOT?.trim();
if (root === undefined || root === "") {
  throw new Error("必须显式设置CHAT_CONTENT_LAB_REAL_ROOT；脚本不会猜测个人绝对路径");
}
const projectIdentifier =
  process.env.CHAT_CONTENT_LAB_PLANE_PROJECT_IDENTIFIER?.trim() ?? "CONTENTLAB";
if (!/^[A-Z][A-Z0-9]{0,11}$/u.test(projectIdentifier)) {
  throw new Error("Content Lab Plane Project Identifier非法");
}

async function gitStatus(): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", root!, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { encoding: "utf8", timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout;
}

const statusBefore = await gitStatus();
const tempDirectory = await mkdtemp(join(tmpdir(), "chat-content-lab-plane-rollout-"));
try {
  const projectRoots = await createProjectResourceRegistry({
    CHAT_PROJECT_ROOTS_JSON: JSON.stringify([
      {
        rootId: "root_contentlab",
        displayName: "Ziji Content Lab",
        canonicalPath: root,
        enabledAdapters: ["local-git-workspace.v1", "content-lab-resource.v1"],
        gitEvidenceEnabled: false,
      },
    ]),
  });
  const rolloutInspection = createPlaneCeProjectRolloutInspection(process.env);
  if (rolloutInspection === undefined) throw new Error("Plane管理员只读预检配置不完整");
  const matches: { workspaceSlug: string }[] = [];
  for (const workspaceSlug of rolloutInspection.describe().allowedWorkspaceSlugs) {
    try {
      await rolloutInspection.inspectProject({ workspaceSlug, projectIdentifier });
      matches.push({ workspaceSlug });
    } catch (error) {
      if (!(error instanceof PlaneCeClientError) || error.code !== "plane_project_not_found") {
        throw error;
      }
    }
  }
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(
      `Content Lab Project必须跨允许Workspace唯一命中，实际:${String(matches.length)}`,
    );
  }
  const now = new Date().toISOString();
  const store = await JsonProductStore.open({
    filePath: join(tempDirectory, "product-store.json"),
    now: () => now,
  });
  const deps: ApplicationDeps = {
    store,
    now: () => now,
    ids: createIdFactory(),
    projectIds: deterministicProjectIds(),
    projectRoots,
    planeProjectRolloutInspection: rolloutInspection,
  };
  const principalId = principalIdSchema.parse("usr_contentlabrollout");
  const created = await createContentProductionProject(deps, {
    principalId,
    commandId: "cmd_contentlabrolloutpreview" as never,
    payload: {
      rootId: "root_contentlab",
      name: "Ziji Content Lab",
      summary: "把外语视频转译为可发布的中文内容。",
      goal: "持续发布内容，并用真实案例打磨内容工作流。",
      scopeIn: ["内容交付", "工作流改进"],
      scopeOut: ["自动替用户确认发布成功"],
      successCriteria: ["发布历史可追溯", "方法改进有证据"],
    },
  });
  const result = await previewContentLabPlaneRollout(deps, {
    principalId,
    query: {
      projectId: created.project.project.projectId,
      workspaceRootId: "root_contentlab" as never,
      planeWorkspaceSlug: matches[0].workspaceSlug,
      planeProjectIdentifier: projectIdentifier,
    },
  });
  if (result.dryRun.planeWrites !== 0 || result.dryRun.executionAuthorized) {
    throw new Error("P8 Dry Run意外获得写授权");
  }
  if ((await gitStatus()) !== statusBefore) throw new Error("P8 Dry Run修改了Content Lab工作区");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}

function deterministicProjectIds(): ProjectIdFactory {
  const sequences = new Map<string, number>();
  const allocate = (prefix: string) => () => {
    const next = (sequences.get(prefix) ?? 0) + 1;
    sequences.set(prefix, next);
    return `${prefix}_contentlabrollout${String(next)}` as never;
  };
  return {
    project: allocate("prj"),
    methodSnapshot: allocate("pms"),
    stage: allocate("pst"),
    resource: allocate("prs"),
    participant: allocate("ppt"),
    work: allocate("pwk"),
    action: allocate("pac"),
    contribution: allocate("pct"),
    evidence: allocate("pev"),
    decision: allocate("pdc"),
    observation: allocate("pob"),
    candidate: allocate("pca"),
    milestone: allocate("pml"),
    update: allocate("pup"),
    stateTransition: allocate("ptr"),
    workBlock: allocate("pbl"),
    workClaim: allocate("pcl"),
    workHandoff: allocate("phf"),
    practiceRevision: allocate("ppr"),
    workOutcome: allocate("pwo"),
    contextMap: allocate("pcm"),
    providerBinding: allocate("pvb"),
    providerProjection: allocate("pvp"),
  };
}

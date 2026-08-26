import "../load-api-env.mjs";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createContentProductionProject,
  executeContentLabPlaneRollout,
  type ApplicationDeps,
  type ProjectIdFactory,
} from "../../packages/application/src/index.ts";
import { principalIdSchema, sha256Schema } from "../../packages/contracts/src/index.ts";
import { JsonProductStore } from "../../packages/product-store-json/src/index.ts";
import {
  createPlaneCeProjectRolloutExecution,
  createPlaneCeProjectRolloutInspection,
  createProjectResourceRegistry,
  PlaneCeClientError,
} from "../../packages/project-runtime/src/index.ts";
import { createIdFactory } from "../../apps/api/src/composition.ts";

const execFileAsync = promisify(execFile);
if (process.env.CHAT_CONTENT_LAB_PLANE_ROLLOUT_REAL_WRITE !== "1") {
  throw new Error("真实P8写入需要显式设置CHAT_CONTENT_LAB_PLANE_ROLLOUT_REAL_WRITE=1");
}
const root = process.env.CHAT_CONTENT_LAB_REAL_ROOT?.trim();
if (root === undefined || root === "") {
  throw new Error("必须显式设置CHAT_CONTENT_LAB_REAL_ROOT；脚本不会猜测个人绝对路径");
}
const approvedDryRunSha256 = sha256Schema.parse(
  process.env.CHAT_CONTENT_LAB_PLANE_ROLLOUT_APPROVED_SHA256,
);
const resumeAfterProjectPatch =
  process.env.CHAT_CONTENT_LAB_PLANE_ROLLOUT_RESUME_AFTER_PROJECT_PATCH === "1"
    ? {
        approvedResourceObservationSha256: sha256Schema.parse(
          process.env.CHAT_CONTENT_LAB_PLANE_ROLLOUT_APPROVED_OBSERVATION_SHA256,
        ),
        approvedBeforeInspectionSha256: sha256Schema.parse(
          process.env.CHAT_CONTENT_LAB_PLANE_ROLLOUT_APPROVED_INSPECTION_SHA256,
        ),
      }
    : undefined;
const resumeAfterCandidatePlacementConflict =
  process.env.CHAT_CONTENT_LAB_PLANE_ROLLOUT_RESUME_AFTER_CANDIDATE_CONFLICT === "1"
    ? {
        approvedResourceObservationSha256: sha256Schema.parse(
          process.env.CHAT_CONTENT_LAB_PLANE_ROLLOUT_APPROVED_OBSERVATION_SHA256,
        ),
        approvedBeforeInspectionSha256: sha256Schema.parse(
          process.env.CHAT_CONTENT_LAB_PLANE_ROLLOUT_APPROVED_INSPECTION_SHA256,
        ),
      }
    : undefined;
const reconcileCompletedRollout =
  process.env.CHAT_CONTENT_LAB_PLANE_ROLLOUT_RECONCILE_COMPLETED === "1"
    ? {
        approvedResourceObservationSha256: sha256Schema.parse(
          process.env.CHAT_CONTENT_LAB_PLANE_ROLLOUT_APPROVED_OBSERVATION_SHA256,
        ),
        approvedBeforeInspectionSha256: sha256Schema.parse(
          process.env.CHAT_CONTENT_LAB_PLANE_ROLLOUT_APPROVED_INSPECTION_SHA256,
        ),
      }
    : undefined;
if (
  [
    resumeAfterProjectPatch,
    resumeAfterCandidatePlacementConflict,
    reconcileCompletedRollout,
  ].filter((value) => value !== undefined).length > 1
) {
  throw new Error("P8恢复阶段只能选择一个");
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
const tempDirectory = await mkdtemp(join(tmpdir(), "chat-content-lab-plane-rollout-write-"));
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
  const rolloutExecution = createPlaneCeProjectRolloutExecution(process.env);
  if (rolloutInspection === undefined || rolloutExecution === undefined) {
    throw new Error("Plane管理员预检或执行配置不完整");
  }
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
    planeProjectRolloutExecution: rolloutExecution,
  };
  const principalId = principalIdSchema.parse("usr_contentlabrollout");
  const created = await createContentProductionProject(deps, {
    principalId,
    commandId: "cmd_contentlabrolloutwrite" as never,
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
  const result = await executeContentLabPlaneRollout(deps, {
    principalId,
    query: {
      projectId: created.project.project.projectId,
      workspaceRootId: "root_contentlab" as never,
      planeWorkspaceSlug: matches[0].workspaceSlug,
      planeProjectIdentifier: projectIdentifier,
    },
    approvedDryRunSha256,
    ...(resumeAfterProjectPatch === undefined ? {} : { resumeAfterProjectPatch }),
    ...(resumeAfterCandidatePlacementConflict === undefined
      ? {}
      : { resumeAfterCandidatePlacementConflict }),
    ...(reconcileCompletedRollout === undefined ? {} : { reconcileCompletedRollout }),
  });
  const expected =
    reconcileCompletedRollout !== undefined
      ? { writes: 0, created: 0, updated: 0, reused: 31 }
      : resumeAfterCandidatePlacementConflict !== undefined
        ? { writes: 8, created: 4, updated: 0, reused: 27 }
        : resumeAfterProjectPatch !== undefined
          ? { writes: 33, created: 28, updated: 0, reused: 3 }
          : { writes: 34, created: 28, updated: 1, reused: 2 };
  if (
    result.execution.summary.writes !== expected.writes ||
    result.execution.summary.created !== expected.created ||
    result.execution.summary.updated !== expected.updated ||
    result.execution.summary.reused !== expected.reused ||
    result.execution.summary.destructive !== 0 ||
    result.execution.summary.skippedManualReview !== 18
  ) {
    throw new Error("P8真实执行结果与获批Operation集合不一致");
  }
  if ((await gitStatus()) !== statusBefore) throw new Error("P8真实执行修改了Content Lab工作区");
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

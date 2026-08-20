import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import {
  projectBootstrapOperationIdSchema,
  projectBootstrapProposalSchema,
} from "../../packages/contracts/src/index.ts";
import {
  createPlaneCeProjectBootstrap,
  createProjectWorkspaceProvisioner,
} from "../../packages/project-runtime/src/index.ts";

if (process.env.CHAT_PLANE_CE_REAL_TEST !== "1") {
  throw new Error("真实Plane CE门会创建持久Project和Git目录；请显式设置CHAT_PLANE_CE_REAL_TEST=1");
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`缺少真实门配置:${name}`);
  return value;
}

const operationId = projectBootstrapOperationIdSchema.parse(
  required("CHAT_PLANE_CE_REAL_TEST_OPERATION_ID"),
);
const proposal = projectBootstrapProposalSchema.parse({
  name: required("CHAT_PLANE_CE_REAL_TEST_PROJECT_NAME"),
  objective: required("CHAT_PLANE_CE_REAL_TEST_OBJECTIVE"),
  planeWorkspaceSlug: required("CHAT_PLANE_CE_REAL_TEST_WORKSPACE_SLUG"),
  planeProjectIdentifier: required("CHAT_PLANE_CE_REAL_TEST_PROJECT_IDENTIFIER"),
  workspaceRootId: required("CHAT_PLANE_CE_REAL_TEST_ROOT_ID"),
  directoryName: required("CHAT_PLANE_CE_REAL_TEST_DIRECTORY_NAME"),
  initializerProfile: process.env.CHAT_PLANE_CE_REAL_TEST_PROFILE ?? "ai_learning",
  initialModules: JSON.parse(process.env.CHAT_PLANE_CE_REAL_TEST_MODULES_JSON ?? "[]"),
});
const candidateSha256 = createHash("sha256")
  .update(JSON.stringify({ operationId, proposal }))
  .digest("hex");
const plane = createPlaneCeProjectBootstrap(process.env);
const workspace = await createProjectWorkspaceProvisioner(process.env);
if (plane === undefined || workspace === undefined) {
  throw new Error("真实门需要完整Plane CE与Project Creation Root配置");
}

if (process.env.CHAT_PLANE_CE_REAL_TEST_REUSE !== "1") {
  await Promise.all([
    plane.preflight({
      workspaceSlug: proposal.planeWorkspaceSlug,
      projectIdentifier: proposal.planeProjectIdentifier,
      projectName: proposal.name,
    }),
    workspace.preflight({
      rootId: proposal.workspaceRootId,
      directoryName: proposal.directoryName,
    }),
  ]);
}

const workspaceResult = await workspace.provision({
  operationId,
  candidateSha256,
  proposal,
});
if (workspaceResult.status !== "completed") {
  throw new Error(`真实Workspace初始化失败:${workspaceResult.errorCode}`);
}
const planeResult = await plane.provision({ operationId, candidateSha256, proposal });
if (planeResult.status !== "completed") {
  throw new Error(`真实Plane初始化未完成:${planeResult.status}:${planeResult.errorCode}`);
}
const [workspaceReconciled, planeReconciled] = await Promise.all([
  workspace.reconcile({ operationId, candidateSha256, proposal }),
  plane.reconcile({ operationId, candidateSha256, proposal }),
]);
if (workspaceReconciled.status !== "completed" || planeReconciled.status !== "completed") {
  throw new Error(
    `真实对账未完成:workspace=${workspaceReconciled.status},plane=${planeReconciled.status}`,
  );
}

const roots = JSON.parse(required("CHAT_PROJECT_CREATION_ROOTS_JSON")) as Array<{
  rootId?: unknown;
  canonicalPath?: unknown;
}>;
const root = roots.find((item) => item.rootId === proposal.workspaceRootId);
if (typeof root?.canonicalPath !== "string") throw new Error("真实门无法解析目标Root");
const target = resolve(root.canonicalPath, proposal.directoryName);
await Promise.all([
  access(resolve(target, ".git")),
  access(resolve(target, "README.md")),
  access(resolve(target, ".chat/project-bootstrap.json")),
]);

process.stdout.write(
  `${JSON.stringify({
    status: "ready",
    planeVersion: plane.describe().providerVersion,
    planeProjectId: planeResult.planeProjectId,
    workspace: workspaceResult.workspaceLabel,
  })}\n`,
);

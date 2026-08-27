import type {
  AgentProfileAgentKey,
  AgentProfileDto,
  AgentVersion,
  AgentVersionId,
  PrincipalId,
} from "@chat/contracts";
import { hashCanonical } from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import { forbidden, revisionConflict } from "./errors.js";
import { getAgentProfile } from "./prompt-studio-use-cases.js";

export interface CurrentAgentRuntimeBinding {
  readonly profile: AgentProfileDto;
  readonly agentVersion?: AgentVersion | undefined;
  readonly runtimeProfileSha256?: string | undefined;
  readonly workspaceGrantSha256?: string | undefined;
}

/**
 * Run创建与Executor授权共用的Agent Version/Root/scoped Pi Profile复核。
 * canonical path留在Provider内；Product只冻结不可逆Grant SHA与无密钥Runtime投影Hash。
 */
export async function resolveCurrentAgentRuntimeBinding(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly agentKey: AgentProfileAgentKey;
    readonly agentVersionId?: AgentVersionId | undefined;
    readonly agentVersionSha256?: string | undefined;
    readonly workspaceRootId?: string | undefined;
  },
): Promise<CurrentAgentRuntimeBinding> {
  const profile = await getAgentProfile(deps, {
    principalId: input.principalId,
    agentKey: input.agentKey,
    ...(input.workspaceRootId === undefined ? {} : { workspaceRootId: input.workspaceRootId }),
  });
  const runtimeBaseline = profile.runtimeBaseline;
  const agentVersion =
    input.agentVersionId === undefined
      ? undefined
      : profile.versions.find((version) => version.agentVersionId === input.agentVersionId);
  if (
    input.agentVersionId !== undefined &&
    (agentVersion === undefined || agentVersion.sha256 !== input.agentVersionSha256)
  ) {
    throw revisionConflict("Workflow或会话引用的Agent Version不存在或Hash已变化");
  }
  if (agentVersion !== undefined && runtimeBaseline === undefined) {
    throw revisionConflict("Agent Version缺少可复核的当前Runtime Profile");
  }
  if (
    agentVersion?.scope.kind === "workspace" &&
    agentVersion.scope.rootId !== input.workspaceRootId
  ) {
    throw forbidden("Workspace Agent Version不能用于其他Workspace或无Workspace的会话");
  }
  if (agentVersion !== undefined) {
    // Global Version钉住无Workspace基线；当前scoped Profile仍需保证所选Tool真实存在。
    const baselineProfile =
      agentVersion.scope.kind === "global" && input.workspaceRootId !== undefined
        ? await getAgentProfile(deps, { principalId: input.principalId, agentKey: input.agentKey })
        : profile;
    const versionBaseline = baselineProfile.runtimeBaseline;
    const versionVariant = versionBaseline?.variants.find(
      (variant) => variant.variantKey === agentVersion.runtime.baseVariantKey,
    );
    const currentVariant = runtimeBaseline!.variants.find(
      (variant) => variant.variantKey === agentVersion.runtime.baseVariantKey,
    );
    const currentToolNames = new Set(currentVariant?.tools.map((tool) => tool.name) ?? []);
    if (
      versionBaseline === undefined ||
      versionVariant === undefined ||
      agentVersion.baselineRef.packageName !== versionBaseline.packageName ||
      agentVersion.baselineRef.packageVersion !== versionBaseline.packageVersion ||
      agentVersion.baselineRef.managedSource !== versionBaseline.managedSource ||
      agentVersion.baselineRef.managedSourceRevision !== versionBaseline.managedSourceRevision ||
      agentVersion.baselineRef.variantKey !== versionVariant.variantKey ||
      agentVersion.baselineRef.capabilityCatalogSha256 !== versionVariant.capabilityCatalogSha256
    ) {
      throw revisionConflict("Agent Version引用的Pi运行基线已经变化，请显式创建新版本");
    }
    if (
      currentVariant === undefined ||
      agentVersion.enabledToolNames.some((toolName) => !currentToolNames.has(toolName))
    ) {
      throw revisionConflict("Agent Version的Tool不存在于当前Workspace运行目录");
    }
  }
  const workspaceGrantSha256 =
    input.workspaceRootId === undefined
      ? undefined
      : deps.workspaceRoots?.list().find((root) => root.rootId === input.workspaceRootId)
          ?.grantSha256;
  if (input.workspaceRootId !== undefined && workspaceGrantSha256 === undefined) {
    throw revisionConflict("Workspace Root缺少可复核的授权指纹");
  }
  return {
    profile,
    ...(agentVersion === undefined ? {} : { agentVersion }),
    ...(runtimeBaseline === undefined
      ? {}
      : { runtimeProfileSha256: hashCanonical("agent-runtime-profile.v1", runtimeBaseline) }),
    ...(workspaceGrantSha256 === undefined ? {} : { workspaceGrantSha256 }),
  };
}

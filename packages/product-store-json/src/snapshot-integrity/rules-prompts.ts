import {
  DIRECT_PROMPT_COMPILER_V2_VERSION,
  DIRECT_PROMPT_COMPILER_V3_VERSION,
  DIRECT_PROMPT_COMPILER_V4_VERSION,
  DIRECT_PROMPT_COMPILER_VERSION,
  DIRECT_PROMPT_INPUT_TOKEN_LIMIT,
  DIRECT_PROMPT_METER_VERSION,
  DIRECT_PROMPT_PROFILE_V2_VERSION,
  DIRECT_PROMPT_PROFILE_VERSION,
  DIRECT_PROMPT_TOOL_TOKEN_RESERVE,
  LEGACY_DIRECT_PROMPT_COMPILER_VERSION,
  LEGACY_DIRECT_PROMPT_PROFILE_VERSION,
  promptFragmentScopeSchema,
  agentVersionHashDomain,
  inspectDirectAgentConfigurationSource,
  toAgentVersionHashInput,
  type ProductSnapshot,
} from "@chat/contracts";
import {
  hashCanonical,
  computeWorkflowNodePromptOverrideIdentitySha256,
  computeWorkflowNodePromptOverrideSha256,
  assertRuleLifecycleTransition,
  assertRuleRevisionAppend,
  assertRuleRevisionIntegrity,
  selectRules,
  assertWorkflowPolicyResolutionIntegrity,
  evaluateNoteLowRiskAutoPolicy,
  NOTE_LOW_RISK_AUTO_POLICY_RESOURCE_ID,
  NOTE_LOW_RISK_AUTO_POLICY_REVISION,
  NOTE_LOW_RISK_AUTO_POLICY_SHA256,
  assertPromptAssembly,
  assertPromptFragmentRevision,
} from "@chat/domain";
import type { Fail } from "./shared.js";

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Agent配置版本（集中化Agent配置管理）：版本号唯一占用、
 * System Prompt与版本Hash一致、派生来源存在且派生关系单调。
 */
export function assertAgentVersions(snapshot: ProductSnapshot, fail: Fail): void {
  const { agentVersions } = snapshot.entities;
  const versionSlots = new Map<string, string>();
  for (const version of Object.values(agentVersions)) {
    const versionSlot = `${version.ownerPrincipalId}\u0000${version.agentKey}\u0000${String(version.version)}`;
    const occupiedBy = versionSlots.get(versionSlot);
    if (occupiedBy !== undefined) {
      fail(`agentVersion ${version.agentVersionId}与${occupiedBy}重复占用Principal/Agent版本号`);
    }
    versionSlots.set(versionSlot, version.agentVersionId);
    if (
      version.systemPrompt.mode === "replace" &&
      version.systemPrompt.sha256 !==
        hashCanonical("agent-system-prompt.v1", {
          bodyMarkdown: version.systemPrompt.bodyMarkdown,
        })
    ) {
      fail(`agentVersion ${version.agentVersionId} System Prompt Hash不一致`);
    }
    if (
      version.sha256 !==
      hashCanonical(agentVersionHashDomain(version), toAgentVersionHashInput(version))
    ) {
      fail(`agentVersion ${version.agentVersionId} Hash不一致`);
    }
    const basedOn =
      version.basedOnVersionId === undefined ? undefined : agentVersions[version.basedOnVersionId];
    if (version.basedOnVersionId !== undefined && basedOn === undefined) {
      fail(`agentVersion ${version.agentVersionId}派生来源不存在`);
    }
    if (
      basedOn !== undefined &&
      (basedOn.agentKey !== version.agentKey ||
        basedOn.ownerPrincipalId !== version.ownerPrincipalId ||
        JSON.stringify(basedOn.scope) !== JSON.stringify(version.scope) ||
        version.version <= basedOn.version)
    ) {
      fail(`agentVersion ${version.agentVersionId}派生关系无效`);
    }
  }
}

export function assertWorkflowPolicyResolutions(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const candidateIds = new Set<string>();
  for (const resolution of Object.values(entities.workflowPolicyResolutions)) {
    try {
      assertWorkflowPolicyResolutionIntegrity(resolution);
    } catch (error) {
      fail(
        `workflowPolicyResolution ${resolution.workflowPolicyResolutionId} ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (candidateIds.has(resolution.noteCandidateId)) {
      fail(`workflowPolicyResolution ${resolution.workflowPolicyResolutionId} Candidate重复`);
    }
    candidateIds.add(resolution.noteCandidateId);
    const run = entities.runs[resolution.productRunId];
    const runSpec = entities.workflowRunSpecs[resolution.workflowRunSpecId];
    const candidate = entities.noteCandidates[resolution.noteCandidateId];
    const review = runSpec?.reviewResolutions.find(
      (item) => item.definitionNodeId === resolution.definitionNodeId,
    );
    if (
      run?.runKind !== "note_capture" ||
      run.workflowRunSpecId !== resolution.workflowRunSpecId ||
      runSpec?.productRunId !== resolution.productRunId ||
      runSpec.sha256 !== resolution.workflowRunSpecSha256 ||
      candidate?.productRunId !== resolution.productRunId ||
      candidate.sha256 !== resolution.candidateSha256 ||
      candidate.revision < resolution.candidateRevision ||
      review?.mode !== "auto_continue_if_policy_allows" ||
      review.actor !== "system_policy" ||
      review.policyRef?.resourceId !== NOTE_LOW_RISK_AUTO_POLICY_RESOURCE_ID ||
      review.policyRef.revision !== NOTE_LOW_RISK_AUTO_POLICY_REVISION ||
      review.policyRef.sha256 !== NOTE_LOW_RISK_AUTO_POLICY_SHA256
    ) {
      fail(`workflowPolicyResolution ${resolution.workflowPolicyResolutionId} 绑定证据无效`);
    }
    if (candidate !== undefined) {
      const expected = evaluateNoteLowRiskAutoPolicy(candidate);
      if (
        expected.outcome !== resolution.outcome ||
        expected.reasonCode !== resolution.reasonCode ||
        (resolution.outcome === "allowed" && candidate.status !== "confirmed")
      ) {
        fail(`workflowPolicyResolution ${resolution.workflowPolicyResolutionId} 决策结果不一致`);
      }
    }
    if (
      resolution.outcome === "allowed" &&
      Object.values(entities.noteDecisions).some(
        (decision) => decision.noteCandidateId === resolution.noteCandidateId,
      )
    ) {
      fail(
        `workflowPolicyResolution ${resolution.workflowPolicyResolutionId} 伪造或混入人工Decision`,
      );
    }
    const owningNode = Object.values(entities.workflowNodeRuns).find(
      (node) =>
        node.productRunId === resolution.productRunId &&
        node.definitionNodeId === resolution.definitionNodeId &&
        Object.values(entities.nodeRunTransitions).some(
          (transition) =>
            transition.workflowNodeRunId === node.workflowNodeRunId &&
            (resolution.outcome === "allowed"
              ? transition.relatedProductRef?.kind === "workflow_policy_resolution" &&
                transition.relatedProductRef.id === resolution.workflowPolicyResolutionId &&
                transition.relatedProductRef.revision === resolution.revision &&
                transition.relatedProductRef.sha256 === resolution.sha256
              : transition.toStatus === "waiting_human" &&
                transition.relatedProductRef?.kind === "note_candidate" &&
                transition.relatedProductRef.id === resolution.noteCandidateId),
        ),
    );
    const output =
      owningNode?.outputManifestId === undefined
        ? undefined
        : entities.nodeValueManifests[owningNode.outputManifestId];
    if (
      owningNode === undefined ||
      output === undefined ||
      !output.slots.some((slot) =>
        slot.refs.some(
          (ref) =>
            ref.kind === "workflow_policy_resolution" &&
            ref.id === resolution.workflowPolicyResolutionId &&
            ref.revision === resolution.revision &&
            ref.sha256 === resolution.sha256,
        ),
      )
    ) {
      fail(`workflowPolicyResolution ${resolution.workflowPolicyResolutionId} 缺少Node证据`);
    }
  }
}

export function assertRules(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const normalizedTagKeys = new Set<string>();
  for (const tag of Object.values(entities.ruleTags)) {
    const expectedKey = normalizeRuleTagKey(tag.name);
    const ownerKey = `${tag.ownerPrincipalId}\0${tag.normalizedKey}`;
    if (tag.normalizedKey !== expectedKey || normalizedTagKeys.has(ownerKey)) {
      fail(`ruleTag ${tag.ruleTagId} normalizedKey无效或Owner内重复`);
    }
    normalizedTagKeys.add(ownerKey);
  }

  const revisionsByRule = new Map<string, (typeof entities.ruleRevisions)[string][]>();
  for (const revision of Object.values(entities.ruleRevisions)) {
    try {
      assertRuleRevisionIntegrity(revision);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    if (entities.rules[revision.ruleId] === undefined) {
      fail(`ruleRevision ${revision.ruleRevisionId} 悬空Rule`);
    }
    const list = revisionsByRule.get(revision.ruleId) ?? [];
    list.push(revision);
    revisionsByRule.set(revision.ruleId, list);
  }

  for (const rule of Object.values(entities.rules)) {
    const revisions = (revisionsByRule.get(rule.ruleId) ?? []).sort(
      (left, right) => left.revision - right.revision,
    );
    const current = entities.ruleRevisions[rule.currentRevisionId];
    if (
      revisions.length === 0 ||
      current === undefined ||
      current.ruleId !== rule.ruleId ||
      current.revision !== rule.currentRevisionNumber ||
      current.sha256 !== rule.currentRevisionSha256 ||
      revisions.at(-1)?.ruleRevisionId !== current.ruleRevisionId
    ) {
      fail(`rule ${rule.ruleId} Current/Highest Revision绑定不一致`);
    }
    for (let index = 0; index < revisions.length; index += 1) {
      const revision = revisions[index];
      if (revision?.revision !== index + 1) fail(`rule ${rule.ruleId} Revision号不连续`);
      if (index > 0) {
        try {
          assertRuleRevisionAppend({ current: revisions[index - 1]!, next: revision! });
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
      }
      if (revision !== undefined) assertRuleRevisionReferences(snapshot, rule, revision, fail);
    }
    assertRuleDecisionChain(snapshot, rule, fail);
  }

  const selectionRunIds = new Set<string>();
  for (const selection of Object.values(entities.ruleSelections)) {
    if (selectionRunIds.has(selection.productRunId)) {
      fail(`ruleSelection ${selection.ruleSelectionId} Run重复`);
    }
    selectionRunIds.add(selection.productRunId);
    const run = entities.runs[selection.productRunId];
    const session = run === undefined ? undefined : entities.sessions[run.sessionId];
    if (run?.runKind !== "planning" || session === undefined) {
      fail(`ruleSelection ${selection.ruleSelectionId} 必须绑定Planning Run`);
    }
    if (
      selection.context.projectId !== undefined &&
      entities.projects[selection.context.projectId]?.ownerPrincipalId !== session.ownerPrincipalId
    ) {
      fail(`ruleSelection ${selection.ruleSelectionId} Context Project越权`);
    }
    for (const tagId of selection.request.selectedTagIds) {
      if (entities.ruleTags[tagId]?.ownerPrincipalId !== session.ownerPrincipalId) {
        fail(`ruleSelection ${selection.ruleSelectionId} Tag越权或悬空`);
      }
    }
    const candidates = selection.candidates;
    for (const candidate of candidates) {
      const rule = entities.rules[candidate.ruleId];
      const revision = entities.ruleRevisions[candidate.ruleRevisionId];
      if (
        rule?.ownerPrincipalId !== session.ownerPrincipalId ||
        revision?.ruleId !== rule.ruleId ||
        revision.sha256 !== candidate.ruleRevisionSha256 ||
        revision.body.length !== candidate.contentCharacters ||
        JSON.stringify(revision.tagIds) !== JSON.stringify(candidate.tagIds) ||
        JSON.stringify(revision.scopes) !== JSON.stringify(candidate.scopes) ||
        JSON.stringify(revision.conflictsWithRuleIds) !==
          JSON.stringify(candidate.conflictsWithRuleIds)
      ) {
        fail(`ruleSelection ${selection.ruleSelectionId} Candidate引用或正文长度不一致`);
      }
    }
    let recomputed;
    try {
      recomputed = selectRules({
        candidates,
        request: {
          ...selection.request,
          context: selection.context,
          budget: selection.budget,
        },
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    if (
      recomputed === undefined ||
      recomputed.sha256 !== selection.sha256 ||
      JSON.stringify(recomputed) !==
        JSON.stringify({
          status: selection.status,
          selected: selection.selected,
          excluded: selection.excluded,
          conflicts: selection.conflicts,
          diagnostics: selection.diagnostics,
          selectedContentCharacters: selection.selectedContentCharacters,
          sha256: selection.sha256,
        })
    ) {
      fail(`ruleSelection ${selection.ruleSelectionId} 选择算法结果或Hash不一致`);
    }
  }
}

export function assertPromptFragments(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const revisionsByFragment = new Map<
    string,
    (typeof entities.promptFragmentRevisions)[string][]
  >();
  for (const revision of Object.values(entities.promptFragmentRevisions)) {
    try {
      assertPromptFragmentRevision(revision);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    const aggregate = entities.promptFragments[revision.promptFragmentId];
    if (aggregate === undefined) {
      fail(`promptFragmentRevision ${revision.promptFragmentRevisionId} 悬空Fragment`);
    }
    if (revision.schemaVersion === "prompt-fragment-revision.v2") {
      const expectedPath =
        aggregate.scope.kind === "global"
          ? `.data/prompts/global/${revision.regionKey}/${revision.promptFragmentId}/${revision.promptFragmentRevisionId}.md`
          : `${aggregate.scope.rootId}/.chat/prompts/${revision.regionKey}/${revision.promptFragmentId}/${revision.promptFragmentRevisionId}.md`;
      if (revision.contentRef.sourceRelativePath !== expectedPath) {
        fail(
          `promptFragmentRevision ${revision.promptFragmentRevisionId} Markdown路径与Scope不一致`,
        );
      }
    }
    const list = revisionsByFragment.get(revision.promptFragmentId) ?? [];
    list.push(revision);
    revisionsByFragment.set(revision.promptFragmentId, list);
    if (revision.derivedFrom?.kind === "principal") {
      const source =
        entities.promptFragmentRevisions[revision.derivedFrom.promptFragmentRevisionId];
      const sourceAggregate =
        source === undefined ? undefined : entities.promptFragments[source.promptFragmentId];
      const owner = entities.promptFragments[revision.promptFragmentId]?.ownerPrincipalId;
      if (
        source === undefined ||
        sourceAggregate === undefined ||
        source.promptFragmentId !== revision.derivedFrom.promptFragmentId ||
        source.revision !== revision.derivedFrom.revision ||
        source.sha256 !== revision.derivedFrom.sha256 ||
        sourceAggregate.ownerPrincipalId !== owner
      ) {
        fail(`promptFragmentRevision ${revision.promptFragmentRevisionId} 用户派生来源非法`);
      }
    }
  }

  for (const fragment of Object.values(entities.promptFragments)) {
    if (!promptFragmentScopeSchema.safeParse(fragment.scope).success) {
      fail(`promptFragment ${fragment.promptFragmentId} Scope非法`);
    }
    const revisions = (revisionsByFragment.get(fragment.promptFragmentId) ?? []).sort(
      (left, right) => left.revision - right.revision,
    );
    const current = entities.promptFragmentRevisions[fragment.currentRevisionId];
    if (
      revisions.length === 0 ||
      current === undefined ||
      current.promptFragmentId !== fragment.promptFragmentId ||
      current.revision !== fragment.currentRevisionNumber ||
      current.sha256 !== fragment.currentRevisionSha256 ||
      revisions.at(-1)?.promptFragmentRevisionId !== current.promptFragmentRevisionId
    ) {
      fail(`promptFragment ${fragment.promptFragmentId} Current/Highest Revision绑定不一致`);
    }
    for (let index = 0; index < revisions.length; index += 1) {
      const revision = revisions[index];
      if (revision?.revision !== index + 1) {
        fail(`promptFragment ${fragment.promptFragmentId} Revision号不连续`);
      }
      if (index === 0 || revision === undefined) continue;
      const previous = revisions[index - 1]!;
      if (
        revision.supersedesRevisionId !== previous.promptFragmentRevisionId ||
        revision.supersedesRevisionSha256 !== previous.sha256
      ) {
        fail(`promptFragment ${fragment.promptFragmentId} Revision链断裂`);
      }
    }
  }
}

/**
 * Prompt Assembly是Run在发送当下冻结的输入事实。这里不能只验证对象自身Hash：
 * 还必须从Run、原始User Message和精确Prompt Revision反向重建投影，防止攻击者同时
 * 篡改正文与Hash，或把其他Session/Workspace的Prompt资产挂到当前Run。
 */
function workflowNodePromptOverrideBody(
  config: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const source = inspectDirectAgentConfigurationSource(config ?? {});
  if (!source.valid) return undefined;
  const temporary = config?.["agentTemporaryConfiguration"];
  if (source.source === "temporary" && typeof temporary === "object" && temporary !== null) {
    const systemPrompt = (temporary as Readonly<Record<string, unknown>>)["systemPrompt"];
    if (typeof systemPrompt === "object" && systemPrompt !== null) {
      const prompt = systemPrompt as Readonly<Record<string, unknown>>;
      if (prompt["mode"] === "replace" && typeof prompt["bodyMarkdown"] === "string") {
        return prompt["bodyMarkdown"];
      }
    }
  }
  return source.source === "legacy_prompt_override" &&
    typeof config?.["agentPromptOverride"] === "string"
    ? config["agentPromptOverride"]
    : undefined;
}

/** Definition、RunSpec与Assembly必须共用Contracts中的同一配置来源判定。 */
function assertDirectAgentConfigurationSources(snapshot: ProductSnapshot, fail: Fail): void {
  for (const revision of Object.values(snapshot.entities.workflowDefinitionRevisions)) {
    const stack = [...revision.semanticRoot.elements];
    while (stack.length > 0) {
      const element = stack.pop();
      if (element === undefined) continue;
      if (element.kind === "task" || element.kind === "composite") {
        if (element.nodeType !== "agent.direct") continue;
        const source = inspectDirectAgentConfigurationSource(element.config);
        if (!source.valid) {
          fail(
            `workflowDefinitionRevision ${revision.workflowDefinitionRevisionId} 节点${element.definitionNodeId} Agent配置来源非法:${source.reason}`,
          );
        }
        continue;
      }
      if (element.kind === "sequence") stack.push(...element.elements);
      else if (element.kind === "choice") {
        for (const branch of element.branches) stack.push(...branch.body.elements);
      } else stack.push(...element.body.elements);
    }
  }
  for (const runSpec of Object.values(snapshot.entities.workflowRunSpecs)) {
    for (const node of runSpec.nodeResolutions) {
      if (node.nodeType !== "agent.direct") continue;
      const source = inspectDirectAgentConfigurationSource(node.config);
      if (!source.valid) {
        fail(
          `workflowRunSpec ${runSpec.workflowRunSpecId} 节点${node.definitionNodeId} Agent配置来源非法:${source.reason}`,
        );
      }
    }
  }
}

export function assertPromptAssemblies(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  assertDirectAgentConfigurationSources(snapshot, fail);
  const assembliesByRun = new Map<string, (typeof entities.promptAssemblies)[string][]>();

  for (const assembly of Object.values(entities.promptAssemblies)) {
    try {
      assertPromptAssembly(assembly);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }

    const run = entities.runs[assembly.productRunId];
    const session = entities.sessions[assembly.productSessionId];
    const sourceMessage = entities.messages[assembly.sourceMessageId];
    const runSpec =
      run?.workflowRunSpecId === undefined
        ? undefined
        : entities.workflowRunSpecs[run.workflowRunSpecId];
    const definitionRevision =
      entities.workflowDefinitionRevisions[assembly.workflowDefinitionRevisionId];
    const isV3 = assembly.schemaVersion === "prompt-assembly.v3";
    const isV5 = assembly.schemaVersion === "prompt-assembly.v5";
    const isWorkflowAssembly = isV3 || isV5;
    if (
      run === undefined ||
      session === undefined ||
      sourceMessage === undefined ||
      definitionRevision === undefined ||
      run.sessionId !== assembly.productSessionId ||
      run.sourceMessageId !== assembly.sourceMessageId ||
      sourceMessage.sessionId !== assembly.productSessionId ||
      sourceMessage.role !== "user" ||
      runSpec?.productRunId !== assembly.productRunId ||
      runSpec.definitionRef.workflowDefinitionRevisionId !==
        assembly.workflowDefinitionRevisionId ||
      (!isWorkflowAssembly && runSpec.definitionRef.blueprintKey !== "direct") ||
      (isWorkflowAssembly && runSpec.definitionRef.blueprintKey === "direct")
    ) {
      fail(
        `promptAssembly ${assembly.promptAssemblyId} 与Run/Session/Message/WorkflowRevision绑定不一致`,
      );
    }

    if (isV5) {
      if (run.runKind !== "planning") {
        fail(`promptAssembly ${assembly.promptAssemblyId} V5只能绑定Planning Run`);
      }
      for (const roleAssembly of assembly.roleAssemblies) {
        const version = entities.agentVersions[roleAssembly.agentVersionRef.agentVersionId];
        const expectedPrompt =
          version?.systemPrompt.mode === "replace"
            ? {
                kind: "pi_coding_agent" as const,
                mode: "replace" as const,
                bodyMarkdown: version.systemPrompt.bodyMarkdown,
                sha256: version.systemPrompt.sha256,
              }
            : { kind: "pi_coding_agent" as const, mode: "inherit" as const };
        const expectedCapabilityRefs = roleAssembly.tools.capabilities.map((capability) => ({
          localName: capability.localName,
          capabilityId: capability.ref.capabilityId,
          descriptorSha256: capability.ref.descriptorSha256,
        }));
        const runNode = runSpec.nodeResolutions.find(
          (node) =>
            node.definitionNodeId === roleAssembly.definitionNodeId &&
            node.activation === "enabled",
        );
        if (
          version?.schemaVersion !== "agent-version.v2" ||
          version.sha256 !== roleAssembly.agentVersionRef.sha256 ||
          version.ownerPrincipalId !== session.ownerPrincipalId ||
          runNode === undefined ||
          !same(roleAssembly.piSystemPrompt, expectedPrompt) ||
          !same(roleAssembly.tools.names, version.enabledToolNames) ||
          !same(expectedCapabilityRefs, version.enabledCapabilityRefs) ||
          !same(roleAssembly.tools.resources, version.resources) ||
          (version.scope.kind === "workspace" &&
            (version.scope.rootId !== assembly.workspaceRootId ||
              assembly.workspaceGrantSha256 === undefined))
        ) {
          fail(
            `promptAssembly ${assembly.promptAssemblyId} 的${roleAssembly.role} Version/Capability/Scope绑定非法`,
          );
        }
      }
      const runAssemblies = assembliesByRun.get(assembly.productRunId) ?? [];
      runAssemblies.push(assembly);
      assembliesByRun.set(assembly.productRunId, runAssemblies);
      continue;
    }

    const isLegacy = assembly.compilerVersion === LEGACY_DIRECT_PROMPT_COMPILER_VERSION;
    const isV2 = assembly.schemaVersion === "prompt-assembly.v2";
    const isV4 = assembly.schemaVersion === "prompt-assembly.v4";
    if (
      (!isV3 && isLegacy && assembly.profileVersion !== LEGACY_DIRECT_PROMPT_PROFILE_VERSION) ||
      (isV2 &&
        ((assembly.compilerVersion !== DIRECT_PROMPT_COMPILER_V2_VERSION &&
          assembly.compilerVersion !== DIRECT_PROMPT_COMPILER_V3_VERSION) ||
          assembly.profileVersion !== DIRECT_PROMPT_PROFILE_V2_VERSION)) ||
      (isV4 &&
        (assembly.compilerVersion !== DIRECT_PROMPT_COMPILER_V4_VERSION ||
          assembly.profileVersion !== DIRECT_PROMPT_PROFILE_V2_VERSION)) ||
      (!isV3 &&
        !isLegacy &&
        !isV2 &&
        !isV4 &&
        (assembly.compilerVersion !== DIRECT_PROMPT_COMPILER_VERSION ||
          assembly.profileVersion !== DIRECT_PROMPT_PROFILE_VERSION))
    ) {
      fail(`promptAssembly ${assembly.promptAssemblyId} Profile与Compiler版本不匹配`);
    }
    if (
      isLegacy &&
      assembly.schemaVersion === "prompt-assembly.v1" &&
      (assembly.regions.length !== 0 ||
        assembly.workspaceRootId !== undefined ||
        assembly.systemPromptAppend !== "" ||
        assembly.userPrompt !== sourceMessage.content.text)
    ) {
      fail(`promptAssembly ${assembly.promptAssemblyId} 历史Direct投影非法`);
    }

    const assemblyRegions = isV3
      ? [...assembly.sharedRegions, ...assembly.nodes.flatMap((node) => node.regions)]
      : assembly.regions;
    const boundAgentVersions = (runSpec?.nodeResolutions ?? []).flatMap((node) => {
      const agentVersionId = node.config["agentVersionId"];
      const agentVersionSha256 = node.config["agentVersionSha256"];
      if (typeof agentVersionId !== "string" || typeof agentVersionSha256 !== "string") return [];
      const version = entities.agentVersions[agentVersionId];
      return version !== undefined &&
        version.sha256 === agentVersionSha256 &&
        version.ownerPrincipalId === session.ownerPrincipalId
        ? [version]
        : [];
    });
    const seenRevisionIds = new Set<string>();
    for (const [regionIndex, region] of assemblyRegions.entries()) {
      if (
        (region.mode === "default" &&
          region.fragments.some((fragment) => fragment.selectionKind !== "profile_default")) ||
        (region.mode === "replace" &&
          (region.fragments.length === 0 ||
            region.fragments.some((fragment) => fragment.selectionKind !== "explicit"))) ||
        (region.mode === "append" &&
          !region.fragments.some((fragment) => fragment.selectionKind === "explicit"))
      ) {
        fail(
          `promptAssembly ${assembly.promptAssemblyId} Region ${region.regionKey} 模式与来源类型不一致`,
        );
      }

      for (const fragment of region.fragments) {
        if (!promptFragmentScopeSchema.safeParse(fragment.scope).success) {
          fail(`promptAssembly ${assembly.promptAssemblyId} Fragment Scope非法`);
        }
        const seenKey = isV3
          ? `${String(regionIndex)}:${fragment.promptFragmentRevisionId}`
          : fragment.promptFragmentRevisionId;
        if (seenRevisionIds.has(seenKey)) {
          fail(`promptAssembly ${assembly.promptAssemblyId} 重复采用Prompt Revision`);
        }
        seenRevisionIds.add(seenKey);
        if (
          fragment.scope.kind === "workspace" &&
          fragment.scope.rootId !== assembly.workspaceRootId
        ) {
          fail(`promptAssembly ${assembly.promptAssemblyId} 采用了其他Workspace的Prompt Fragment`);
        }
        if (fragment.ownerKind === "system") {
          if (fragment.sourceRelativePath === undefined) {
            fail(`promptAssembly ${assembly.promptAssemblyId} System Prompt来源或Scope非法`);
          }
          if (fragment.selectionKind === "profile_default" && region.mode === "replace") {
            fail(`promptAssembly ${assembly.promptAssemblyId} Replace Region混入Profile默认来源`);
          }
          continue;
        }

        if (fragment.ownerKind === "workflow_node_override") {
          const assemblyNode = isV3
            ? assembly.nodes.find((node) =>
                node.regions.some((candidateRegion) =>
                  candidateRegion.fragments.some(
                    (candidate) =>
                      candidate.promptFragmentRevisionId === fragment.promptFragmentRevisionId,
                  ),
                ),
              )
            : undefined;
          const runNode = isV3
            ? assemblyNode === undefined
              ? undefined
              : runSpec?.nodeResolutions.find(
                  (node) => node.definitionNodeId === assemblyNode.definitionNodeId,
                )
            : isV2 || isV4
              ? runSpec?.nodeResolutions.find(
                  (node) => node.nodeType === "agent.direct" && node.activation === "enabled",
                )
              : undefined;
          const bodyMarkdown = workflowNodePromptOverrideBody(runNode?.config);
          const definitionNodeId = assemblyNode?.definitionNodeId ?? runNode?.definitionNodeId;
          const nodeType = assemblyNode?.nodeType ?? runNode?.nodeType;
          const expectedIdentity =
            definitionNodeId === undefined
              ? undefined
              : computeWorkflowNodePromptOverrideIdentitySha256({
                  workflowDefinitionRevisionId: assembly.workflowDefinitionRevisionId,
                  definitionNodeId,
                });
          const expectedSha256 =
            definitionNodeId === undefined ||
            nodeType === undefined ||
            typeof bodyMarkdown !== "string"
              ? undefined
              : computeWorkflowNodePromptOverrideSha256({
                  workflowDefinitionRevisionId: assembly.workflowDefinitionRevisionId,
                  definitionNodeId,
                  nodeType,
                  bodyMarkdown,
                });
          if (
            runNode === undefined ||
            nodeType === undefined ||
            runNode.nodeType !== nodeType ||
            typeof bodyMarkdown !== "string" ||
            bodyMarkdown.trim() === "" ||
            fragment.content.kind !== "markdown" ||
            fragment.content.bodyMarkdown !== bodyMarkdown ||
            fragment.promptFragmentId !== `pfg_${expectedIdentity?.slice(0, 32) ?? ""}` ||
            fragment.promptFragmentRevisionId !== `pfr_${expectedSha256?.slice(0, 32) ?? ""}` ||
            fragment.sha256 !== expectedSha256 ||
            fragment.revision !== 1 ||
            fragment.scope.kind !== "global" ||
            fragment.sourceRelativePath !== undefined ||
            fragment.selectionKind !== "explicit" ||
            fragment.regionKey !== "agent_identity"
          ) {
            fail(`promptAssembly ${assembly.promptAssemblyId} Workflow节点Prompt来源绑定不一致`);
          }
          continue;
        }

        const agentVersion = boundAgentVersions.find(
          (version) =>
            version.systemPrompt.mode === "replace" &&
            fragment.content.kind === "markdown" &&
            version.systemPrompt.sha256 === fragment.sha256 &&
            version.systemPrompt.bodyMarkdown === fragment.content.bodyMarkdown &&
            JSON.stringify(version.scope) === JSON.stringify(fragment.scope),
        );
        if (agentVersion !== undefined && agentVersion.systemPrompt.mode === "replace") {
          const identity = hashCanonical("id.agent-version-system-prompt.v1", {
            agentVersionId: agentVersion.agentVersionId,
            agentVersionSha256: agentVersion.sha256,
          });
          if (
            fragment.promptFragmentId !== `pfg_${identity.slice(0, 32)}` ||
            fragment.promptFragmentRevisionId !==
              `pfr_${agentVersion.systemPrompt.sha256.slice(0, 32)}` ||
            fragment.revision !== agentVersion.version ||
            fragment.title !== `${agentVersion.title} · System Prompt` ||
            fragment.regionKey !== "agent_identity" ||
            fragment.selectionKind !== "explicit" ||
            fragment.sourceRelativePath !== undefined
          ) {
            fail(`promptAssembly ${assembly.promptAssemblyId} Agent Version Prompt来源绑定不一致`);
          }
          continue;
        }

        const revision = entities.promptFragmentRevisions[fragment.promptFragmentRevisionId];
        const aggregate = entities.promptFragments[fragment.promptFragmentId];
        const contentMatches =
          revision?.schemaVersion === "prompt-fragment-revision.v2"
            ? revision.contentRef.contentSha256 ===
                hashCanonical("prompt-file-content.v1", fragment.content) &&
              revision.contentRef.sourceRelativePath === fragment.sourceRelativePath &&
              revision.contentRef.contentKind === fragment.content.kind &&
              (fragment.content.kind !== "key_value" ||
                revision.contentRef.key === fragment.content.key)
            : revision !== undefined &&
              JSON.stringify(revision.content) === JSON.stringify(fragment.content);
        if (
          revision === undefined ||
          aggregate === undefined ||
          aggregate.ownerPrincipalId !== session.ownerPrincipalId ||
          revision.promptFragmentId !== fragment.promptFragmentId ||
          revision.revision !== fragment.revision ||
          revision.sha256 !== fragment.sha256 ||
          revision.title !== fragment.title ||
          revision.regionKey !== fragment.regionKey ||
          !contentMatches ||
          JSON.stringify(aggregate.scope) !== JSON.stringify(fragment.scope) ||
          fragment.selectionKind === "profile_default"
        ) {
          fail(`promptAssembly ${assembly.promptAssemblyId} Principal Prompt来源绑定不一致`);
        }
      }
    }

    const systemPromptAppend = (isV3 ? assembly.sharedRegions : assembly.regions)
      .filter((region) => region.placement === "system" && region.renderedText !== "")
      .filter(
        (region) =>
          (assembly.schemaVersion !== "prompt-assembly.v2" &&
            assembly.schemaVersion !== "prompt-assembly.v4") ||
          assembly.piSystemPrompt === undefined ||
          region.regionKey !== "agent_identity",
      )
      .map((region) => region.renderedText)
      .join("\n\n");
    if (isV3) {
      const runNodes = new Map(
        runSpec?.nodeResolutions
          .filter((node) => node.activation === "enabled")
          .map((node) => [node.definitionNodeId, node.nodeType]) ?? [],
      );
      for (const node of assembly.nodes) {
        if (runNodes.get(node.definitionNodeId) !== node.nodeType) {
          fail(`promptAssembly ${assembly.promptAssemblyId} 节点与RunSpec不一致`);
        }
        const rendered = node.regions
          .filter((region) => region.placement === "system" && region.renderedText !== "")
          .filter(
            (region) => node.piSystemPrompt === undefined || region.regionKey !== "agent_identity",
          )
          .map((region) => region.renderedText)
          .join("\n\n");
        if (rendered !== node.systemPromptAppend) {
          fail(`promptAssembly ${assembly.promptAssemblyId} 节点System投影非法`);
        }
      }
    } else if (
      assembly.schemaVersion === "prompt-assembly.v2" ||
      assembly.schemaVersion === "prompt-assembly.v4"
    ) {
      const current = assembly.messages.at(-1);
      if (
        assembly.systemPromptAppend !== systemPromptAppend ||
        current?.role !== "user" ||
        current.text !== sourceMessage.content.text ||
        current.source.kind !== "current_input" ||
        current.source.messageId !== sourceMessage.messageId ||
        current.source.sessionSequence !== sourceMessage.sessionSequence ||
        current.source.sha256 !==
          hashCanonical("message.v1", {
            messageId: sourceMessage.messageId,
            sessionId: sourceMessage.sessionId,
            sessionSequence: sourceMessage.sessionSequence,
            role: sourceMessage.role,
            content: sourceMessage.content,
          })
      ) {
        fail(
          `promptAssembly ${assembly.promptAssemblyId} V2最终Instructions/Current Message投影非法`,
        );
      }
      const history = assembly.messages.slice(0, -1);
      if (history.length % 2 !== 0) {
        fail(`promptAssembly ${assembly.promptAssemblyId} V2历史没有保持完整问答对`);
      }
      for (const message of history) {
        if (message.source.kind !== "product_message") {
          fail(`promptAssembly ${assembly.promptAssemblyId} V2历史来源类型非法`);
        }
        const productMessage = entities.messages[message.source.messageId];
        if (
          productMessage === undefined ||
          productMessage.sessionId !== assembly.productSessionId ||
          productMessage.role !== message.role ||
          productMessage.content.text !== message.text ||
          productMessage.sessionSequence !== message.source.sessionSequence ||
          productMessage.sessionSequence >= sourceMessage.sessionSequence ||
          hashCanonical("message.v1", {
            messageId: productMessage.messageId,
            sessionId: productMessage.sessionId,
            sessionSequence: productMessage.sessionSequence,
            role: productMessage.role,
            content: productMessage.content,
          }) !== message.source.sha256
        ) {
          fail(`promptAssembly ${assembly.promptAssemblyId} V2历史Message来源绑定非法`);
        }
      }
      for (let index = 0; index < history.length; index += 2) {
        const user = history[index];
        const assistant = history[index + 1];
        if (
          user?.role !== "user" ||
          assistant?.role !== "assistant" ||
          user.source.kind !== "product_message" ||
          assistant.source.kind !== "product_message"
        ) {
          fail(`promptAssembly ${assembly.promptAssemblyId} V2历史角色顺序非法`);
        }
        const assistantMessage = entities.messages[assistant.source.messageId];
        const historyRun =
          assistantMessage?.sourceRunId === undefined
            ? undefined
            : entities.runs[assistantMessage.sourceRunId];
        if (
          historyRun === undefined ||
          historyRun.sessionId !== assembly.productSessionId ||
          historyRun.status !== "succeeded" ||
          historyRun.sourceMessageId !== user.source.messageId ||
          historyRun.finalMessageId !== assistant.source.messageId ||
          user.source.sessionSequence >= assistant.source.sessionSequence
        ) {
          fail(`promptAssembly ${assembly.promptAssemblyId} V2历史不是正式提交的问答结果`);
        }
      }
      const estimate = (text: string): number =>
        Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 3));
      if (
        assembly.budget.meterVersion !== DIRECT_PROMPT_METER_VERSION ||
        assembly.budget.inputTokenLimit !== DIRECT_PROMPT_INPUT_TOKEN_LIMIT ||
        assembly.tools.estimatedTokens !== DIRECT_PROMPT_TOOL_TOKEN_RESERVE ||
        assembly.budget.toolsEstimatedTokens !== DIRECT_PROMPT_TOOL_TOKEN_RESERVE ||
        assembly.budget.instructionsEstimatedTokens !==
          (assembly.systemPromptAppend === "" ? 0 : estimate(assembly.systemPromptAppend)) ||
        assembly.messages.some((message) => message.estimatedTokens !== estimate(message.text)) ||
        assembly.budget.messagesEstimatedTokens !==
          assembly.messages.reduce((total, message) => total + message.estimatedTokens, 0)
      ) {
        fail(`promptAssembly ${assembly.promptAssemblyId} V2输入预算证据非法`);
      }
    } else {
      const messageContext = assembly.regions
        .filter((region) => region.placement === "messages" && region.renderedText !== "")
        .map((region) => region.renderedText)
        .join("\n\n");
      const userPrompt = [
        ...(messageContext === "" ? [] : ["# Chat 提示词上下文", messageContext]),
        "# 当前输入 [current_input]",
        sourceMessage.content.text,
      ].join("\n\n");
      if (
        !isLegacy &&
        (assembly.systemPromptAppend !== systemPromptAppend || assembly.userPrompt !== userPrompt)
      ) {
        fail(
          `promptAssembly ${assembly.promptAssemblyId} 最终System/User Prompt不是Region与原始消息的确定性投影`,
        );
      }
    }

    const runAssemblies = assembliesByRun.get(assembly.productRunId) ?? [];
    runAssemblies.push(assembly);
    assembliesByRun.set(assembly.productRunId, runAssemblies);
  }

  for (const run of Object.values(entities.runs)) {
    const count = assembliesByRun.get(run.productRunId)?.length ?? 0;
    // 历史Planning/Note Run允许没有V3；新命令会原子冻结一个。Direct自v1起强制1:1。
    if (run.runKind === "direct_agent" ? count !== 1 : count > 1) {
      fail(`run ${run.productRunId} 的Prompt Assembly数量无效`);
    }
  }
}

function assertRuleRevisionReferences(
  snapshot: ProductSnapshot,
  rule: ProductSnapshot["entities"]["rules"][string],
  revision: ProductSnapshot["entities"]["ruleRevisions"][string],
  fail: Fail,
): void {
  const { entities } = snapshot;
  const originOwner =
    revision.origin.kind === "assistant_candidate"
      ? entities.sessions[entities.messages[revision.origin.sourceMessageId]?.sessionId ?? ""]
          ?.ownerPrincipalId
      : revision.origin.principalId;
  if (originOwner !== rule.ownerPrincipalId)
    fail(`ruleRevision ${revision.ruleRevisionId} Origin越权`);
  for (const tagId of revision.tagIds) {
    if (entities.ruleTags[tagId]?.ownerPrincipalId !== rule.ownerPrincipalId) {
      fail(`ruleRevision ${revision.ruleRevisionId} Tag越权或悬空`);
    }
  }
  for (const conflictId of revision.conflictsWithRuleIds) {
    if (entities.rules[conflictId]?.ownerPrincipalId !== rule.ownerPrincipalId) {
      fail(`ruleRevision ${revision.ruleRevisionId} 冲突Rule越权或悬空`);
    }
  }
  for (const scope of revision.scopes) {
    if (scope.kind === "contextual" && scope.projectId !== undefined) {
      const project = entities.projects[scope.projectId];
      const methodMatches =
        scope.projectMethodProfileId === undefined ||
        Object.values(entities.projectMethodSnapshots).some(
          (method) =>
            method.projectId === project?.projectId &&
            method.profileId === scope.projectMethodProfileId,
        );
      const stageMatches =
        scope.projectStageKey === undefined ||
        Object.values(entities.projectStages).some(
          (stage) => stage.projectId === project?.projectId && stage.key === scope.projectStageKey,
        );
      if (project?.ownerPrincipalId !== rule.ownerPrincipalId || !methodMatches || !stageMatches) {
        fail(`ruleRevision ${revision.ruleRevisionId} Scope Project/Method/Stage无效`);
      }
    }
  }
  for (const source of revision.sourceCases) {
    const owner =
      source.kind === "message"
        ? entities.sessions[entities.messages[source.messageId]?.sessionId ?? ""]?.ownerPrincipalId
        : source.kind === "product_run"
          ? entities.sessions[entities.runs[source.productRunId]?.sessionId ?? ""]?.ownerPrincipalId
          : entities.projects[entities.projectDecisions[source.projectDecisionId]?.projectId ?? ""]
              ?.ownerPrincipalId;
    if (owner !== rule.ownerPrincipalId) {
      fail(`ruleRevision ${revision.ruleRevisionId} Source Case越权或悬空`);
    }
  }
}

function assertRuleDecisionChain(
  snapshot: ProductSnapshot,
  rule: ProductSnapshot["entities"]["rules"][string],
  fail: Fail,
): void {
  const decisions = Object.values(snapshot.entities.ruleDecisions)
    .filter((decision) => decision.ruleId === rule.ruleId)
    .sort((left, right) => left.decidedAt.localeCompare(right.decidedAt));
  let lifecycle: ProductSnapshot["entities"]["rules"][string]["lifecycle"] = "candidate";
  let lastExpectedRevision = 0;
  for (const decision of decisions) {
    const revision = snapshot.entities.ruleRevisions[decision.boundRevisionId];
    if (
      revision?.ruleId !== rule.ruleId ||
      revision.sha256 !== decision.boundRevisionSha256 ||
      decision.fromLifecycle !== lifecycle ||
      decision.expectedRuleRevision <= lastExpectedRevision ||
      decision.expectedRuleRevision >= rule.revision ||
      (decision.actor.kind === "principal" && decision.actor.principalId !== rule.ownerPrincipalId)
    ) {
      fail(`ruleDecision ${decision.ruleDecisionId} 绑定/Actor/CAS无效`);
    }
    try {
      assertRuleLifecycleTransition({
        from: decision.fromLifecycle,
        to: decision.toLifecycle,
        enforcement: rule.enforcement,
        actor: decision.actor,
        reason: decision.reason,
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    lifecycle = decision.toLifecycle;
    lastExpectedRevision = decision.expectedRuleRevision;
  }
  if (
    lifecycle !== rule.lifecycle ||
    (decisions.at(-1)?.ruleDecisionId ?? undefined) !== rule.latestDecisionId
  ) {
    fail(`rule ${rule.ruleId} Lifecycle/Latest Decision不一致`);
  }
}

function normalizeRuleTagKey(name: string): string {
  return name.trim().normalize("NFKC").toLocaleLowerCase("und").replaceAll(/\s+/gu, "-");
}

import {
  DIRECT_AGENT_ACTIVE_TIMEOUT_MS,
  DIRECT_AGENT_MAX_PROVIDER_REQUESTS,
  DIRECT_AGENT_TOKEN_BUDGET,
  type PromptAssemblyV3,
  type ProductSnapshot,
} from "@chat/contracts";
import {
  hashCanonical,
  computePlanningInputManifestSha256,
  computeDirectAgentInputManifestSha256,
} from "@chat/domain";
import {
  MEMORY_DIRECT_RUNNER_BUNDLE_VERSION,
  MEMORY_DIRECT_RUNNER_FAMILY,
} from "@chat/application/workflow-system-definitions";
import type { Fail } from "./shared.js";

export function assertSessionsAndMessages(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  for (const session of Object.values(entities.sessions)) {
    const messages = Object.values(entities.messages)
      .filter((message) => message.sessionId === session.sessionId)
      .sort((a, b) => a.sessionSequence - b.sessionSequence);
    const sequences = new Set(messages.map((message) => message.sessionSequence));
    if (sequences.size !== messages.length) fail(`session ${session.sessionId} Message序号重复`);
    const maximum = messages.at(-1)?.sessionSequence ?? 0;
    if (maximum !== session.lastMessageSequence) {
      fail(`session ${session.sessionId} lastMessageSequence与消息不一致`);
    }
    for (let index = 0; index < messages.length; index += 1) {
      if (messages[index]?.sessionSequence !== index + 1) {
        fail(`session ${session.sessionId} Message序号不连续`);
      }
    }
  }

  for (const message of Object.values(entities.messages)) {
    if (entities.sessions[message.sessionId] === undefined) {
      fail(`message ${message.messageId} 悬空sessionId`);
    }
    if (message.role === "user" && message.sourceRunId !== undefined) {
      fail(`user message ${message.messageId} 不允许sourceRunId`);
    }
    if (message.role === "assistant" && message.sourceRunId === undefined) {
      fail(`assistant message ${message.messageId} 缺少sourceRunId`);
    }
    if (message.sourceRunId !== undefined) {
      const run = entities.runs[message.sourceRunId];
      if (run === undefined) fail(`message ${message.messageId} 悬空sourceRunId`);
      if (run.sessionId !== message.sessionId)
        fail(`message ${message.messageId} 与Run不属于同一Session`);
    }
  }
}

export function assertAttempts(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  for (const attempt of Object.values(entities.attempts)) {
    const run = entities.runs[attempt.productRunId];
    if (run === undefined) fail(`attempt ${attempt.attemptId} 悬空productRunId`);
    if (attempt.outcome === "failure" && attempt.errorCode === undefined) {
      fail(`attempt ${attempt.attemptId} failure缺少errorCode`);
    }
    if (attempt.outcome !== "failure" && attempt.errorCode !== undefined) {
      fail(`attempt ${attempt.attemptId} 非failure不允许errorCode`);
    }

    const versionEvidence = [
      attempt.inputManifestSha256,
      attempt.promptTemplateVersion,
      attempt.modelConfigVersion,
    ];
    if (attempt.kind === "planning") {
      if (
        attempt.planRevision === undefined ||
        attempt.inputRunRevision === undefined ||
        attempt.sourceMessageSha256 === undefined ||
        versionEvidence.some((value) => value === undefined)
      ) {
        fail(`planning attempt ${attempt.attemptId} 缺少输入与版本证据`);
      }
      if (attempt.stepId !== undefined) fail(`planning attempt ${attempt.attemptId} 不允许stepId`);
      if (run.sourceMessageId === undefined)
        fail(`planning attempt ${attempt.attemptId} 缺少源消息`);
      const source = entities.messages[run.sourceMessageId];
      if (source === undefined) fail(`planning attempt ${attempt.attemptId} 源消息不存在`);
      const sourceHash = hashCanonical("message.v1", {
        messageId: source.messageId,
        sessionId: source.sessionId,
        sessionSequence: source.sessionSequence,
        role: source.role,
        content: source.content,
      });
      if (sourceHash !== attempt.sourceMessageSha256) {
        fail(`planning attempt ${attempt.attemptId} sourceMessageSha256不一致`);
      }
      const promptTemplateVersion = attempt.promptTemplateVersion;
      const modelConfigVersion = attempt.modelConfigVersion;
      if (promptTemplateVersion === undefined || modelConfigVersion === undefined) {
        fail(`planning attempt ${attempt.attemptId} 缺少输入版本证据`);
      }
      const prior =
        attempt.priorPlanRevisionId === undefined
          ? undefined
          : entities.plans[attempt.priorPlanRevisionId];
      const revisionInput =
        attempt.revisionInputId === undefined
          ? undefined
          : entities.revisionInputs[attempt.revisionInputId];
      const contextRequest = Object.values(entities.contextRequests).find(
        (candidate) => candidate.productRunId === attempt.productRunId,
      );
      const contextPackage =
        attempt.contextPackageId === undefined
          ? undefined
          : entities.contextPackages[attempt.contextPackageId];
      if (attempt.priorPlanRevisionId !== undefined && prior === undefined) {
        fail(`planning attempt ${attempt.attemptId} 悬空priorPlanRevisionId`);
      }
      if (attempt.revisionInputId !== undefined && revisionInput === undefined) {
        fail(`planning attempt ${attempt.attemptId} 悬空revisionInputId`);
      }
      if (
        (attempt.contextPackageId === undefined) !==
        (attempt.contextPackageSha256 === undefined)
      ) {
        fail(`planning attempt ${attempt.attemptId} ContextPackage证据不成对`);
      }
      if (
        (attempt.planningMemorySelectionId === undefined) !==
          (attempt.planningMemorySelectionSha256 === undefined) ||
        (attempt.workflowMemoryContextId === undefined) !==
          (attempt.workflowMemoryContextSha256 === undefined) ||
        (attempt.planningProjectContextId === undefined) !==
          (attempt.planningProjectContextSha256 === undefined) ||
        (attempt.ruleSelectionId === undefined) !== (attempt.ruleSelectionSha256 === undefined)
      ) {
        fail(`planning attempt ${attempt.attemptId} 高级Context证据不成对`);
      }
      const memorySelection =
        attempt.planningMemorySelectionId === undefined
          ? undefined
          : entities.planningMemorySelections[attempt.planningMemorySelectionId];
      if (
        attempt.planningMemorySelectionId !== undefined &&
        (memorySelection?.productRunId !== attempt.productRunId ||
          memorySelection.workflowRunSpecId !== run.workflowRunSpecId ||
          memorySelection.sha256 !== attempt.planningMemorySelectionSha256)
      ) {
        fail(`planning attempt ${attempt.attemptId} Memory Selection引用不一致`);
      }
      const projectContext =
        attempt.planningProjectContextId === undefined
          ? undefined
          : entities.planningProjectContexts[attempt.planningProjectContextId];
      if (
        attempt.planningProjectContextId !== undefined &&
        (projectContext?.productRunId !== attempt.productRunId ||
          projectContext.sha256 !== attempt.planningProjectContextSha256)
      ) {
        fail(`planning attempt ${attempt.attemptId} Project Context引用不一致`);
      }
      const workflowMemoryContext =
        attempt.workflowMemoryContextId === undefined
          ? undefined
          : entities.workflowMemoryContexts[attempt.workflowMemoryContextId];
      if (
        attempt.workflowMemoryContextId !== undefined &&
        (workflowMemoryContext?.productRunId !== attempt.productRunId ||
          workflowMemoryContext.workflowRunSpecId !== run.workflowRunSpecId ||
          workflowMemoryContext.sha256 !== attempt.workflowMemoryContextSha256)
      ) {
        fail(`planning attempt ${attempt.attemptId} Workflow Memory Context引用不一致`);
      }
      const ruleSelection =
        attempt.ruleSelectionId === undefined
          ? undefined
          : entities.ruleSelections[attempt.ruleSelectionId];
      if (
        attempt.ruleSelectionId !== undefined &&
        (ruleSelection?.productRunId !== attempt.productRunId ||
          ruleSelection.sha256 !== attempt.ruleSelectionSha256)
      ) {
        fail(`planning attempt ${attempt.attemptId} Rule Selection引用不一致`);
      }
      if (
        attempt.contextPackageId !== undefined &&
        (contextPackage === undefined ||
          contextPackage.productRunId !== attempt.productRunId ||
          contextPackage.sha256 !== attempt.contextPackageSha256)
      ) {
        fail(`planning attempt ${attempt.attemptId} ContextPackage引用不一致`);
      }
      if ((attempt.planRevision ?? 1) > 1 && (prior === undefined || revisionInput === undefined)) {
        fail(`planning attempt ${attempt.attemptId} 修订轮缺少上一版Plan或Revision Input`);
      }
      const workflowPromptAssembly = Object.values(entities.promptAssemblies).find(
        (assembly): assembly is PromptAssemblyV3 =>
          assembly.schemaVersion === "prompt-assembly.v3" &&
          assembly.productRunId === attempt.productRunId,
      );
      const plannerPrompt = workflowPromptAssembly?.nodes.find(
        (node) => node.nodeType === "agent.plan",
      );
      if (workflowPromptAssembly !== undefined && plannerPrompt === undefined) {
        fail(`planning attempt ${attempt.attemptId} 缺少Planner Prompt节点`);
      }
      const manifest = computePlanningInputManifestSha256({
        productRunId: attempt.productRunId,
        planRevision: attempt.planRevision,
        sourceMessageRef: { messageId: source.messageId, sha256: sourceHash },
        ...(prior !== undefined
          ? {
              priorPlanRef: {
                planRevisionId: prior.planRevisionId,
                planId: prior.planId,
                planRevision: prior.planRevision,
                sha256: prior.sha256,
              },
            }
          : {}),
        ...(revisionInput !== undefined
          ? { revisionInputRef: { revisionInputId: revisionInput.revisionInputId } }
          : {}),
        ...(contextRequest?.schemaVersion === "run-context-request.v2"
          ? {
              workspaceInstructionsRef: {
                contextRequestId: contextRequest.contextRequestId,
                revision: 1 as const,
                sha256: contextRequest.workspaceInstructions.sha256,
              },
            }
          : {}),
        ...(contextPackage !== undefined
          ? {
              contextPackageRef: {
                contextPackageId: contextPackage.contextPackageId,
                revision: contextPackage.revision,
                sha256: contextPackage.sha256,
              },
            }
          : {}),
        ...(memorySelection !== undefined
          ? {
              planningMemorySelectionRef: {
                planningMemorySelectionId: memorySelection.planningMemorySelectionId,
                revision: memorySelection.revision,
                sha256: memorySelection.sha256,
              },
            }
          : {}),
        ...(workflowMemoryContext !== undefined
          ? {
              workflowMemoryContextRef: {
                workflowMemoryContextId: workflowMemoryContext.workflowMemoryContextId,
                revision: workflowMemoryContext.revision,
                sha256: workflowMemoryContext.sha256,
              },
            }
          : {}),
        ...(projectContext !== undefined
          ? {
              planningProjectContextRef: {
                planningProjectContextId: projectContext.planningProjectContextId,
                revision: projectContext.revision,
                sha256: projectContext.sha256,
              },
            }
          : {}),
        ...(ruleSelection !== undefined
          ? {
              ruleSelectionRef: {
                ruleSelectionId: ruleSelection.ruleSelectionId,
                revision: 1,
                sha256: ruleSelection.sha256,
              },
            }
          : {}),
        ...(workflowPromptAssembly === undefined || plannerPrompt === undefined
          ? {}
          : {
              promptAssemblyRef: {
                promptAssemblyId: workflowPromptAssembly.promptAssemblyId,
                sha256: workflowPromptAssembly.sha256,
                definitionNodeId: plannerPrompt.definitionNodeId,
                nodeAssemblySha256: plannerPrompt.sha256,
              },
            }),
        promptTemplateVersion,
        modelConfigVersion,
      });
      if (manifest !== attempt.inputManifestSha256) {
        fail(`planning attempt ${attempt.attemptId} inputManifestSha256不一致`);
      }
    } else if (attempt.kind === "execution") {
      if (attempt.stepId === undefined || versionEvidence.some((value) => value === undefined)) {
        fail(`execution attempt ${attempt.attemptId} 缺少stepId或输入版本证据`);
      }
      if (
        attempt.planRevision !== undefined ||
        attempt.inputRunRevision !== undefined ||
        attempt.sourceMessageSha256 !== undefined ||
        attempt.priorPlanRevisionId !== undefined ||
        attempt.revisionInputId !== undefined ||
        attempt.contextPackageId !== undefined ||
        attempt.contextPackageSha256 !== undefined ||
        attempt.planningMemorySelectionId !== undefined ||
        attempt.planningMemorySelectionSha256 !== undefined ||
        attempt.workflowMemoryContextId !== undefined ||
        attempt.workflowMemoryContextSha256 !== undefined ||
        attempt.planningProjectContextId !== undefined ||
        attempt.planningProjectContextSha256 !== undefined ||
        attempt.ruleSelectionId !== undefined ||
        attempt.ruleSelectionSha256 !== undefined
      ) {
        fail(`execution attempt ${attempt.attemptId} 不允许planning输入证据`);
      }
    } else if (attempt.kind === "direct_agent") {
      const source = run === undefined ? undefined : entities.messages[run.sourceMessageId];
      const runSpec =
        run?.runKind === "direct_agent"
          ? entities.workflowRunSpecs[run.workflowRunSpecId]
          : undefined;
      const promptAssembly = Object.values(entities.promptAssemblies).find(
        (assembly) => assembly.productRunId === attempt.productRunId,
      );
      const promptTemplateVersion = attempt.promptTemplateVersion;
      const modelConfigVersion = attempt.modelConfigVersion;
      const memoryDirect =
        run?.runKind === "direct_agent" &&
        run.runnerFamily === MEMORY_DIRECT_RUNNER_FAMILY &&
        run.runnerBundleVersion === MEMORY_DIRECT_RUNNER_BUNDLE_VERSION &&
        runSpec?.runner.runnerFamily === MEMORY_DIRECT_RUNNER_FAMILY &&
        runSpec.runner.runnerBundleVersion === MEMORY_DIRECT_RUNNER_BUNDLE_VERSION &&
        runSpec.definitionRef.blueprintKey === "direct" &&
        runSpec.definitionRef.blueprintVersion === 2;
      const memoryEvidencePaired =
        (attempt.workflowMemoryContextId === undefined) ===
        (attempt.workflowMemoryContextSha256 === undefined);
      if (!memoryEvidencePaired) {
        fail(`direct_agent attempt ${attempt.attemptId} Workflow Memory Context证据不成对`);
      }
      const workflowMemoryContext =
        attempt.workflowMemoryContextId === undefined
          ? undefined
          : entities.workflowMemoryContexts[attempt.workflowMemoryContextId];
      if (
        memoryDirect !== (workflowMemoryContext !== undefined) ||
        (workflowMemoryContext !== undefined &&
          (workflowMemoryContext.productRunId !== attempt.productRunId ||
            workflowMemoryContext.workflowRunSpecId !== runSpec?.workflowRunSpecId ||
            workflowMemoryContext.sha256 !== attempt.workflowMemoryContextSha256))
      ) {
        fail(`direct_agent attempt ${attempt.attemptId} Workflow Memory Context引用不一致`);
      }
      if (
        run?.runKind !== "direct_agent" ||
        source === undefined ||
        runSpec === undefined ||
        promptAssembly === undefined ||
        attempt.inputRunRevision === undefined ||
        attempt.sourceMessageSha256 === undefined ||
        attempt.inputManifestSha256 === undefined ||
        promptTemplateVersion === undefined ||
        modelConfigVersion === undefined
      ) {
        fail(`direct_agent attempt ${attempt.attemptId} 缺少Run、源消息或版本证据`);
      }
      if (
        attempt.stepId !== undefined ||
        attempt.planRevision !== undefined ||
        attempt.executionContractId !== undefined ||
        attempt.dependencyRefs !== undefined ||
        attempt.priorPlanRevisionId !== undefined ||
        attempt.revisionInputId !== undefined ||
        attempt.contextPackageId !== undefined ||
        attempt.contextPackageSha256 !== undefined ||
        attempt.planningMemorySelectionId !== undefined ||
        attempt.planningMemorySelectionSha256 !== undefined ||
        attempt.planningProjectContextId !== undefined ||
        attempt.planningProjectContextSha256 !== undefined ||
        attempt.ruleSelectionId !== undefined ||
        attempt.ruleSelectionSha256 !== undefined
      ) {
        fail(`direct_agent attempt ${attempt.attemptId} 不允许Plan/Execution Contract证据`);
      }
      const sourceSha256 = hashCanonical("message.v1", {
        messageId: source.messageId,
        sessionId: source.sessionId,
        sessionSequence: source.sessionSequence,
        role: source.role,
        content: source.content,
      });
      if (sourceSha256 !== attempt.sourceMessageSha256) {
        fail(`direct_agent attempt ${attempt.attemptId} sourceMessageSha256不一致`);
      }
      const directNode = runSpec.nodeResolutions.find(
        (node) => node.nodeType === "agent.direct" && node.activation === "enabled",
      );
      const capabilityMode = directNode?.config["capabilityMode"];
      if (
        capabilityMode !== "pi_cli_default" &&
        capabilityMode !== "custom" &&
        capabilityMode !== "read_only" &&
        capabilityMode !== "project_bootstrap"
      ) {
        fail(`direct_agent attempt ${attempt.attemptId} capabilityMode无效`);
      }
      const inputManifestSha256 = computeDirectAgentInputManifestSha256({
        productRunId: attempt.productRunId,
        inputRunRevision: attempt.inputRunRevision,
        workflowRunSpecId: runSpec.workflowRunSpecId,
        workflowRunSpecSha256: runSpec.sha256,
        sourceMessageId: source.messageId,
        sourceMessageSha256: sourceSha256,
        promptAssemblySha256: promptAssembly.sha256,
        ...(workflowMemoryContext === undefined
          ? {}
          : {
              workflowMemoryContext: {
                workflowMemoryContextId: workflowMemoryContext.workflowMemoryContextId,
                revision: workflowMemoryContext.revision,
                sha256: workflowMemoryContext.sha256,
              },
            }),
        capabilityMode,
        promptTemplateVersion,
        modelConfigVersion,
        limits: {
          maxProviderRequests: DIRECT_AGENT_MAX_PROVIDER_REQUESTS,
          activeTimeoutMs: DIRECT_AGENT_ACTIVE_TIMEOUT_MS,
          tokenBudget: DIRECT_AGENT_TOKEN_BUDGET,
        },
      });
      if (inputManifestSha256 !== attempt.inputManifestSha256) {
        fail(`direct_agent attempt ${attempt.attemptId} inputManifestSha256不一致`);
      }
    } else if (
      attempt.stepId !== undefined ||
      attempt.planRevision !== undefined ||
      attempt.inputRunRevision !== undefined ||
      attempt.sourceMessageSha256 !== undefined ||
      attempt.priorPlanRevisionId !== undefined ||
      attempt.revisionInputId !== undefined ||
      attempt.contextPackageId !== undefined ||
      attempt.contextPackageSha256 !== undefined ||
      attempt.planningMemorySelectionId !== undefined ||
      attempt.planningMemorySelectionSha256 !== undefined ||
      attempt.workflowMemoryContextId !== undefined ||
      attempt.workflowMemoryContextSha256 !== undefined ||
      attempt.planningProjectContextId !== undefined ||
      attempt.planningProjectContextSha256 !== undefined ||
      attempt.ruleSelectionId !== undefined ||
      attempt.ruleSelectionSha256 !== undefined ||
      versionEvidence.some((value) => value !== undefined)
    ) {
      fail(`workflow attempt ${attempt.attemptId} 不允许节点输入证据`);
    }
  }
}

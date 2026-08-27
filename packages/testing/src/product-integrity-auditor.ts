import type { ProductSnapshot } from "@chat/contracts";
import { validateWorkflowRunSpecIntegrity } from "@chat/application/workflow-run-spec-compiler";
import {
  assertPlanningMemorySelectionIntegrity,
  assertWorkflowPolicyResolutionIntegrity,
  assertRuleRevisionIntegrity,
  assertWorkflowViewDefinition,
  computeNoteSourceMessageSha256,
  computeNodeValueManifestSha256,
  hashCanonical,
  resolveNoteSourceText,
  selectRules,
  evaluateNoteLowRiskAutoPolicy,
} from "@chat/domain";

export interface ProductIntegrityIssue {
  readonly code: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly detail: string;
}

export interface ProductIntegrityAuditReport {
  readonly ok: boolean;
  readonly issues: readonly ProductIntegrityIssue[];
  readonly checked: {
    readonly runs: number;
    readonly nodeRuns: number;
    readonly transitions: number;
    readonly runSpecs: number;
    readonly businessObjects: number;
    readonly decisions: number;
    readonly outboxEntries: number;
    readonly attempts: number;
    readonly rules: number;
    readonly ruleSelections: number;
    readonly planningMemorySelections: number;
    readonly workflowPolicyResolutions: number;
  };
}

type IssueSink = (issue: ProductIntegrityIssue) => void;

/**
 * S7只读产品完整性Oracle。
 *
 * 它刻意不调用Product Store的fail-fast完整性入口：测试需要一次收集所有跨对象矛盾，
 * 且不能把“Store能打开”循环证明为“产品链正确”。Auditor只读取传入快照、只报告
 * 对象身份与公开错误码，不修复、不写Store，也不把正文或敏感Runtime身份复制进报告。
 */
export function auditProductIntegrity(snapshot: ProductSnapshot): ProductIntegrityAuditReport {
  const issues: ProductIntegrityIssue[] = [];
  const report: IssueSink = (issue) => issues.push(issue);

  auditRunChains(snapshot, report);
  auditDefinitionAndViewChains(snapshot, report);
  auditNodeChains(snapshot, report);
  auditBusinessChains(snapshot, report);
  auditRulesAndPlanningContexts(snapshot, report);
  auditReceiptsOutboxAndAttempts(snapshot, report);

  return {
    ok: issues.length === 0,
    issues,
    checked: {
      runs: Object.keys(snapshot.entities.runs).length,
      nodeRuns: Object.keys(snapshot.entities.workflowNodeRuns).length,
      transitions: Object.keys(snapshot.entities.nodeRunTransitions).length,
      runSpecs: Object.keys(snapshot.entities.workflowRunSpecs).length,
      businessObjects:
        Object.keys(snapshot.entities.plans).length +
        Object.keys(snapshot.entities.approvalRequests).length +
        Object.keys(snapshot.entities.artifacts).length +
        Object.keys(snapshot.entities.noteCandidates).length +
        Object.keys(snapshot.entities.notes).length +
        Object.keys(snapshot.entities.noteRevisions).length,
      decisions:
        Object.keys(snapshot.entities.decisions).length +
        Object.keys(snapshot.entities.noteDecisions).length,
      outboxEntries: Object.keys(snapshot.outbox).length,
      attempts: Object.keys(snapshot.entities.attempts).length,
      rules: Object.keys(snapshot.entities.rules).length,
      ruleSelections: Object.keys(snapshot.entities.ruleSelections).length,
      planningMemorySelections: Object.keys(snapshot.entities.planningMemorySelections).length,
      workflowPolicyResolutions: Object.keys(snapshot.entities.workflowPolicyResolutions).length,
    },
  };
}

function issue(
  report: IssueSink,
  code: string,
  subjectKind: string,
  subjectId: string,
  detail: string,
): void {
  report({ code, subjectKind, subjectId, detail });
}

function auditRunChains(snapshot: ProductSnapshot, report: IssueSink): void {
  const { entities } = snapshot;
  for (const run of Object.values(entities.runs)) {
    const session = entities.sessions[run.sessionId];
    const source = entities.messages[run.sourceMessageId];
    if (session === undefined) {
      issue(report, "run.session_missing", "run", run.productRunId, "Session引用不存在");
    }
    if (source === undefined || source.sessionId !== run.sessionId || source.role !== "user") {
      issue(
        report,
        "run.source_message_invalid",
        "run",
        run.productRunId,
        "来源Message不存在、跨Session或并非用户消息",
      );
    }
    const view = entities.workflowViewDefinitions[run.workflowViewDefinitionId];
    if (view === undefined) {
      issue(report, "run.view_missing", "run", run.productRunId, "Workflow View不存在");
    }
    if (run.workflowRunSpecId !== undefined) {
      const runSpec = entities.workflowRunSpecs[run.workflowRunSpecId];
      if (runSpec === undefined || runSpec.productRunId !== run.productRunId) {
        issue(
          report,
          "run.runspec_binding_invalid",
          "run",
          run.productRunId,
          "RunSpec反向绑定不一致",
        );
      }
    } else if (run.runnerFamily !== "legacy-planning.v1") {
      issue(report, "run.runspec_missing", "run", run.productRunId, "非Legacy Run缺少冻结RunSpec");
    }
    if (run.finalMessageId !== undefined) {
      const finalMessage = entities.messages[run.finalMessageId];
      if (
        finalMessage === undefined ||
        finalMessage.sessionId !== run.sessionId ||
        finalMessage.sourceRunId !== run.productRunId ||
        finalMessage.role !== "assistant"
      ) {
        issue(
          report,
          "run.final_message_invalid",
          "run",
          run.productRunId,
          "最终Message不存在或未绑定当前Run",
        );
      }
    }
    if (["succeeded", "failed", "cancelled", "outcome_unknown"].includes(run.status)) {
      const activeNode = Object.values(entities.workflowNodeRuns).find(
        (node) =>
          node.productRunId === run.productRunId &&
          ["running", "waiting_human"].includes(node.status),
      );
      if (activeNode !== undefined) {
        issue(
          report,
          "run.terminal_with_active_node",
          "run",
          run.productRunId,
          `终态Run仍有活动Node ${activeNode.workflowNodeRunId}`,
        );
      }
    }
  }
}

function auditDefinitionAndViewChains(snapshot: ProductSnapshot, report: IssueSink): void {
  const { entities } = snapshot;
  for (const runSpec of Object.values(entities.workflowRunSpecs)) {
    const validation = validateWorkflowRunSpecIntegrity(runSpec);
    if (!validation.success) {
      issue(
        report,
        "runspec.hash_invalid",
        "workflow_run_spec",
        runSpec.workflowRunSpecId,
        "RunSpec规范Hash不一致",
      );
    }
    const revision =
      entities.workflowDefinitionRevisions[runSpec.definitionRef.workflowDefinitionRevisionId];
    if (
      revision === undefined ||
      revision.definitionRevision !== runSpec.definitionRef.definitionRevision ||
      revision.definitionSha256 !== runSpec.definitionRef.definitionSha256 ||
      hashCanonical("workflow-definition.v1", runSpec.semanticRoot) !==
        runSpec.definitionRef.definitionSha256
    ) {
      issue(
        report,
        "runspec.definition_binding_invalid",
        "workflow_run_spec",
        runSpec.workflowRunSpecId,
        "Definition Revision身份、版本或Hash不一致",
      );
    }
    const run = entities.runs[runSpec.productRunId];
    const view =
      run === undefined
        ? undefined
        : entities.workflowViewDefinitions[run.workflowViewDefinitionId];
    if (
      run === undefined ||
      run.workflowRunSpecId !== runSpec.workflowRunSpecId ||
      run.runnerFamily !== runSpec.runner.runnerFamily ||
      run.runnerBundleVersion !== runSpec.runner.runnerBundleVersion
    ) {
      issue(
        report,
        "runspec.run_binding_invalid",
        "workflow_run_spec",
        runSpec.workflowRunSpecId,
        "Run或Runner版本证据不一致",
      );
    }
    if (
      view === undefined ||
      view.source.kind !== "published_definition" ||
      view.source.workflowDefinitionId !== revision?.workflowDefinitionId ||
      view.source.definitionRevision !== runSpec.definitionRef.definitionRevision ||
      view.source.definitionSha256 !== runSpec.definitionRef.definitionSha256
    ) {
      issue(
        report,
        "runspec.view_binding_invalid",
        "workflow_run_spec",
        runSpec.workflowRunSpecId,
        "View Snapshot未冻结同一Definition Revision",
      );
    }
  }

  for (const view of Object.values(entities.workflowViewDefinitions)) {
    try {
      assertWorkflowViewDefinition(view);
    } catch {
      issue(
        report,
        "view.hash_or_graph_invalid",
        "workflow_view",
        view.workflowViewDefinitionId,
        "View Hash或图结构不一致",
      );
    }
  }
}

function auditNodeChains(snapshot: ProductSnapshot, report: IssueSink): void {
  const { entities } = snapshot;
  for (const node of Object.values(entities.workflowNodeRuns)) {
    const run = entities.runs[node.productRunId];
    const view = entities.workflowViewDefinitions[node.workflowViewDefinitionId];
    const viewNode = view?.nodes.find(
      (candidate) => candidate.definitionNodeId === node.definitionNodeId,
    );
    const dynamicParent =
      node.nodeType === "execute.plan_step" && node.parentNodeRunId !== undefined
        ? entities.workflowNodeRuns[node.parentNodeRunId]
        : undefined;
    const validDynamicChild =
      dynamicParent !== undefined && dynamicParent.productRunId === node.productRunId;
    if (
      run === undefined ||
      run.workflowViewDefinitionId !== node.workflowViewDefinitionId ||
      (!validDynamicChild && (viewNode === undefined || viewNode.nodeType !== node.nodeType))
    ) {
      issue(
        report,
        "node.run_view_binding_invalid",
        "workflow_node_run",
        node.workflowNodeRunId,
        "Node未绑定当前Run/View中的同一Definition节点",
      );
    }
    const transitions = Object.values(entities.nodeRunTransitions)
      .filter((transition) => transition.workflowNodeRunId === node.workflowNodeRunId)
      .sort((left, right) => left.nodeSequence - right.nodeSequence);
    if (transitions.length === 0) {
      issue(
        report,
        "node.transition_missing",
        "workflow_node_run",
        node.workflowNodeRunId,
        "Node没有Transition历史",
      );
      continue;
    }
    let previousStatus: string | undefined;
    for (let index = 0; index < transitions.length; index += 1) {
      const transition = transitions[index];
      if (
        transition === undefined ||
        transition.nodeSequence !== index + 1 ||
        transition.fromStatus !== previousStatus
      ) {
        issue(
          report,
          "node.transition_chain_invalid",
          "workflow_node_run",
          node.workflowNodeRunId,
          "Transition序号或from/to链不连续",
        );
        break;
      }
      previousStatus = transition.toStatus;
    }
    if (previousStatus !== node.status) {
      issue(
        report,
        "node.last_transition_mismatch",
        "workflow_node_run",
        node.workflowNodeRunId,
        "最后Transition与Node当前状态不一致",
      );
    }
    for (const manifestId of [node.inputManifestId, node.outputManifestId]) {
      if (manifestId === undefined) continue;
      const manifest = entities.nodeValueManifests[manifestId];
      if (
        manifest === undefined ||
        manifest.workflowNodeRunId !== node.workflowNodeRunId ||
        computeNodeValueManifestSha256({
          workflowNodeRunId: manifest.workflowNodeRunId,
          direction: manifest.direction,
          slots: manifest.slots,
        }) !== manifest.sha256
      ) {
        issue(
          report,
          "node.manifest_invalid",
          "workflow_node_run",
          node.workflowNodeRunId,
          "输入/输出Manifest缺失、错绑或Hash不一致",
        );
      }
    }
  }
}

function auditBusinessChains(snapshot: ProductSnapshot, report: IssueSink): void {
  const { entities } = snapshot;
  for (const plan of Object.values(entities.plans)) {
    const run = entities.runs[plan.productRunId];
    const attempt = entities.attempts[plan.planningAttemptId];
    if (run?.runKind !== "planning" || attempt?.productRunId !== plan.productRunId) {
      issue(
        report,
        "plan.run_attempt_invalid",
        "plan",
        plan.planRevisionId,
        "Run或Planning Attempt错绑",
      );
    }
  }
  for (const approval of Object.values(entities.approvalRequests)) {
    const plan = Object.values(entities.plans).find(
      (candidate) =>
        candidate.productRunId === approval.productRunId &&
        candidate.planId === approval.planId &&
        candidate.planRevision === approval.planRevision,
    );
    if (plan === undefined || plan.sha256 !== approval.planSha256) {
      issue(
        report,
        "approval.plan_binding_invalid",
        "approval",
        approval.approvalRequestId,
        "Approval未绑定同一Plan版本与Hash",
      );
    }
  }
  for (const contract of Object.values(entities.executionContracts)) {
    const plan = Object.values(entities.plans).find(
      (candidate) =>
        candidate.productRunId === contract.productRunId &&
        candidate.planId === contract.approvedPlanId &&
        candidate.planRevision === contract.approvedPlanRevision,
    );
    const decision = entities.decisions[contract.approvalDecisionId];
    if (
      plan === undefined ||
      plan.sha256 !== contract.approvedPlanSha256 ||
      decision?.kind !== "approve" ||
      decision.productRunId !== contract.productRunId ||
      decision.planSha256 !== contract.approvedPlanSha256
    ) {
      issue(
        report,
        "execution_contract.binding_invalid",
        "execution_contract",
        contract.executionContractId,
        "Execution Contract未绑定同一Approved Plan/Decision",
      );
    }
  }
  for (const candidate of Object.values(entities.executionCandidates)) {
    const contract = entities.executionContracts[candidate.executionContractId];
    const badAttempt = candidate.stepResults.find((step) => {
      const attempt = entities.attempts[step.executionAttemptId];
      return (
        attempt === undefined ||
        attempt.productRunId !== candidate.productRunId ||
        attempt.kind !== "execution" ||
        attempt.stepId !== step.stepId
      );
    });
    if (contract?.productRunId !== candidate.productRunId || badAttempt !== undefined) {
      issue(
        report,
        "execution_candidate.binding_invalid",
        "execution_candidate",
        candidate.executionCandidateId,
        "Execution Candidate未绑定同一Contract或Step Attempt",
      );
    }
  }
  for (const validation of Object.values(entities.validationResults)) {
    if (
      entities.executionContracts[validation.executionContractId]?.productRunId !==
        validation.productRunId ||
      entities.executionCandidates[validation.executionCandidateId]?.productRunId !==
        validation.productRunId
    ) {
      issue(
        report,
        "validation.binding_invalid",
        "validation_result",
        validation.validationResultId,
        "Validation未绑定同一Run的Contract/Candidate",
      );
    }
  }
  for (const artifact of Object.values(entities.artifacts)) {
    const run = entities.runs[artifact.productRunId];
    if (run === undefined || run.runKind !== "planning") {
      issue(
        report,
        "artifact.run_invalid",
        "artifact",
        artifact.artifactId,
        "Artifact未绑定Planning Run",
      );
    }
  }
  for (const decision of Object.values(entities.decisions)) {
    const approval = entities.approvalRequests[decision.approvalRequestId];
    const run = entities.runs[decision.productRunId];
    const owner =
      run === undefined ? undefined : entities.sessions[run.sessionId]?.ownerPrincipalId;
    if (
      approval === undefined ||
      approval.productRunId !== decision.productRunId ||
      approval.planId !== decision.planId ||
      approval.planRevision !== decision.planRevision ||
      approval.planSha256 !== decision.planSha256 ||
      owner !== decision.principalId
    ) {
      issue(
        report,
        "decision.binding_invalid",
        "decision",
        decision.decisionId,
        "Decision与Approval/Plan/Owner绑定不一致",
      );
    }
  }
  for (const candidate of Object.values(entities.noteCandidates)) {
    const run = entities.runs[candidate.productRunId];
    if (run?.runKind !== "note_capture") {
      issue(
        report,
        "note_candidate.run_invalid",
        "note_candidate",
        candidate.noteCandidateId,
        "Note Candidate未绑定note_capture Run",
      );
    }
    for (const sourceRef of candidate.sourceRefs) {
      const message = entities.messages[sourceRef.sourceMessageId];
      try {
        if (
          message === undefined ||
          message.sessionId !== run?.sessionId ||
          message.role !== "user" ||
          sourceRef.sourceMessageSha256 !== computeNoteSourceMessageSha256(message)
        ) {
          throw new Error("note_source_binding_invalid");
        }
        resolveNoteSourceText({ message, sourceRef });
      } catch {
        issue(
          report,
          "note_candidate.source_invalid",
          "note_candidate",
          candidate.noteCandidateId,
          "Note Candidate来源Message/选区与Run绑定不一致",
        );
        break;
      }
    }
  }
  for (const decision of Object.values(entities.noteDecisions)) {
    const candidate = entities.noteCandidates[decision.noteCandidateId];
    const run = entities.runs[decision.productRunId];
    const owner =
      run === undefined ? undefined : entities.sessions[run.sessionId]?.ownerPrincipalId;
    if (
      candidate === undefined ||
      candidate.productRunId !== decision.productRunId ||
      candidate.revision !== decision.candidateRevision + 1 ||
      candidate.sha256 !== decision.candidateSha256 ||
      owner !== decision.principalId
    ) {
      issue(
        report,
        "note_decision.binding_invalid",
        "note_decision",
        decision.noteDecisionId,
        "Note Decision与Candidate/Owner绑定不一致",
      );
    }
  }
  for (const note of Object.values(entities.notes)) {
    const candidate = entities.noteCandidates[note.sourceCandidateId];
    const revision = entities.noteRevisions[note.currentRevisionId];
    const run = candidate === undefined ? undefined : entities.runs[candidate.productRunId];
    const owner =
      run === undefined ? undefined : entities.sessions[run.sessionId]?.ownerPrincipalId;
    if (
      candidate?.status !== "confirmed" ||
      revision?.noteId !== note.noteId ||
      revision.noteRevision !== note.revision ||
      revision.createdByPrincipalId !== note.ownerPrincipalId ||
      owner !== note.ownerPrincipalId
    ) {
      issue(
        report,
        "note.aggregate_binding_invalid",
        "note",
        note.noteId,
        "Note与Confirmed Candidate/Current Revision/Owner绑定不一致",
      );
    }
  }
  for (const run of Object.values(entities.runs).filter(
    (candidate) => candidate.runKind === "note_capture",
  )) {
    const nodes = Object.values(entities.workflowNodeRuns).filter(
      (node) => node.productRunId === run.productRunId,
    );
    if (
      run.status === "waiting_human" &&
      !nodes.some(
        (node) => node.nodeType === "human.note_review" && node.status === "waiting_human",
      )
    ) {
      issue(
        report,
        "note_run.waiting_projection_missing",
        "run",
        run.productRunId,
        "Note waiting Run缺少waiting_human审核节点投影",
      );
    }
    if (
      run.status === "succeeded" &&
      !nodes.some((node) => node.nodeType === "note.commit" && node.status === "succeeded")
    ) {
      issue(
        report,
        "note_run.commit_projection_missing",
        "run",
        run.productRunId,
        "Note成功Run缺少note.commit成功投影",
      );
    }
  }
}

function auditRulesAndPlanningContexts(snapshot: ProductSnapshot, report: IssueSink): void {
  const { entities } = snapshot;
  for (const revision of Object.values(entities.ruleRevisions)) {
    try {
      assertRuleRevisionIntegrity(revision);
    } catch {
      issue(
        report,
        "rule_revision.integrity_invalid",
        "rule_revision",
        revision.ruleRevisionId,
        "Rule Revision结构或Hash不一致",
      );
    }
    if (entities.rules[revision.ruleId] === undefined) {
      issue(
        report,
        "rule_revision.rule_missing",
        "rule_revision",
        revision.ruleRevisionId,
        "Rule Revision引用的Rule不存在",
      );
    }
  }
  for (const rule of Object.values(entities.rules)) {
    const current = entities.ruleRevisions[rule.currentRevisionId];
    const decision =
      rule.latestDecisionId === undefined
        ? undefined
        : entities.ruleDecisions[rule.latestDecisionId];
    if (
      current === undefined ||
      current.ruleId !== rule.ruleId ||
      current.revision !== rule.currentRevisionNumber ||
      current.sha256 !== rule.currentRevisionSha256
    ) {
      issue(
        report,
        "rule.current_revision_invalid",
        "rule",
        rule.ruleId,
        "Rule当前Revision绑定不一致",
      );
    }
    if (
      rule.latestDecisionId !== undefined &&
      (decision?.ruleId !== rule.ruleId ||
        decision.boundRevisionId !== rule.currentRevisionId ||
        decision.boundRevisionSha256 !== rule.currentRevisionSha256 ||
        decision.toLifecycle !== rule.lifecycle)
    ) {
      issue(
        report,
        "rule.decision_binding_invalid",
        "rule",
        rule.ruleId,
        "Rule生命周期Decision绑定不一致",
      );
    }
  }
  for (const selection of Object.values(entities.ruleSelections)) {
    const run = entities.runs[selection.productRunId];
    const badSelected = selection.selected.find(
      (selected) =>
        entities.rules[selected.ruleId] === undefined ||
        entities.ruleRevisions[selected.ruleRevisionId]?.sha256 !== selected.ruleRevisionSha256,
    );
    let recomputedSha256: string | undefined;
    try {
      recomputedSha256 = selectRules({
        candidates: selection.candidates,
        request: {
          ...selection.request,
          context: selection.context,
          budget: selection.budget,
        },
      }).sha256;
    } catch {
      // 统一落到下方安全问题，不复制Domain错误正文。
    }
    if (
      run?.runKind !== "planning" ||
      badSelected !== undefined ||
      recomputedSha256 !== selection.sha256
    ) {
      issue(
        report,
        "rule_selection.binding_invalid",
        "rule_selection",
        selection.ruleSelectionId,
        "Rule Selection与Planning Run/Revision或确定性选择Hash不一致",
      );
    }
    if (
      !hasNodeOutputRef(
        snapshot,
        selection.productRunId,
        "policy.rules",
        "rule_selection",
        selection.ruleSelectionId,
      )
    ) {
      issue(
        report,
        "rule_selection.projection_missing",
        "rule_selection",
        selection.ruleSelectionId,
        "Rule Selection缺少同事务Node终态/Manifest投影",
      );
    }
  }
  for (const selection of Object.values(entities.planningMemorySelections)) {
    let valid = true;
    try {
      assertPlanningMemorySelectionIntegrity(selection);
    } catch {
      valid = false;
    }
    const run = entities.runs[selection.productRunId];
    const runSpec = entities.workflowRunSpecs[selection.workflowRunSpecId];
    const badMemory = selection.selected.find((ref) => {
      const memory = entities.memoryResultSnapshots[ref.memoryResultSnapshotId];
      const query = memory === undefined ? undefined : entities.memoryQueries[memory.memoryQueryId];
      const sourceRun = query === undefined ? undefined : entities.runs[query.productRunId];
      const sourceOwner =
        sourceRun === undefined
          ? undefined
          : entities.sessions[sourceRun.sessionId]?.ownerPrincipalId;
      const owner =
        run === undefined ? undefined : entities.sessions[run.sessionId]?.ownerPrincipalId;
      return (
        memory?.revision !== ref.revision || memory.sha256 !== ref.sha256 || sourceOwner !== owner
      );
    });
    if (
      !valid ||
      run?.runKind !== "planning" ||
      run.workflowRunSpecId !== selection.workflowRunSpecId ||
      runSpec?.sha256 !== selection.workflowRunSpecSha256 ||
      badMemory !== undefined
    ) {
      issue(
        report,
        "planning_memory_selection.binding_invalid",
        "planning_memory_selection",
        selection.planningMemorySelectionId,
        "Memory Selection与Run/RunSpec/Owner或Snapshot三元组不一致",
      );
    }
    if (
      !hasNodeOutputRef(
        snapshot,
        selection.productRunId,
        "context.memory",
        "planning_memory_selection",
        selection.planningMemorySelectionId,
      )
    ) {
      issue(
        report,
        "planning_memory_selection.projection_missing",
        "planning_memory_selection",
        selection.planningMemorySelectionId,
        "Memory Selection缺少同事务Node终态/Manifest投影",
      );
    }
  }

  for (const resolution of Object.values(entities.workflowPolicyResolutions)) {
    let valid = true;
    try {
      assertWorkflowPolicyResolutionIntegrity(resolution);
    } catch {
      valid = false;
    }
    const run = entities.runs[resolution.productRunId];
    const runSpec = entities.workflowRunSpecs[resolution.workflowRunSpecId];
    const candidate = entities.noteCandidates[resolution.noteCandidateId];
    const expected = candidate === undefined ? undefined : evaluateNoteLowRiskAutoPolicy(candidate);
    if (
      !valid ||
      run?.runKind !== "note_capture" ||
      run.workflowRunSpecId !== resolution.workflowRunSpecId ||
      runSpec?.sha256 !== resolution.workflowRunSpecSha256 ||
      candidate?.productRunId !== resolution.productRunId ||
      candidate.sha256 !== resolution.candidateSha256 ||
      candidate.revision < resolution.candidateRevision ||
      expected?.outcome !== resolution.outcome ||
      expected.reasonCode !== resolution.reasonCode
    ) {
      issue(
        report,
        "workflow_policy_resolution.binding_invalid",
        "workflow_policy_resolution",
        resolution.workflowPolicyResolutionId,
        "Policy Resolution与RunSpec/Candidate/确定性策略结果不一致",
      );
    }
    if (
      !hasNodeOutputRef(
        snapshot,
        resolution.productRunId,
        "human.note_review",
        "workflow_policy_resolution",
        resolution.workflowPolicyResolutionId,
      )
    ) {
      issue(
        report,
        "workflow_policy_resolution.projection_missing",
        "workflow_policy_resolution",
        resolution.workflowPolicyResolutionId,
        "Policy Resolution缺少审核Node/Manifest投影",
      );
    }
  }
}

function hasNodeOutputRef(
  snapshot: ProductSnapshot,
  productRunId: string,
  nodeType: string,
  refKind: string,
  refId: string,
): boolean {
  return Object.values(snapshot.entities.workflowNodeRuns).some((node) => {
    if (
      node.productRunId !== productRunId ||
      node.nodeType !== nodeType ||
      node.outputManifestId === undefined
    ) {
      return false;
    }
    const manifest = snapshot.entities.nodeValueManifests[node.outputManifestId];
    return (
      manifest !== undefined &&
      manifest.slots.some((slot) =>
        slot.refs.some((ref) => ref.kind === refKind && ref.id === refId),
      )
    );
  });
}

function auditReceiptsOutboxAndAttempts(snapshot: ProductSnapshot, report: IssueSink): void {
  const { entities } = snapshot;
  for (const attempt of Object.values(entities.attempts)) {
    if (entities.runs[attempt.productRunId] === undefined) {
      issue(report, "attempt.run_missing", "attempt", attempt.attemptId, "Attempt引用的Run不存在");
    }
    if (
      attempt.planningMemorySelectionId !== undefined &&
      (entities.planningMemorySelections[attempt.planningMemorySelectionId]?.productRunId !==
        attempt.productRunId ||
        entities.planningMemorySelections[attempt.planningMemorySelectionId]?.sha256 !==
          attempt.planningMemorySelectionSha256)
    ) {
      issue(
        report,
        "attempt.memory_selection_invalid",
        "attempt",
        attempt.attemptId,
        "Attempt与Memory Selection绑定不一致",
      );
    }
    if (
      attempt.ruleSelectionId !== undefined &&
      (entities.ruleSelections[attempt.ruleSelectionId]?.productRunId !== attempt.productRunId ||
        entities.ruleSelections[attempt.ruleSelectionId]?.sha256 !== attempt.ruleSelectionSha256)
    ) {
      issue(
        report,
        "attempt.rule_selection_invalid",
        "attempt",
        attempt.attemptId,
        "Attempt与Rule Selection绑定不一致",
      );
    }
  }
  for (const entry of Object.values(snapshot.outbox)) {
    if ("productRunId" in entry) {
      const run = entities.runs[entry.productRunId];
      if (run === undefined) {
        issue(report, "outbox.run_missing", "outbox", entry.outboxId, "Outbox目标Run不存在");
        continue;
      }
      if (
        "workflowRunSpecId" in entry &&
        entry.workflowRunSpecId !== undefined &&
        entry.workflowRunSpecId !== run.workflowRunSpecId
      ) {
        issue(
          report,
          "outbox.runspec_binding_invalid",
          "outbox",
          entry.outboxId,
          "Outbox与RunSpec绑定不一致",
        );
      }
      if (
        "decisionId" in entry &&
        entry.decisionId !== undefined &&
        entities.decisions[entry.decisionId]?.productRunId !== entry.productRunId
      ) {
        issue(
          report,
          "outbox.decision_binding_invalid",
          "outbox",
          entry.outboxId,
          "Outbox与Planning Decision绑定不一致",
        );
      }
      if (
        "noteDecisionId" in entry &&
        entry.noteDecisionId !== undefined &&
        entities.noteDecisions[entry.noteDecisionId]?.productRunId !== entry.productRunId
      ) {
        issue(
          report,
          "outbox.note_decision_binding_invalid",
          "outbox",
          entry.outboxId,
          "Outbox与Note Decision绑定不一致",
        );
      }
    }
  }
  for (const receipt of Object.values(snapshot.commandReceipts)) {
    if (receipt.committedStoreRevision > snapshot.storeRevision) {
      issue(
        report,
        "receipt.future_revision",
        "command_receipt",
        receipt.commandId,
        "Receipt提交revision晚于快照revision",
      );
    }
    for (const [key, id] of Object.entries(receipt.resultRefs)) {
      const collection = receiptCollection(snapshot, key);
      if (collection !== undefined && collection[id] === undefined) {
        issue(
          report,
          "receipt.result_ref_missing",
          "command_receipt",
          receipt.commandId,
          `Result ref ${key}指向不存在的产品对象`,
        );
      }
    }
  }
}

function receiptCollection(
  snapshot: ProductSnapshot,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  const { entities } = snapshot;
  return {
    productRunId: entities.runs,
    workflowRunSpecId: entities.workflowRunSpecs,
    workflowNodeRunId: entities.workflowNodeRuns,
    planRevisionId: entities.plans,
    approvalRequestId: entities.approvalRequests,
    decisionId: entities.decisions,
    noteCandidateId: entities.noteCandidates,
    noteDecisionId: entities.noteDecisions,
    noteId: entities.notes,
    noteRevisionId: entities.noteRevisions,
    artifactId: entities.artifacts,
    attemptId: entities.attempts,
    sessionId: entities.sessions,
    messageId: entities.messages,
    ruleId: entities.rules,
    ruleRevisionId: entities.ruleRevisions,
    ruleDecisionId: entities.ruleDecisions,
    ruleSelectionId: entities.ruleSelections,
    planningMemorySelectionId: entities.planningMemorySelections,
    workflowPolicyResolutionId: entities.workflowPolicyResolutions,
  }[key];
}

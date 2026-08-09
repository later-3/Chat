import {
  INTERNAL_RUNTIME_SCHEMA_VERSION,
  preparePlanningRulesContextResponseSchema,
  ruleSelectionSchema,
  type PreparePlanningRulesContextRequest,
  type PreparePlanningRulesContextResponse,
  type ProductEntities,
  type ProductRunId,
  type Rule,
  type RuleRevision,
  type WorkflowResolvedResource,
  type WorkflowRunSpec,
} from "@chat/contracts";
import { hashCanonical, selectRules, type RuleSelectionCandidateShape } from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import { ApplicationError, notFound, revisionConflict } from "./errors.js";
import { commitPlanningContextNodeFact } from "./planning-context-node-facts.js";
import { requirePlanningRun } from "./product-run-kind.js";
import { validateWorkflowRunSpecIntegrity } from "./workflow-run-spec-compiler.js";

const RULE_BUDGET = { maxRules: 20, maxContentCharacters: 40_000 } as const;

/**
 * `policy.rules`只把RunSpec冻结的Rule Revision交给选择器。Application在单事务内写入
 * RuleSelection审计事实；Workflow只能读取返回的安全正文，不拥有规则或选择结果。
 */
export async function preparePlanningRulesContext(
  deps: ApplicationDeps,
  input: PreparePlanningRulesContextRequest,
): Promise<PreparePlanningRulesContextResponse> {
  const now = deps.now();
  const requestSha256 = hashCanonical("command.prepare-planning-rules-context.v1", input);
  const transaction = await deps.store.transact({
    commandId: input.commandId,
    commandType: "PreparePlanningRulesContext",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const {
        run,
        runSpec,
        session,
        included: currentIncluded,
      } = resolveCurrentRulesContextBinding(draft.entities, input);
      if (currentIncluded.length === 0) {
        const nodeRun = commitPlanningContextNodeFact(draft, {
          run,
          runSpec,
          definitionNodeId: input.definitionNodeId,
          nodeType: "policy.rules",
          executionPath: input.executionPath,
          attemptNumber: input.attemptNumber,
          terminal: "skipped",
          outcomeCode: "optional_unavailable",
          publicSummary: "本轮未选择Project Rules",
          inputSlots: [],
          outputSlots: [],
          at: now,
        });
        return {
          resultRefs: {
            productRunId: input.productRunId,
            workflowNodeRunId: nodeRun.workflowNodeRunId,
          },
        };
      }
      const explicit = currentIncluded.map((resource) => {
        const rule = draft.entities.rules[resource.resourceId];
        const revision = Object.values(draft.entities.ruleRevisions).find(
          (candidate) =>
            candidate.ruleId === rule?.ruleId &&
            candidate.revision === resource.expectedRevision &&
            candidate.sha256 === resource.expectedSha256,
        );
        if (
          revision === undefined ||
          rule === undefined ||
          rule.ownerPrincipalId !== session.ownerPrincipalId ||
          revision.revision !== resource.expectedRevision ||
          revision.sha256 !== resource.expectedSha256
        ) {
          throw new ApplicationError({
            code: "resource_stale",
            httpStatus: 409,
            message: "RunSpec中的Rule Revision不存在、越权或Hash已变化",
            recoveryAction: "rehydrate_and_retry",
          });
        }
        return { rule, revision };
      });
      const projectContext = Object.values(draft.entities.planningProjectContexts).find(
        (context) => context.productRunId === input.productRunId,
      );
      const context = {
        scenario: "planning" as const,
        workflowNodeKey: "policy.rules",
        ...(projectContext !== undefined
          ? {
              projectId: projectContext.projectId,
              projectMethodProfileId: projectContext.snapshot.methodProfileId,
              projectStageKey: projectContext.snapshot.stage.key,
            }
          : {}),
      };
      const request = {
        explicitRules: explicit.map(({ rule, revision }) => ({
          ruleId: rule.ruleId,
          ruleRevisionId: revision.ruleRevisionId,
          ruleRevisionSha256: revision.sha256,
        })),
        excludedRuleIds: [],
        selectedTagIds: [],
      };
      const existing = Object.values(draft.entities.ruleSelections).find(
        (selection) => selection.productRunId === input.productRunId,
      );
      if (existing !== undefined) {
        // 幂等重放必须在同一事务内重新复核RunSpec/Owner/Resource冻结；不能因为已有Selection
        // 就跳过跨Run、跨Owner或RunSpec漂移检查并把旧事实返回给错误请求。
        if (
          JSON.stringify(existing.request) !== JSON.stringify(request) ||
          JSON.stringify(existing.context) !== JSON.stringify(context)
        ) {
          throw revisionConflict("已冻结Rule Selection与当前RunSpec不一致");
        }
        if (existing.status !== "ready") {
          throw new ApplicationError({
            code: "policy_denied",
            httpStatus: 409,
            message: "已冻结Rule Selection需要人工处理",
            recoveryAction: "rehydrate_and_retry",
          });
        }
        const nodeRun = commitRuleSelectionNode({
          draft,
          run,
          runSpec,
          definitionNodeId: input.definitionNodeId,
          executionPath: input.executionPath,
          attemptNumber: input.attemptNumber,
          selection: existing,
          explicit,
          at: now,
        });
        return {
          resultRefs: {
            ruleSelectionId: existing.ruleSelectionId,
            productRunId: input.productRunId,
            workflowNodeRunId: nodeRun.workflowNodeRunId,
          },
        };
      }
      // 只消费RunSpec冻结的精确Revision；执行时扫描最新active Rule会让同一Run漂移。
      // 自动Scope召回必须等Compiler能把完整候选集冻结进RunSpec后再开放。
      const candidates = buildCandidateSnapshot(explicit);
      const selected = selectRules({
        candidates,
        request: { ...request, context, budget: RULE_BUDGET },
      });
      const ids = deps.ruleIds;
      if (ids === undefined) throw new Error("RuleIdFactory未配置");
      const selection = ruleSelectionSchema.parse({
        schemaVersion: "rule-selection.v1",
        ruleSelectionId: ids.selection(),
        productRunId: input.productRunId,
        context,
        request,
        budget: RULE_BUDGET,
        candidates,
        ...selected,
        createdAt: now,
      });
      if (selection.status !== "ready") {
        throw new ApplicationError({
          code: "policy_denied",
          httpStatus: 409,
          message: "Rule Selection存在冲突或预算阻断，需要调整运行配置",
          recoveryAction: "rehydrate_and_retry",
        });
      }
      draft.entities.ruleSelections[selection.ruleSelectionId] = selection;
      const nodeRun = commitRuleSelectionNode({
        draft,
        run,
        runSpec,
        definitionNodeId: input.definitionNodeId,
        executionPath: input.executionPath,
        attemptNumber: input.attemptNumber,
        selection,
        explicit,
        at: now,
      });
      return {
        resultRefs: {
          ruleSelectionId: selection.ruleSelectionId,
          productRunId: input.productRunId,
          workflowNodeRunId: nodeRun.workflowNodeRunId,
        },
      };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const committedSelectionId = transaction.resultRefs["ruleSelectionId"];
  if (committedSelectionId === undefined) {
    return preparePlanningRulesContextResponseSchema.parse({
      schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
      status: "none",
      productRunId: input.productRunId,
      workflowRunSpecId: input.workflowRunSpecId,
    });
  }
  const selection = snapshot.entities.ruleSelections[committedSelectionId];
  if (selection === undefined) throw notFound("Rule Selection不存在");
  if (selection.status !== "ready") {
    throw new ApplicationError({
      code: "policy_denied",
      httpStatus: 409,
      message: "Rule Selection存在冲突或预算阻断，需要调整运行配置",
      recoveryAction: "rehydrate_and_retry",
    });
  }
  return preparePlanningRulesContextResponseSchema.parse({
    schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
    status: "ready",
    productRunId: input.productRunId,
    workflowRunSpecId: input.workflowRunSpecId,
    selectionRef: {
      ruleSelectionId: selection.ruleSelectionId,
      revision: 1,
      sha256: selection.sha256,
    },
    rules: selection.selected.map((selected) => {
      const revision = snapshot.entities.ruleRevisions[selected.ruleRevisionId];
      const rule = snapshot.entities.rules[selected.ruleId];
      if (revision === undefined || rule === undefined) throw notFound("选中Rule Revision不存在");
      return {
        ruleId: rule.ruleId,
        ruleRevisionId: revision.ruleRevisionId,
        ruleRevisionSha256: revision.sha256,
        body: revision.body,
      };
    }),
    totalContentCharacters: selection.selectedContentCharacters,
  });
}

function resolveIncludedRuleResources(
  runSpec: WorkflowRunSpec,
  definitionNodeId: string,
): readonly Extract<WorkflowResolvedResource, { readonly resolution: "included" }>[] {
  const node = runSpec.nodeResolutions.find(
    (candidate) => candidate.definitionNodeId === definitionNodeId,
  );
  if (node?.nodeType !== "policy.rules") {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 422,
      message: "definitionNodeId不是policy.rules节点",
    });
  }
  return runSpec.resourceResolutions.flatMap((resource) =>
    resource.definitionNodeId === definitionNodeId &&
    resource.resourceKind === "rule" &&
    resource.resolution === "included"
      ? [resource]
      : [],
  );
}

function resolveCurrentRulesContextBinding(
  entities: ProductEntities,
  input: Pick<
    PreparePlanningRulesContextRequest,
    "productRunId" | "workflowRunSpecId" | "definitionNodeId"
  >,
): {
  readonly run: ReturnType<typeof requirePlanningRun>;
  readonly runSpec: WorkflowRunSpec;
  readonly session: NonNullable<ProductEntities["sessions"][string]>;
  readonly included: readonly Extract<
    WorkflowResolvedResource,
    { readonly resolution: "included" }
  >[];
} {
  const run = entities.runs[input.productRunId];
  if (run === undefined) throw notFound("Planning Run不存在");
  const planningRun = requirePlanningRun(run);
  const session = entities.sessions[planningRun.sessionId];
  if (session === undefined) throw notFound("Planning Session不存在");
  const runSpec = entities.workflowRunSpecs[input.workflowRunSpecId];
  if (
    planningRun.workflowRunSpecId !== input.workflowRunSpecId ||
    runSpec === undefined ||
    runSpec.productRunId !== input.productRunId
  ) {
    throw revisionConflict("Rule Context的RunSpec与Run绑定不一致");
  }
  const validation = validateWorkflowRunSpecIntegrity(runSpec);
  if (!validation.success) {
    throw new ApplicationError({
      code: "store_corrupted",
      httpStatus: 500,
      message: "Workflow RunSpec损坏",
      recoveryAction: "contact_support",
    });
  }
  return {
    run: planningRun,
    runSpec: validation.runSpec,
    session,
    included: resolveIncludedRuleResources(validation.runSpec, input.definitionNodeId),
  };
}

function commitRuleSelectionNode(input: {
  readonly draft: Parameters<typeof commitPlanningContextNodeFact>[0];
  readonly run: ReturnType<typeof requirePlanningRun>;
  readonly runSpec: WorkflowRunSpec;
  readonly definitionNodeId: string;
  readonly executionPath: PreparePlanningRulesContextRequest["executionPath"];
  readonly attemptNumber: number;
  readonly selection: ProductEntities["ruleSelections"][string];
  readonly explicit: readonly { readonly rule: Rule; readonly revision: RuleRevision }[];
  readonly at: string;
}) {
  const revisions = new Map(
    input.explicit.map(({ rule, revision }) => [revision.ruleRevisionId, { rule, revision }]),
  );
  const inputRefs = input.selection.selected.map((selected) => {
    const value = revisions.get(selected.ruleRevisionId);
    if (value === undefined || value.revision.sha256 !== selected.ruleRevisionSha256) {
      throw revisionConflict("Rule Selection引用的Revision未包含在RunSpec中");
    }
    return {
      kind: "rule_revision" as const,
      id: value.revision.ruleRevisionId,
      revision: value.revision.revision,
      sha256: value.revision.sha256,
      label: value.rule.title,
    };
  });
  const selectionRef = {
    kind: "rule_selection" as const,
    id: input.selection.ruleSelectionId,
    revision: 1,
    sha256: input.selection.sha256,
    label: `已冻结${String(input.selection.selected.length)}条Project Rules`,
  };
  return commitPlanningContextNodeFact(input.draft, {
    run: input.run,
    runSpec: input.runSpec,
    definitionNodeId: input.definitionNodeId,
    nodeType: "policy.rules",
    executionPath: input.executionPath,
    attemptNumber: input.attemptNumber,
    terminal: "succeeded",
    outcomeCode: "success",
    publicSummary: `已采用${String(input.selection.selected.length)}条Project Rules`,
    inputSlots: [{ name: "rules", refs: inputRefs }],
    outputSlots: [{ name: "selection", refs: [selectionRef] }],
    relatedProductRef: selectionRef,
    at: input.at,
  });
}

function buildCandidateSnapshot(
  explicit: readonly { readonly rule: Rule; readonly revision: RuleRevision }[],
): RuleSelectionCandidateShape[] {
  const values = explicit.map(({ rule, revision }) => {
    return {
      ruleId: rule.ruleId,
      ruleRevisionId: revision.ruleRevisionId,
      ruleRevisionSha256: revision.sha256,
      // RunSpec仅可能冻结Catalog当时可选的trial/active Revision；后续生命周期变化
      // 不得倒灌已启动Run，因此这里按显式可选语义恢复为active。
      lifecycle: "active" as const,
      enforcement: rule.enforcement,
      priority: rule.priority,
      tagIds: revision.tagIds,
      scopes: revision.scopes,
      conflictsWithRuleIds: revision.conflictsWithRuleIds,
      contentCharacters: revision.body.length,
    };
  });
  return values.sort((left, right) => left.ruleId.localeCompare(right.ruleId));
}

export function ruleSelectionForRun(
  snapshot: {
    readonly entities: {
      readonly ruleSelections: Record<string, { readonly productRunId: ProductRunId }>;
    };
  },
  productRunId: ProductRunId,
) {
  return Object.values(snapshot.entities.ruleSelections).find(
    (selection) => selection.productRunId === productRunId,
  );
}

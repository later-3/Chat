import type { ProductSnapshot } from "@chat/contracts";
import { StoreCorruptedError } from "@chat/application";
import {
  assertSinglePlanUnderReview,
  assertSingleOpenApproval,
  assertSingleOpenPromptReview,
} from "@chat/domain";
import { assertMapKeys } from "./snapshot-integrity/map-keys.js";
import {
  assertWorkflowDefinitions,
  assertWorkflowProjection,
} from "./snapshot-integrity/workflow-definitions.js";
import {
  assertProjects,
  assertProjectBootstraps,
  assertPlanningProjectContexts,
  assertPlanningMemorySelections,
} from "./snapshot-integrity/projects.js";
import {
  assertWorkflowPolicyResolutions,
  assertRules,
  assertPromptFragments,
  assertPromptAssemblies,
} from "./snapshot-integrity/rules-prompts.js";
import { assertAgentVersions } from "./snapshot-integrity/rules-prompts.js";
import { assertNotes } from "./snapshot-integrity/notes.js";
import { assertWorkflowMemory, assertMemoryImports } from "./snapshot-integrity/workflow-memory.js";
import {
  assertSessionsAndMessages,
  assertAttempts,
} from "./snapshot-integrity/sessions-attempts.js";
import { assertLongTermContext } from "./snapshot-integrity/long-term-context.js";
import {
  assertRuns,
  assertPlansAndReviews,
  assertPromptReviews,
  assertDirectAgentCandidates,
} from "./snapshot-integrity/runs-plans.js";
import { assertExecution, assertReceiptsAndOutbox } from "./snapshot-integrity/execution.js";

/**
 * 完整快照的关系与生命周期校验。
 *
 * Zod负责单对象形状；这里负责Map键、跨对象引用、Hash、状态组合及双向关系。
 * open与transact都调用同一入口，任何不一致都失败关闭，绝不猜测修复。
 * 只有本入口公开；内部按产品对象拆分到snapshot-integrity/目录，
 * 避免调用方误把“通过局部校验”当作完整快照有效。
 */
export function assertSnapshotIntegrity(snapshot: ProductSnapshot): void {
  const { entities } = snapshot;
  const fail = (detail: string): never => {
    throw new StoreCorruptedError(`快照完整性校验失败:${detail}`);
  };

  assertMapKeys(snapshot, fail);
  assertAgentVersions(snapshot, fail);
  assertSessionsAndMessages(snapshot, fail);
  assertPromptAssemblies(snapshot, fail);
  assertAttempts(snapshot, fail);
  assertRuns(snapshot, fail);
  assertWorkflowDefinitions(snapshot, fail);
  assertWorkflowProjection(snapshot, fail);
  assertPlansAndReviews(snapshot, fail);
  assertPromptReviews(snapshot, fail);
  assertLongTermContext(snapshot, fail);
  assertMemoryImports(snapshot, fail);
  assertProjects(snapshot, fail);
  assertProjectBootstraps(snapshot, fail);
  assertPlanningProjectContexts(snapshot, fail);
  assertPlanningMemorySelections(snapshot, fail);
  assertWorkflowMemory(snapshot, fail);
  assertRules(snapshot, fail);
  assertPromptFragments(snapshot, fail);
  assertNotes(snapshot, fail);
  assertWorkflowPolicyResolutions(snapshot, fail);
  assertExecution(snapshot, fail);
  assertDirectAgentCandidates(snapshot, fail);
  assertReceiptsAndOutbox(snapshot, fail);

  for (const runId of Object.keys(entities.runs)) {
    try {
      assertSinglePlanUnderReview(
        Object.values(entities.plans).filter((plan) => plan.productRunId === runId),
      );
      assertSingleOpenApproval(
        Object.values(entities.approvalRequests).filter(
          (approval) => approval.productRunId === runId,
        ),
      );
      assertSingleOpenPromptReview(
        Object.values(entities.promptReviewRequests).filter(
          (request) => request.productRunId === runId,
        ),
      );
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}

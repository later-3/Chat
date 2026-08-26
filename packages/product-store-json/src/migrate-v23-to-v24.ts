import { productSnapshotSchema, type ProductSnapshot } from "@chat/contracts";
import type { ProductSnapshotV23 } from "./legacy-v23.js";

/**
 * v24只建立监督执行产品事实的空容器。v23没有可安全推断的Epoch、Round、Evidence或
 * Review；迁移不得读取Pi Journal、Workflow、Workspace或模型正文。
 */
export function migrateProductSnapshotV23ToV24(snapshot: ProductSnapshotV23): ProductSnapshot {
  return productSnapshotSchema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v24",
    entities: {
      ...snapshot.entities,
      supervisedPlanningEpochs: {},
      supervisedCarryForwards: {},
      supervisedStepStates: {},
      supervisedAgentAttempts: {},
      supervisedStepEvidence: {},
      supervisedStepCandidates: {},
      supervisedPlannerVerdicts: {},
      supervisedStepReviewRequests: {},
      supervisedStepHumanDecisions: {},
      supervisedAgentOutcomeObservations: {},
      supervisedExecutionResults: {},
    },
  });
}

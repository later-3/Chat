/**
 * Product Store迁移专用旧读入口。根barrel始终导出当前语义；历史reader从这里取得
 * 原声明上的冻结Schema，避免当前Project/API演进反向污染旧快照闭包。
 */
export { PRODUCT_STORE_SCHEMA_VERSION, productSnapshotSchema } from "./product-store-v20.js";
export {
  projectCandidateSchema,
  projectDecisionSchema as projectDecisionV19Schema,
  projectEvidenceSchema as projectEvidenceV19Schema,
  projectMethodSnapshotSchema as projectMethodSnapshotV19Schema,
  projectObservationSchema,
  projectResourceSchema,
  projectStateTransitionSchema,
  projectWorkSchema as projectWorkV19Schema,
} from "./project-v20.js";
export { planningProjectContextSchema } from "./planning-project-context-v1.js";

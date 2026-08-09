/**
 * 浏览器唯一允许的合同入口。
 *
 * 不导出Product Store、Trace、Workflow私有Runtime、版本证据或Provider身份；
 * 避免仅因根barrel的模块初始化就把私有Schema打进前端bundle。
 */
export * from "./ids.js";
export * from "./hash.js";
export * from "./problem-detail.js";
export * from "./command.js";
export * from "./query.js";
export * from "./service-status.js";
export * from "./product-api.js";
export type {
  ProjectIntakeProposal,
  ProjectManagementProposal,
  ProjectAdvancementProposal,
} from "./project.js";
export * from "./project-api.js";
export * from "./workflow-api.js";
export { memoryBackendIdSchema, type MemoryBackendId } from "./ids.js";
export {
  memoryContextSelectionSchema,
  memoryLayerSchema,
  memoryRequirementSchema,
  type MemoryContextSelection,
  type MemoryLayer,
  type MemoryRequirement,
} from "./context.js";

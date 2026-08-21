/**
 * @chat/realtime
 *
 * Session Activity、未来SSE投影与Debug Trace层。
 *
 * 边界：
 * - Run Activity Journal拥有可展示活动顺序；sequence在单个Product Run中严格递增。
 * - 浏览器只有一条Chat Realtime Feed；Workflow原始流与pi原始事件在后端归一化。
 * - Debug Trace只用于诊断，绝不作为Session或Trajectory的数据源。
 */
export * from "./trace-paths.js";
export * from "./trace-sink.js";
export * from "./trace-policy.js";
export * from "./trace-reader.js";
export * from "./execution-trace-reader.js";
export * from "./run-activity-journal.js";
export * from "./run-activity-mapper.js";
export * from "./legacy-trace-activity-migration.js";
export * from "./replay.js";

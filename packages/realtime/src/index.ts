/**
 * @chat/realtime
 *
 * Runtime Journal与SSE投影层；当前包含结构化Trace（任务书§7）的
 * Sink、Reader与调试CLI。
 *
 * 边界：
 * - Runtime Journal是公开事件顺序的唯一Owner；sequence在单个Product Run中严格递增。
 * - 浏览器只有一条Chat Realtime Feed；Workflow原始流与pi原始事件在后端归一化。
 * - Trace只保存可观察事件与对象引用，不保存密钥、完整正文、完整Provider Payload或隐藏推理。
 */
export * from "./trace-paths.js";
export * from "./trace-sink.js";
export * from "./trace-reader.js";
export * from "./replay.js";

/**
 * @chat/realtime
 *
 * Runtime Journal与SSE投影层。
 *
 * 边界（P0仅固定依赖方向，实现属于P1/P3）：
 * - Runtime Journal是公开事件顺序的唯一Owner；sequence在单个Product Run中严格递增。
 * - 浏览器只有一条Chat Realtime Feed；Workflow原始流与pi原始事件在后端归一化。
 */
export {};

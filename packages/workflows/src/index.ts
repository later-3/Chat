/**
 * @chat/workflows
 *
 * Vercel Workflow定义与活动层。
 *
 * 边界（P0仅固定依赖方向，实现属于P1+）：
 * - Workflow通过Application Port/Activity Adapter提交产品事实，不直接写产品表。
 * - Step输入输出必须可序列化并通过Schema校验；Step不接收数据库连接或HTTP Context。
 * - Hook Token、Workflow Run ID和Checkpoint ID只存在于Runtime Adapter。
 */
export {};

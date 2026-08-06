/**
 * @chat/application
 *
 * 用例协调与事务边界层。
 *
 * 边界（P0仅固定依赖方向，用例实现属于P1+）：
 * - Application Coordinator是一个用例的唯一产品事务所有者。
 * - 本包只依赖@chat/domain与@chat/contracts，不依赖Hono、React、
 *   Vercel Workflow、AG-UI或pi。
 * - 外部调用不放进产品数据库事务；Repository不自行提交事务。
 */
export {};

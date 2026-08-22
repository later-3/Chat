import { Hono } from "hono";
import { type ProductRouteContext, type Variables } from "./product-routes/shared.js";
import { registerWorkflowRoutes } from "./product-routes/workflow-routes.js";
import { registerPromptRoutes } from "./product-routes/prompt-routes.js";
import { registerRuleRoutes } from "./product-routes/rule-routes.js";
import { registerNoteRoutes } from "./product-routes/note-routes.js";
import { registerMemoryRoutes } from "./product-routes/memory-routes.js";
import { registerProjectBootstrapRoutes } from "./product-routes/project-bootstrap-routes.js";
import { registerProjectRoutes } from "./product-routes/project-routes.js";
import {
  registerSessionCreateRoutes,
  registerSessionDetailRoutes,
} from "./product-routes/session-routes.js";
import { registerRunRoutes } from "./product-routes/run-routes.js";

/**
 * 公开Product Router组合根。
 *
 * Router只终止协议、建立认证上下文与校验DTO；产品事实与事务由Application拥有，
 * Product Store是唯一权威。路由注册按资源族拆分到product-routes/目录，
 * 注册顺序与原单文件完全一致（Hono按注册序匹配）。
 */
export function createProductRouter(ctx: ProductRouteContext): Hono<{ Variables: Variables }> {
  const router = new Hono<{ Variables: Variables }>();

  registerWorkflowRoutes(router, ctx);
  registerPromptRoutes(router, ctx);
  registerRuleRoutes(router, ctx);
  registerNoteRoutes(router, ctx);
  registerMemoryRoutes(router, ctx);
  registerSessionCreateRoutes(router, ctx);
  registerProjectBootstrapRoutes(router, ctx);
  registerProjectRoutes(router, ctx);
  registerSessionDetailRoutes(router, ctx);
  registerRunRoutes(router, ctx);

  return router;
}

export type { ProductRouteContext } from "./product-routes/shared.js";

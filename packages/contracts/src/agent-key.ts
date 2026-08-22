import { z } from "zod";

/** Chat内置Agent定义的稳定键；完整用户配置由Agent Version另行冻结。 */
export const agentKeySchema = z.enum([
  "planner",
  "direct",
  "project_bootstrap",
  "coding_executor",
  "note_extractor",
]);

export type AgentKey = z.infer<typeof agentKeySchema>;

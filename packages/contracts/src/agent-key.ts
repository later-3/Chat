import { z } from "zod";

/** Chat内置Agent定义的稳定键；完整用户配置由Agent Version另行冻结。 */
export const agentKeySchema = z.enum(["planner", "direct", "coding_executor", "note_extractor"]);

export const agentProfileAgentKeySchema = z.enum([
  ...agentKeySchema.options,
  "governance_reviewer",
]);

export type AgentKey = z.infer<typeof agentKeySchema>;
export type AgentProfileAgentKey = z.infer<typeof agentProfileAgentKeySchema>;

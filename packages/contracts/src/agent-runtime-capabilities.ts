import { z } from "zod";

/** Pi内置Tool的叶子合同，避免Agent/Prompt/Workflow三个Schema模块形成ESM循环。 */
export const piBuiltinToolNameSchema = z.enum([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

/**
 * Pi Extension与后续Chat Adapter可以注册非内置Tool。名字仍只是某个Runtime目录内的
 * 能力键；是否真实存在、可选、可执行必须由Application对当次Runtime目录校验。
 */
export const agentRuntimeToolNameSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/u);

export const directAgentToolNameSchema = agentRuntimeToolNameSchema;

export type PiBuiltinToolName = z.infer<typeof piBuiltinToolNameSchema>;
export type AgentRuntimeToolName = z.infer<typeof agentRuntimeToolNameSchema>;
export type DirectAgentToolName = z.infer<typeof directAgentToolNameSchema>;

/**
 * 内部Runtime合同 shared 族。对外经../internal-runtime.js barrel。
 */
import { z } from "zod";
import {
  contextPackageIdSchema,
  contextRequestIdSchema,
  promptAssemblyIdSchema,
  planningMemorySelectionIdSchema,
  ruleSelectionIdSchema,
  workflowMemoryContextIdSchema,
} from "../ids.js";
import { piSystemPromptResolutionSchema } from "../prompt-assembly.js";
import { workflowDefinitionNodeIdSchema } from "../workflow-definition.js";
import { sha256Schema } from "../hash.js";

export const INTERNAL_RUNTIME_SCHEMA_VERSION = "chat-internal-runtime.v1";

export const versioned = { schemaVersion: z.literal(INTERNAL_RUNTIME_SCHEMA_VERSION) };
export const contextPackageRefFields = {
  contextPackageId: contextPackageIdSchema,
  revision: z.literal(1),
  sha256: sha256Schema,
};
export const internalContextPackageRefSchema = z.object(contextPackageRefFields).strict();
export const internalPlanningMemorySelectionRefSchema = z
  .object({
    planningMemorySelectionId: planningMemorySelectionIdSchema,
    revision: z.literal(1),
    sha256: sha256Schema,
  })
  .strict();
export const internalWorkspaceInstructionsRefSchema = z
  .object({
    contextRequestId: contextRequestIdSchema,
    revision: z.literal(1),
    sha256: sha256Schema,
  })
  .strict();
export const internalRuleSelectionRefSchema = z
  .object({
    ruleSelectionId: ruleSelectionIdSchema,
    revision: z.literal(1),
    sha256: sha256Schema,
  })
  .strict();
/** Application从Run级Assembly授权给一个具体模型节点的不可变用户Prompt层。 */
export const workflowNodePromptRuntimeSchema = z
  .object({
    promptAssemblyId: promptAssemblyIdSchema,
    promptAssemblySha256: sha256Schema,
    definitionNodeId: workflowDefinitionNodeIdSchema,
    nodeAssemblySha256: sha256Schema,
    profileVersion: z.string().min(1).max(100),
    systemPromptAppend: z.string().max(512_000),
    piSystemPrompt: piSystemPromptResolutionSchema.optional(),
  })
  .strict();

export const internalWorkflowMemoryContextRefSchema = z
  .object({
    workflowMemoryContextId: workflowMemoryContextIdSchema,
    revision: z.literal(1),
    sha256: sha256Schema,
  })
  .strict();

/* ---------- compilePlanningInput ---------- */

export const stableRuntimeErrorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/)
  .max(64);

/** Planning Attempt只由compilePlanningInput创建；该私有命令只创建执行Attempt。 */

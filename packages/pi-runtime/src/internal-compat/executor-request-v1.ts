import {
  executionContractSchema,
  runAttemptIdSchema,
  sha256Schema,
  stepResultSchema,
  workflowNodePromptRuntimeSchema,
} from "@chat/contracts";
import { z } from "zod";
import { PI_EXECUTOR_PROTOCOL_VERSION, piOperationIdSchema } from "../executor-service-contract.js";
import { executionContextItemDtoSchema } from "./execution-v1.js";

const dependencyResultSchema = stepResultSchema;

export const startPiExecutorOperationRequestSchema = z
  .object({
    schemaVersion: z.literal(PI_EXECUTOR_PROTOCOL_VERSION),
    operationId: piOperationIdSchema,
    executionAttemptId: runAttemptIdSchema,
    inputManifestSha256: sha256Schema,
    contract: executionContractSchema,
    stepId: z.string().min(1).max(100),
    contextItems: z.array(executionContextItemDtoSchema).max(50),
    dependencyResults: z.array(dependencyResultSchema).max(50),
    nodePrompt: workflowNodePromptRuntimeSchema.optional(),
  })
  .strict();

import {
  changeWorkflowDefinitionArchiveStatusPayloadSchema,
  commandEnvelopeSchema,
  createWorkflowDefinitionCopyPayloadSchema,
  publishWorkflowDefinitionPayloadSchema,
  saveWorkflowDefinitionDraftPayloadSchema,
  validateWorkflowDefinitionPayloadSchema,
  workflowBlueprintsDtoSchema,
  workflowCatalogDtoSchema,
  workflowDefinitionCommandResultDtoSchema,
  workflowDefinitionDetailDtoSchema,
  workflowDefinitionValidationDtoSchema,
  workflowDefinitionsDtoSchema,
  workflowNodeDetailDtoSchema,
  workflowResourcesDtoSchema,
  workflowRunConfigSummaryDtoSchema,
  workflowRunViewDtoSchema,
  type ChangeWorkflowDefinitionArchiveStatusPayload,
  type CommandId,
  type CreateWorkflowDefinitionCopyPayload,
  type PublishWorkflowDefinitionPayload,
  type SaveWorkflowDefinitionDraftPayload,
  type ValidateWorkflowDefinitionPayload,
  type WorkflowBlueprintsDto,
  type WorkflowCatalogDto,
  type WorkflowDefinitionCommandResultDto,
  type WorkflowDefinitionDetailDto,
  type WorkflowDefinitionValidationDto,
  type WorkflowDefinitionsDto,
  type WorkflowNodeDetailDto,
  type WorkflowNodeDetailInclude,
  type WorkflowResourcesDto,
  type WorkflowRunConfigSummaryDto,
  type WorkflowRunViewDto,
} from "@chat/contracts/public";
import { z } from "zod";
import { getWorkflowProjection, post } from "./transport.js";

const workflowCatalogResponseSchema = z.object({ catalog: workflowCatalogDtoSchema }).strict();
const workflowBlueprintsResponseSchema = z
  .object({ blueprints: workflowBlueprintsDtoSchema })
  .strict();
const workflowDefinitionsResponseSchema = z
  .object({ definitions: workflowDefinitionsDtoSchema })
  .strict();
const workflowRunConfigSummaryResponseSchema = z
  .object({ summary: workflowRunConfigSummaryDtoSchema })
  .strict();
const workflowResourcesResponseSchema = z
  .object({ resources: workflowResourcesDtoSchema })
  .strict();

export function apiGetWorkflowRunView(
  productRunId: string,
  signal?: AbortSignal,
): Promise<WorkflowRunViewDto> {
  return getWorkflowProjection(
    `/api/runs/${encodeURIComponent(productRunId)}/workflow-view`,
    (json) => workflowRunViewDtoSchema.parse(json),
    signal,
  );
}

/**
 * Composer 只读取后端投影的有限目录。ETag 快照仅是传输缓存；切换页面或主体后可丢弃，
 * 不承载未发送选择或任何产品事实。
 */
export function apiGetWorkflowCatalog(signal?: AbortSignal): Promise<WorkflowCatalogDto> {
  return getWorkflowProjection(
    "/api/workflow/catalog",
    (json) => workflowCatalogResponseSchema.parse(json).catalog,
    signal,
  );
}

export function apiGetWorkflowBlueprints(signal?: AbortSignal): Promise<WorkflowBlueprintsDto> {
  return getWorkflowProjection(
    "/api/workflow/blueprints",
    (json) => workflowBlueprintsResponseSchema.parse(json).blueprints,
    signal,
  );
}

export function apiGetWorkflowDefinitions(signal?: AbortSignal): Promise<WorkflowDefinitionsDto> {
  return getWorkflowProjection(
    "/api/workflow/definitions",
    (json) => workflowDefinitionsResponseSchema.parse(json).definitions,
    signal,
  );
}

export function apiGetWorkflowDefinition(
  workflowDefinitionId: string,
  signal?: AbortSignal,
): Promise<WorkflowDefinitionDetailDto> {
  return getWorkflowProjection(
    `/api/workflow/definitions/${encodeURIComponent(workflowDefinitionId)}`,
    (json) => workflowDefinitionDetailDtoSchema.parse(json),
    signal,
  );
}

export function apiCreateWorkflowDefinitionCopy(input: {
  readonly commandId: CommandId;
  readonly payload: CreateWorkflowDefinitionCopyPayload;
}): Promise<WorkflowDefinitionCommandResultDto> {
  return post(
    "/api/workflow/definitions/copies",
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      payload: createWorkflowDefinitionCopyPayloadSchema.parse(input.payload),
    }),
    (json) => workflowDefinitionCommandResultDtoSchema.parse(json),
  );
}

export function apiSaveWorkflowDefinitionDraft(input: {
  readonly workflowDefinitionId: string;
  readonly commandId: CommandId;
  readonly expectedDefinitionRevision: number;
  readonly payload: SaveWorkflowDefinitionDraftPayload;
}): Promise<WorkflowDefinitionCommandResultDto> {
  return post(
    `/api/workflow/definitions/${encodeURIComponent(input.workflowDefinitionId)}/drafts`,
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      expectedRevision: input.expectedDefinitionRevision,
      payload: saveWorkflowDefinitionDraftPayloadSchema.parse(input.payload),
    }),
    (json) => workflowDefinitionCommandResultDtoSchema.parse(json),
  );
}

/** Validate不写产品事实，因此直接提交strict payload，并允许Abort取消旧响应。 */
export function apiValidateWorkflowDefinition(
  payload: ValidateWorkflowDefinitionPayload,
  signal?: AbortSignal,
): Promise<WorkflowDefinitionValidationDto> {
  return post(
    "/api/workflow/definitions/validate",
    validateWorkflowDefinitionPayloadSchema.parse(payload),
    (json) => workflowDefinitionValidationDtoSchema.parse(json),
    signal,
  );
}

export function apiPublishWorkflowDefinition(input: {
  readonly workflowDefinitionId: string;
  readonly commandId: CommandId;
  readonly expectedDefinitionRevision: number;
  readonly payload: PublishWorkflowDefinitionPayload;
}): Promise<WorkflowDefinitionCommandResultDto> {
  return post(
    `/api/workflow/definitions/${encodeURIComponent(input.workflowDefinitionId)}/publish`,
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      expectedRevision: input.expectedDefinitionRevision,
      payload: publishWorkflowDefinitionPayloadSchema.parse(input.payload),
    }),
    (json) => workflowDefinitionCommandResultDtoSchema.parse(json),
  );
}

export function apiChangeWorkflowDefinitionArchiveStatus(input: {
  readonly workflowDefinitionId: string;
  readonly commandId: CommandId;
  readonly expectedDefinitionRevision: number;
  readonly payload: ChangeWorkflowDefinitionArchiveStatusPayload;
}): Promise<WorkflowDefinitionCommandResultDto> {
  return post(
    `/api/workflow/definitions/${encodeURIComponent(input.workflowDefinitionId)}/archive-status`,
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      expectedRevision: input.expectedDefinitionRevision,
      payload: changeWorkflowDefinitionArchiveStatusPayloadSchema.parse(input.payload),
    }),
    (json) => workflowDefinitionCommandResultDtoSchema.parse(json),
  );
}

export function apiGetWorkflowResources(signal?: AbortSignal): Promise<WorkflowResourcesDto> {
  return getWorkflowProjection(
    "/api/workflow/resources",
    (json) => workflowResourcesResponseSchema.parse(json).resources,
    signal,
  );
}

export function apiGetWorkflowRunConfigSummary(
  productRunId: string,
  signal?: AbortSignal,
): Promise<WorkflowRunConfigSummaryDto> {
  return getWorkflowProjection(
    `/api/runs/${encodeURIComponent(productRunId)}/workflow-config-summary`,
    (json) => workflowRunConfigSummaryResponseSchema.parse(json).summary,
    signal,
  );
}

export function apiGetWorkflowNodeDetail(
  productRunId: string,
  workflowNodeRunId: string,
  includes: readonly WorkflowNodeDetailInclude[],
  signal?: AbortSignal,
): Promise<WorkflowNodeDetailDto> {
  const normalizedIncludes = [...new Set(includes)].sort();
  const query = new URLSearchParams({ include: normalizedIncludes.join(",") });
  return getWorkflowProjection(
    `/api/runs/${encodeURIComponent(productRunId)}/workflow-nodes/${encodeURIComponent(workflowNodeRunId)}?${query.toString()}`,
    (json) => workflowNodeDetailDtoSchema.parse(json),
    signal,
  );
}

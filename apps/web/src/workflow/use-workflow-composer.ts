import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  PRODUCT_API_SCHEMA_VERSION,
  type WorkflowBlueprintsDto,
  type WorkflowCatalogDto,
  type WorkflowDefinitionsDto,
  type WorkflowResourcesDto,
  type WorkflowRunConfigSummaryDto,
} from "@chat/contracts/public";
import {
  apiGetWorkflowBlueprints,
  apiGetWorkflowCatalog,
  apiGetWorkflowDefinitions,
  apiGetWorkflowRunConfigSummary,
  apiGetWorkflowResources,
} from "../api/client.js";

const WORKFLOW_COMPOSER_STALE_MS = 30_000;

export const workflowComposerQueryKey = (resource: string) =>
  [PRODUCT_API_SCHEMA_VERSION, "workflow-composer", resource] as const;

/** Composer读取的是服务端允许范围，不在浏览器重建Catalog或Blueprint策略。 */
export function useWorkflowCatalog(): UseQueryResult<WorkflowCatalogDto> {
  return useQuery({
    queryKey: workflowComposerQueryKey("catalog"),
    queryFn: ({ signal }) => apiGetWorkflowCatalog(signal),
    staleTime: WORKFLOW_COMPOSER_STALE_MS,
    refetchOnReconnect: true,
  });
}

export function useWorkflowBlueprints(): UseQueryResult<WorkflowBlueprintsDto> {
  return useQuery({
    queryKey: workflowComposerQueryKey("blueprints"),
    queryFn: ({ signal }) => apiGetWorkflowBlueprints(signal),
    staleTime: WORKFLOW_COMPOSER_STALE_MS,
    refetchOnReconnect: true,
  });
}

export function useWorkflowDefinitions(): UseQueryResult<WorkflowDefinitionsDto> {
  return useQuery({
    queryKey: workflowComposerQueryKey("definitions"),
    queryFn: ({ signal }) => apiGetWorkflowDefinitions(signal),
    staleTime: WORKFLOW_COMPOSER_STALE_MS,
    refetchOnReconnect: true,
  });
}

export function useWorkflowResources(): UseQueryResult<WorkflowResourcesDto> {
  return useQuery({
    queryKey: workflowComposerQueryKey("resources"),
    queryFn: ({ signal }) => apiGetWorkflowResources(signal),
    staleTime: WORKFLOW_COMPOSER_STALE_MS,
    refetchOnReconnect: true,
  });
}

/** 已发送配置只从RunSpec公开摘要读取；草稿不能冒充这份只读事实。 */
export function useWorkflowRunConfigSummary(
  productRunId: string | null,
): UseQueryResult<WorkflowRunConfigSummaryDto> {
  return useQuery({
    queryKey: workflowComposerQueryKey(`run-summary:${productRunId ?? "none"}`),
    enabled: productRunId !== null,
    queryFn: ({ signal }) => apiGetWorkflowRunConfigSummary(productRunId ?? "", signal),
    staleTime: WORKFLOW_COMPOSER_STALE_MS,
    refetchOnReconnect: true,
  });
}

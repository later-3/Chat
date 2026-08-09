import { useQuery, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import {
  WORKFLOW_API_SCHEMA_VERSION,
  type WorkflowNodeDetailDto,
  type WorkflowNodeDetailInclude,
  type WorkflowRunViewDto,
} from "@chat/contracts/public";
import { apiGetWorkflowNodeDetail, apiGetWorkflowRunView } from "../api/client.js";

const DEFAULT_WORKFLOW_REFETCH_MS = 1_500;

export const workflowRunViewQueryKey = (productRunId: string) =>
  [WORKFLOW_API_SCHEMA_VERSION, "workflow-run-view", productRunId] as const;

export const workflowNodeDetailQueryKey = (
  productRunId: string,
  workflowNodeRunId: string,
  includes: readonly WorkflowNodeDetailInclude[],
) =>
  [
    WORKFLOW_API_SCHEMA_VERSION,
    "workflow-node-detail",
    productRunId,
    workflowNodeRunId,
    [...new Set(includes)].sort().join(","),
  ] as const;

/**
 * SSE现在尚未成为当前产品事实；活动Run使用有界轮询。未来SSE只能调用该失效入口，
 * 内容仍由Query重新读取，避免事件流与REST各维护一份竞争状态。
 */
export function invalidateWorkflowRunQueries(
  queryClient: QueryClient,
  productRunId: string,
): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) =>
      query.queryKey[0] === WORKFLOW_API_SCHEMA_VERSION &&
      (query.queryKey[1] === "workflow-run-view" || query.queryKey[1] === "workflow-node-detail") &&
      query.queryKey[2] === productRunId,
  });
}

export function useWorkflowRunView(
  productRunId: string | null,
  options: { readonly active: boolean; readonly refetchMs?: number },
): UseQueryResult<WorkflowRunViewDto> {
  return useQuery({
    queryKey: workflowRunViewQueryKey(productRunId ?? "none"),
    enabled: productRunId !== null,
    queryFn: ({ signal }) => apiGetWorkflowRunView(productRunId ?? "", signal),
    refetchInterval: options.active ? (options.refetchMs ?? DEFAULT_WORKFLOW_REFETCH_MS) : false,
    refetchIntervalInBackground: false,
    refetchOnReconnect: true,
  });
}

export function useWorkflowNodeDetail(input: {
  readonly productRunId: string | null;
  readonly workflowNodeRunId: string | null;
  readonly includes: readonly WorkflowNodeDetailInclude[];
}): UseQueryResult<WorkflowNodeDetailDto> {
  return useQuery({
    queryKey: workflowNodeDetailQueryKey(
      input.productRunId ?? "none",
      input.workflowNodeRunId ?? "none",
      input.includes,
    ),
    enabled: input.productRunId !== null && input.workflowNodeRunId !== null,
    queryFn: ({ signal }) =>
      apiGetWorkflowNodeDetail(
        input.productRunId ?? "",
        input.workflowNodeRunId ?? "",
        input.includes,
        signal,
      ),
    staleTime: 1_000,
    refetchOnReconnect: true,
  });
}

import {
  workflowRuntimeTraceDtoSchema,
  type ProductRunId,
  type WorkflowRuntimeTraceDto,
} from "@chat/contracts";
import { ApplicationError, type WorkflowRuntimeTraceReaderPort } from "@chat/application";

export interface WorkflowRuntimeTraceClientOptions {
  readonly workflowRuntimeBaseUrl: string;
  readonly credential: string;
  readonly timeoutMs?: number;
}

/** API到Workflow Runtime的只读Query Adapter；不会持有或暴露Runtime控制能力。 */
export class WorkflowRuntimeTraceHttpClient implements WorkflowRuntimeTraceReaderPort {
  constructor(private readonly options: WorkflowRuntimeTraceClientOptions) {}

  async read(input: { readonly productRunId: ProductRunId }): Promise<WorkflowRuntimeTraceDto> {
    let response: Response;
    try {
      response = await fetch(
        `${this.options.workflowRuntimeBaseUrl}/internal/workflow/v1/runs/${encodeURIComponent(input.productRunId)}/trace`,
        {
          headers: { "x-chat-runtime-key": this.options.credential },
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
        },
      );
    } catch {
      throw runtimeTraceUnavailable();
    }
    if (!response.ok) throw runtimeTraceUnavailable();
    try {
      return workflowRuntimeTraceDtoSchema.parse(await response.json());
    } catch {
      throw runtimeTraceUnavailable();
    }
  }
}

function runtimeTraceUnavailable(): ApplicationError {
  return new ApplicationError({
    code: "internal_error",
    httpStatus: 503,
    message: "Workflow Runtime Trace暂时不可读",
    retryable: true,
  });
}

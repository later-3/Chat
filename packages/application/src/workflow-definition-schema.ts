import {
  WORKFLOW_DEFINITION_CONTRACT_LIMITS,
  workflowDefinitionRevisionInputSchema,
  type WorkflowDefinitionRevisionInput,
} from "@chat/contracts";
import type { WorkflowDiagnostic } from "@chat/domain";

export {
  WORKFLOW_DEFINITION_CONTRACT_LIMITS,
  workflowDefinitionRevisionInputSchema,
  workflowFrozenResourceSchema,
  workflowPrincipalSnapshotSchema,
  workflowRunConfigurationSchema,
  workflowSequenceBoundarySchema,
  type WorkflowDefinitionRevisionInput,
  type WorkflowFrozenResource,
  type WorkflowPrincipalSnapshot,
  type WorkflowResourceKind,
  type WorkflowRunConfiguration,
  type WorkflowRunOverride,
} from "@chat/contracts";

export type ParsedWorkflowDefinition =
  | { readonly success: true; readonly definition: WorkflowDefinitionRevisionInput }
  | { readonly success: false; readonly diagnostics: readonly WorkflowDiagnostic[] };

/**
 * Application保留S3的安全解析包装，但底层Schema来自@chat/contracts。
 * 这样递归DTO防护、稳定诊断和正式持久合同共用同一套strict Schema。
 */
export function parseWorkflowDefinitionRevision(input: unknown): ParsedWorkflowDefinition {
  const bytes = safeJsonByteLength(input);
  if (
    bytes === undefined ||
    bytes > WORKFLOW_DEFINITION_CONTRACT_LIMITS.request.maxDefinitionBytes
  ) {
    return {
      success: false,
      diagnostics: [
        {
          family: "limit_exceeded",
          code: "definition.request_bytes_exceeded",
          path: "$",
          params: {
            limit: WORKFLOW_DEFINITION_CONTRACT_LIMITS.request.maxDefinitionBytes,
            ...(bytes !== undefined ? { actual: bytes } : {}),
          },
        },
      ],
    };
  }
  if (rawObjectDepthExceeds(input, WORKFLOW_DEFINITION_CONTRACT_LIMITS.structure.maxDepth * 4)) {
    return {
      success: false,
      diagnostics: [
        {
          family: "limit_exceeded",
          code: "definition.raw_depth_exceeded",
          path: "$",
          params: { limit: WORKFLOW_DEFINITION_CONTRACT_LIMITS.structure.maxDepth },
        },
      ],
    };
  }
  try {
    const parsed = workflowDefinitionRevisionInputSchema.safeParse(input);
    if (parsed.success) return { success: true, definition: parsed.data };
    return {
      success: false,
      diagnostics: parsed.error.issues.slice(0, 32).map((issue) => ({
        family: "definition_invalid",
        code: `definition.schema.${issue.code}`,
        path: issue.path.length === 0 ? "$" : `$.${issue.path.map(String).join(".")}`,
        params: {},
      })),
    };
  } catch {
    return {
      success: false,
      diagnostics: [
        {
          family: "definition_invalid",
          code: "definition.schema_parse_failed",
          path: "$",
          params: {},
        },
      ],
    };
  }
}

function safeJsonByteLength(input: unknown): number | undefined {
  try {
    const json = JSON.stringify(input);
    return json === undefined ? undefined : new TextEncoder().encode(json).byteLength;
  } catch {
    return undefined;
  }
}

function rawObjectDepthExceeds(input: unknown, maximum: number): boolean {
  const stack: { readonly value: unknown; readonly depth: number }[] = [{ value: input, depth: 1 }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    if (frame.depth > maximum) return true;
    if (frame.value === null || typeof frame.value !== "object") continue;
    // 循环引用已由前置JSON字节计算拒绝；这里不能用全局seen把共享的不可变
    // config对象误判成循环，否则本地编译与同一对象序列化后的网络编译语义不同。
    for (const value of Object.values(frame.value)) {
      if (value !== null && typeof value === "object") {
        stack.push({ value, depth: frame.depth + 1 });
      }
    }
  }
  return false;
}

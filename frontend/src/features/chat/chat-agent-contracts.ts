import type { Interrupt } from "@ag-ui/core";

export interface ChatWorkflowDispatch {
  endpointUrl: string;
  workflowId: string;
  workflowVersion: string;
}

export type RunStatus = "idle" | "running" | "awaiting_approval" | "saving" | "error";
export type RuntimeConnectionStatus =
  | "idle"
  | "reconnecting"
  | "replaying"
  | "caught_up"
  | "cursor_expired";

export interface DispatchRecovery {
  draftId: string;
  status: "failed" | "outcome_unknown";
  errorCode: string | null;
  message: string;
  originPrompt: string;
}

export interface EffectiveContextView {
  instructions: unknown;
  messages: unknown[];
  history_and_knowledge: ContextSourceView[];
  knowledge_sources: KnowledgeSourceView[];
  tools: unknown[];
  model_parameters: Record<string, unknown>;
  continuation: Record<string, unknown> | null;
  token_estimate: number;
  token_breakdown: {
    instructions: number;
    messages: number[];
    tools: number;
    parameters: number;
    total: number;
    method: string;
    exact: boolean;
  };
  model_capabilities: ModelCapabilities;
  adoption_reasons: Record<string, string>;
}

export interface KnowledgeSourceView {
  source_type: string;
  source_id: string;
  source_revision: string | null;
  source_label: string;
  adoption_reason: string;
  selection_origin: string;
  modified_in_review: boolean;
  token_estimate?: number;
  content?: unknown;
  content_mode?: "full" | "reference_only";
}

export interface ContextSourceView {
  input_index: number;
  source_type: string;
  source_label: string;
  adoption_reason: string;
  modified_in_review: boolean;
  token_estimate: number;
  content: unknown;
}

export interface ParameterCapability {
  key: string;
  label: string;
  value_type: "boolean" | "integer" | "number" | "enum" | "object_enum";
  default: unknown;
  choices: string[];
  minimum: number | null;
  maximum: number | null;
  child_key: string | null;
  locked: boolean;
}

export interface ModelCapabilities {
  roles: string[];
  content_types_by_role: Record<string, string[]>;
  parameters: ParameterCapability[];
  token_estimator: string;
  allow_unknown_parameters: boolean;
}

export interface ModelOption {
  id: string;
  label: string;
  capabilities: ModelCapabilities;
}

export interface ModelProviderOption {
  id: string;
  label: string;
  protocol: "openai_responses" | "openai_chat_completions";
  models: ModelOption[];
}

export interface ModelCallReviewCard {
  review_kind?: "model_call";
  message: string;
  draft_id: string;
  approval_id: string;
  thread_id: string;
  run_id: string;
  version: number;
  origin_prompt: string;
  binding_hash: string;
  body_sha256: string;
  provider_id: string;
  provider_protocol: "openai_responses" | "openai_chat_completions";
  status: string;
  execution_context: {
    workflow_id?: string;
    agent_id?: string;
    agent_name?: string;
    agent_revision?: number;
    call_position?: number;
    total_calls?: number;
    executor_id?: string;
    tool_id?: string;
    tool_name?: string;
    config_revision?: number;
    allowed_tool_names?: string[];
    context_package_id?: string | null;
    repository_source_revisions?: Array<Record<string, unknown>>;
    context_freshness?: Record<string, unknown>;
  };
  provider_catalog: ModelProviderOption[];
  effective_context: EffectiveContextView;
  provider_request: Record<string, unknown>;
  attempt?: {
    attempt_id: string;
    status: string;
    error_code: string | null;
  } | null;
}

export interface ToolExecutionReviewCard {
  review_kind: "tool_execution";
  message: string;
  approval_id: string;
  tool_call_id: string;
  tool_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  working_directory: string;
  risk: string;
  config_revision: number;
  execution_context: {
    workflow_id: string;
    executor_id: string;
    tool_id: string;
    wait_reason: string;
  };
}

export interface ProductDecisionEditableField {
  key: string;
  label: string;
  type:
    | "text"
    | "text_optional"
    | "long_text"
    | "boolean"
    | "select"
    | "multi_select"
    | "intent_set"
    | "execution_draft";
  value: unknown;
  options?: Array<{ value: string; label: string }>;
}

export interface ProductDecisionReviewCard {
  review_kind: "product_decision";
  message: string;
  approval_id: string;
  decision_request_id: string;
  decision_point_key: string;
  title: string;
  reason_summary: string;
  request_hash: string;
  row_version: number;
  subject_hash: string;
  subject_resource_id?: string;
  subject: unknown;
  facts: Record<string, unknown>;
  policy: {
    final_action: string;
    matched_rules: unknown[];
    reason_codes: string[];
  };
  allowed_actions: string[];
  editable_fields: ProductDecisionEditableField[];
  execution_context: {
    workflow_id: string;
    workflow_version: string;
    executor_id: string;
    wait_reason: "product_decision";
  };
}

export type GovernedReviewCard =
  | ModelCallReviewCard
  | ToolExecutionReviewCard
  | ProductDecisionReviewCard;

function interruptData(interrupt: Interrupt): Record<string, unknown> | null {
  const metadata = interrupt.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const framework = metadata.agent_framework;
  if (!framework || typeof framework !== "object") return null;
  const data = framework.data;
  if (!data || typeof data !== "object") return null;
  return data as Record<string, unknown>;
}

export function reviewCardFromInterrupt(interrupt: Interrupt): ModelCallReviewCard | null {
  const data = interruptData(interrupt);
  if (!data) return null;
  const card = data as unknown as Partial<ModelCallReviewCard>;
  if (
    typeof card.draft_id !== "string" ||
    typeof card.approval_id !== "string" ||
    typeof card.binding_hash !== "string" ||
    typeof card.provider_id !== "string" ||
    !Array.isArray(card.provider_catalog) ||
    !card.provider_request ||
    typeof card.provider_request !== "object"
  ) {
    return null;
  }
  return data as unknown as ModelCallReviewCard;
}

export function governedReviewFromInterrupt(interrupt: Interrupt): GovernedReviewCard | null {
  const data = interruptData(interrupt);
  if (!data) return null;
  const tool = data as unknown as Partial<ToolExecutionReviewCard>;
  const productDecision = data as unknown as Partial<ProductDecisionReviewCard>;
  if (productDecision.review_kind === "product_decision") {
    if (
      typeof productDecision.approval_id !== "string" ||
      typeof productDecision.decision_request_id !== "string" ||
      typeof productDecision.decision_point_key !== "string" ||
      !Array.isArray(productDecision.allowed_actions) ||
      !Array.isArray(productDecision.editable_fields)
    ) {
      return null;
    }
    return data as unknown as ProductDecisionReviewCard;
  }
  if (tool.review_kind === "tool_execution") {
    if (
      typeof tool.approval_id !== "string" ||
      typeof tool.tool_call_id !== "string" ||
      typeof tool.tool_name !== "string" ||
      !tool.arguments ||
      typeof tool.arguments !== "object" ||
      Array.isArray(tool.arguments)
    ) {
      return null;
    }
    return data as unknown as ToolExecutionReviewCard;
  }
  return reviewCardFromInterrupt(interrupt);
}

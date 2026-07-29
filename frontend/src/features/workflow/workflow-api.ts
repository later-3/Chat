import { checkedJson } from "../../api-client.js";
import { authenticatedFetch } from "../../authentication-recovery.js";
import { AG_UI_URL, API_BASE_URL } from "../../runtime-config.js";

export type WorkflowNodeStatus =
  | "idle"
  | "in_progress"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "abandoned"
  | "skipped";

export interface WorkflowNodeDefinition {
  id: string;
  label: string;
  description: string;
  kind: string;
  runtime_type: "executor" | "workflow" | "agent" | "tool" | "approval";
  parent_id: string | null;
  depth: number;
}

export interface WorkflowEdgeDefinition {
  source: string;
  target: string;
  condition?: string | null;
  branch_id?: string | null;
  label?: string | null;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  version: string;
  description: string;
  endpoint: string;
  selectable: boolean;
  nodes: WorkflowNodeDefinition[];
  edges: WorkflowEdgeDefinition[];
}

export interface ProductTraceEvent {
  id: string;
  session_id: string;
  run_id: string;
  sequence: number;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface RunTraceReport {
  id: string;
  session_id: string;
  run_id: string;
  report_kind: "diagnostic" | "human";
  schema_version: number;
  workflow_definition_id: string | null;
  workflow_version: string | null;
  source_first_sequence: number;
  source_last_sequence: number;
  source_event_count: number;
  content_hash: string;
  content: Record<string, unknown> & {
    generation?: {
      mode?: string;
      model_called?: boolean;
      hidden_reasoning_included?: boolean;
    };
    source?: {
      complete?: boolean;
      completeness_reason?: string;
    };
    summary?: {
      result?: string;
      visited_node_count?: number;
      tool_execution_count?: number;
      empty_field_count?: number;
    };
    actual_path?: Array<{
      ordinal: number;
      node_id: string;
      label: string;
      phase: string;
      purpose: string;
      status: string;
      path_reason: string;
      path_reason_source: string;
      input_summary: string;
      output_summary: string;
    }>;
    route_decisions?: Array<Record<string, unknown>>;
    product_decisions?: Array<Record<string, unknown>>;
    empty_fields?: Array<{
      node_id: string;
      field: string;
      code: string;
      reason: string;
    }>;
    unvisited_nodes?: Array<{
      node_id: string;
      label: string;
      phase: string;
      code: string;
      reason: string;
    }>;
  };
  text: string | null;
  created_at: string;
  updated_at: string;
}

export interface StepInputProjection {
  id: string;
  run_id: string;
  workflow_definition_id: string;
  workflow_version: string;
  node_id: string;
  projection_revision: number;
  agent_profile_key: string | null;
  context_package_id: string | null;
  protocol_definition_id: string | null;
  protocol_binding_id: string | null;
  run_spec_id: string | null;
  input: Record<string, unknown>;
  capability_allowlist: Array<Record<string, unknown>>;
  budget: Record<string, unknown>;
  output_contract: Record<string, unknown>;
  stop_conditions: Array<Record<string, unknown> | string>;
  projection_hash: string;
  created_at: string;
}

export interface ToolExecutionActivity {
  sequence: number;
  stage: string;
  status: string;
  summary: string;
  details: Record<string, unknown>;
}

export interface ExecutionWorkspaceProjection {
  id: string;
  product_run_id: string;
  run_attempt_id: string;
  runtime_job_id: string;
  tool_execution_id: string;
  repository_binding_id: string;
  repository_snapshot_id: string;
  workspace_kind: string;
  source: {
    root_key: string;
    relative_path: string;
    base_revision: string;
  };
  observed_head_oid: string | null;
  status: string;
  diff_hash: string | null;
  changed_paths: string[];
  failure_code: string | null;
  row_version: number;
  created_at: string;
  ready_at: string | null;
  retained_at: string | null;
  finished_at: string | null;
}

export interface ToolOperationProjection {
  id: string;
  authorization_consumption_id: string | null;
  provider_tool_call_id: string;
  tool_name: string;
  operation_ordinal: number;
  operation_kind: string;
  side_effect_class: string;
  arguments: Record<string, unknown>;
  arguments_hash: string;
  operation_hash: string;
  target_path: string;
  expected_preimage_hash: string;
  expected_postimage_hash: string;
  diff_preview: string;
  status: string;
  dispatch_epoch: number;
  observed_hash: string | null;
  result: Record<string, unknown> | null;
  result_hash: string | null;
  failure_code: string | null;
  resolution_code: string | null;
  attempts: Array<Record<string, unknown>>;
  reconciliations: Array<Record<string, unknown>>;
}

export interface GovernedToolExecution {
  id: string;
  session_id: string;
  run_id: string;
  run_attempt_id: string | null;
  runtime_job_id: string | null;
  run_spec_id: string | null;
  step_input_projection_id: string | null;
  repository_binding_id: string | null;
  repository_snapshot_id: string | null;
  tool_id: string;
  execution_ordinal: number | null;
  mode: string | null;
  config_revision: number;
  status: string;
  process_dispatch_state: string;
  last_activity_sequence: number;
  model_call_count: number;
  internal_tool_call_count: number;
  tokens: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
  };
  cost: number;
  duration_ms: number;
  metrics: Record<string, unknown> & {
    activities?: ToolExecutionActivity[];
    tool_calls?: Array<Record<string, unknown>>;
  };
  result: Record<string, unknown> | null;
  result_hash: string | null;
  failure_code: string | null;
  terminal_reason_code: string | null;
  workspace?: ExecutionWorkspaceProjection | null;
  operations?: ToolOperationProjection[];
  started_at: string;
  finished_at: string | null;
  row_version: number;
}

interface WorkflowListResponse {
  workflows: WorkflowDefinition[];
}

interface TraceResponse {
  trace: ProductTraceEvent[];
}

interface TraceReportsResponse {
  reports: RunTraceReport[];
}

export interface RunGovernanceView {
  run_id: string;
  execution_draft: null | {
    id: string;
    revision_id: string;
    revision: number;
    status: string;
    draft_hash: string;
    execution_brief: string;
    payload: Record<string, unknown>;
  };
  run_spec: null | {
    id: string;
    status: string;
    run_spec_hash: string;
    compiler_version: string;
    spec: Record<string, unknown>;
  };
  turn_summary: null | {
    id: string;
    topic: string;
    summary: Record<string, unknown>;
    project_hint: string | null;
    status: string;
    summary_hash: string;
    source_model_call_revision_id: string | null;
    created_at: string;
  };
  policy_evaluations: Array<{
    id: string;
    subject_id: string;
    subject_kind: string;
    workflow_node_id: string | null;
    decision_point_key: string;
    applicability_status: string;
    floor_action: string;
    preference_action: string;
    final_action: string | null;
    result_status: string;
    reason_codes: string[];
    evaluated_at: string;
  }>;
  model_calls: Array<{
    id: string;
    workflow_node_id: string;
    call_ordinal: number;
    status: string;
    current_revision_id: string | null;
    revisions: Array<{
      id: string;
      revision: number;
      status: string;
      provider_id: string;
      model: string;
      provider_body_sha256: string;
      binding_hash: string;
      attempts: Array<{
        id: string;
        attempt_number: number;
        status: string;
        http_status: number | null;
        provider_request_id: string | null;
        provider_response_id: string | null;
        usage: Record<string, number>;
        response_metadata: Record<string, unknown>;
        output_text: string | null;
        output_text_sha256: string | null;
        output_disposition: string | null;
        output_disposition_reason: string | null;
        first_byte_at: string | null;
        failure_code: string | null;
        started_at: string;
        finished_at: string | null;
        transport_events: Array<{
          id: string;
          sequence: number;
          stage: string;
          status: string;
          details: Record<string, unknown>;
          created_at: string;
        }>;
      }>;
    }>;
  }>;
  decision_requests: Array<Record<string, unknown>>;
}

async function request<T>(path: string): Promise<T> {
  return checkedJson<T>(await authenticatedFetch(`${API_BASE_URL}${path}`));
}

export function listWorkflows(): Promise<WorkflowDefinition[]> {
  return request<WorkflowListResponse>("/api/workflows").then((value) => value.workflows);
}

export function getRunTrace(sessionId: string, runId: string): Promise<ProductTraceEvent[]> {
  return request<TraceResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/trace`,
  ).then((value) => value.trace);
}

export function getRunTraceReports(sessionId: string, runId: string): Promise<RunTraceReport[]> {
  return request<TraceReportsResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/trace-reports`,
  ).then((value) => value.reports);
}

export function getRunGovernance(runId: string): Promise<RunGovernanceView> {
  return request<RunGovernanceView>(`/api/runs/${encodeURIComponent(runId)}/governance`);
}

export async function getRunStepInputs(runId: string): Promise<StepInputProjection[]> {
  return (
    await request<{ step_inputs: StepInputProjection[] }>(
      `/api/runs/${encodeURIComponent(runId)}/step-inputs`,
    )
  ).step_inputs;
}

export async function getRunToolExecutions(runId: string): Promise<GovernedToolExecution[]> {
  return (
    await request<{ tool_executions: GovernedToolExecution[] }>(
      `/api/runs/${encodeURIComponent(runId)}/tool-executions`,
    )
  ).tool_executions;
}

export function getLatestWorkflowTrace(
  sessionId: string,
  workflowId: string,
): Promise<ProductTraceEvent[]> {
  return request<TraceResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/workflows/${encodeURIComponent(workflowId)}/latest-trace`,
  ).then((value) => value.trace);
}

export function workflowEndpointUrl(endpoint: string): string {
  if (endpoint === "/api/agent") return AG_UI_URL;
  return `${API_BASE_URL}${endpoint}`;
}

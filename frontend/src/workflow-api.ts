const API_BASE_URL = import.meta.env?.VITE_API_BASE_URL ?? "http://127.0.0.1:8030";

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

interface WorkflowListResponse {
  workflows: WorkflowDefinition[];
}

interface TraceResponse {
  trace: ProductTraceEvent[];
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
        failure_code: string | null;
        started_at: string;
        finished_at: string | null;
      }>;
    }>;
  }>;
  decision_requests: Array<Record<string, unknown>>;
}

async function request<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`);
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(payload?.detail ?? `请求失败：HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function listWorkflows(): Promise<WorkflowDefinition[]> {
  return request<WorkflowListResponse>("/api/workflows").then((value) => value.workflows);
}

export function getRunTrace(sessionId: string, runId: string): Promise<ProductTraceEvent[]> {
  return request<TraceResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/trace`,
  ).then((value) => value.trace);
}

export function getRunGovernance(runId: string): Promise<RunGovernanceView> {
  return request<RunGovernanceView>(`/api/runs/${encodeURIComponent(runId)}/governance`);
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
  if (endpoint === "/api/agent" && import.meta.env?.VITE_AG_UI_URL) {
    return import.meta.env.VITE_AG_UI_URL;
  }
  return `${API_BASE_URL}${endpoint}`;
}

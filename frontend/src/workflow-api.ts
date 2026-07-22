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

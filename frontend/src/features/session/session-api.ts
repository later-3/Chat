import type { Message } from "@ag-ui/core";

import { checkedJson } from "../../api-client.js";
import { API_BASE_URL } from "../../runtime-config.js";

export interface ProductSession {
  id: string;
  thread_id: string;
  scope_id: string;
  channel: string;
  title: string;
  title_origin: "default" | "auto" | "manual";
  title_source_message_id: string | null;
  status: "active" | "archived";
  revision: number;
  active_run_id: string | null;
  model_provider_id: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface ProductMessage {
  id: string;
  agui_message_id: string;
  session_id: string;
  interaction_id: string | null;
  run_id: string | null;
  role: "user" | "assistant";
  content: unknown;
  status: string;
  context_eligible: boolean;
  ordinal: number;
  revision: number;
  created_at: string;
}

export interface ProductRun {
  id: string;
  session_id: string;
  interaction_id: string;
  agui_run_id: string;
  status: string;
  current_user_message_id: string;
  assistant_message_id: string | null;
  model_provider_id: string | null;
  model: string | null;
  retry_of_run_id: string | null;
  retry_mode: "retry" | "restart" | null;
  input_text: string | null;
  failure_code: string | null;
  failure_message: string | null;
  started_at: string;
  finished_at: string | null;
  attempts: Array<{
    id: string;
    attempt_number: number;
    runtime_kind: string;
    status: string;
    failure_code: string | null;
    failure_message: string | null;
    started_at: string;
    finished_at: string | null;
  }>;
  runtime_job: RuntimeJob | null;
}

export interface RuntimeJob {
  id: string;
  product_run_id: string;
  run_attempt_id: string;
  endpoint_key: string;
  workflow_definition_id: string;
  workflow_version: string;
  status: string;
  recoverability: string;
  checkpoint_id: string | null;
  lease_owner: string | null;
  lease_epoch: number;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  last_event_sequence: number;
  earliest_retained_sequence: number;
  external_dispatch_state: string;
  failure_code: string | null;
  failure_summary: string | null;
  cursor: string;
}

export interface RuntimeEventEnvelope {
  id: string;
  runtime_job_id: string;
  run_attempt_id: string;
  sequence: number;
  event_type: string;
  payload: Record<string, unknown>;
  payload_hash: string;
  is_terminal: boolean;
  cursor: string;
}

interface RuntimeEventsResponse {
  job: RuntimeJob;
  events: RuntimeEventEnvelope[];
  next_cursor: string;
}

export interface SessionRunControl {
  kind: "retry" | "restart";
  sourceRunId: string;
}

export function sessionControlForwardedProps(control: SessionRunControl): {
  sessionControl: SessionRunControl;
} {
  return { sessionControl: control };
}

interface SessionListResponse {
  sessions: ProductSession[];
}

interface MessageListResponse {
  messages: ProductMessage[];
}

interface RunListResponse {
  runs: ProductRun[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return checkedJson<T>(await fetch(`${API_BASE_URL}${path}`, init));
}

export function listSessions(includeArchived = false): Promise<ProductSession[]> {
  return request<SessionListResponse>(`/api/sessions?include_archived=${includeArchived}`).then(
    (value) => value.sessions,
  );
}

export function createSession(): Promise<ProductSession> {
  return request<ProductSession>("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "新会话" }),
  });
}

export function getSession(sessionId: string): Promise<ProductSession> {
  return request<ProductSession>(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

export function getSessionMessages(sessionId: string): Promise<ProductMessage[]> {
  return request<MessageListResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
  ).then((value) => value.messages);
}

export function getSessionRuns(sessionId: string): Promise<ProductRun[]> {
  return request<RunListResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/runs`).then(
    (value) => value.runs,
  );
}

export function cancelSessionRun(sessionId: string, aguiRunId: string): Promise<ProductRun> {
  return request<ProductRun>(
    `/api/sessions/${encodeURIComponent(sessionId)}/agui-runs/${encodeURIComponent(aguiRunId)}/cancel`,
    { method: "POST" },
  );
}

export function getRuntimeEvents(jobId: string, cursor?: string): Promise<RuntimeEventsResponse> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "?after_sequence=0";
  return request<RuntimeEventsResponse>(
    `/api/runtime/jobs/${encodeURIComponent(jobId)}/events${query}`,
  );
}

export function updateSession(
  sessionId: string,
  changes: {
    title?: string;
    archived?: boolean;
    model_provider_id?: string | null;
    model?: string | null;
  },
): Promise<ProductSession> {
  return request<ProductSession>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(changes),
  });
}

export function toAguiMessages(messages: ProductMessage[]): Message[] {
  return messages.map((message) => ({
    id: message.agui_message_id,
    role: message.role,
    content: message.content,
  })) as Message[];
}

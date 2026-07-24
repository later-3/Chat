import { checkedJson } from "../../api-client.js";

const API_BASE_URL = import.meta.env?.VITE_API_BASE_URL ?? "http://127.0.0.1:8030";

export type HitlMode = "inherit" | "deny" | "require_human" | "conditional" | "auto_continue";

export interface DecisionPointDefinition {
  key: string;
  version: number;
  category: string;
  label: string;
  description: string;
  subject_kind: string;
  default_mode: HitlMode;
  allowed_human_actions: string[];
  definition_hash: string;
}

export interface HitlPolicyRule {
  decision_point_key: string;
  mode: HitlMode;
  condition: Record<string, unknown> | null;
  on_match: "deny" | "require_human" | null;
  constraints: Record<string, unknown>;
  reason: string;
}

export interface HitlPolicySet {
  id: string;
  authority: "product_default" | "system_safety" | "user_preference" | string;
  scope_kind: string;
  scope_ref_id: string;
  scope_ref_revision: string | null;
  owner_principal_id: string | null;
  row_version: number;
  active_revision: null | {
    id: string;
    revision: number;
    policy_hash: string;
    change_summary: string;
    activated_at: string | null;
    rules: HitlPolicyRule[];
  };
}

export interface HitlPreview {
  decision_point_key: string;
  applicability: string;
  floor_action: "deny" | "require_human" | "auto_continue";
  preference_action: "deny" | "require_human" | "auto_continue";
  final_action: "deny" | "require_human" | "auto_continue";
  result_status: "resolved" | "failed_closed";
  facts: Record<string, unknown>;
  matched_rules: Array<{
    authority: string;
    scope_kind: string;
    scope_ref_id: string;
    mode: HitlMode;
    resolved_action: string;
    complete: boolean;
    reason: string;
  }>;
  reason_codes: string[];
  resolver_version: string;
}

export interface DurableDecisionRequest {
  id: string;
  decision_point_key: string;
  session_id: string;
  interaction_id: string | null;
  run_id: string | null;
  request_hash: string;
  title: string;
  reason_summary: string;
  visible_evidence: Record<string, unknown>;
  consequence: Record<string, unknown>;
  status: string;
  row_version: number;
  created_at: string | null;
  expires_at: string | null;
  runtime_recovery: null | {
    link_id: string;
    status: string;
    checkpoint_id: string;
    workflow_name: string;
    executor_id: string;
    graph_signature_hash: string;
  };
  items: Array<{
    item_key: string;
    status: string;
    allowed_actions: string[];
    subject: null | {
      id: string;
      kind: string;
      resource_id: string;
      resource_revision: string;
      subject_hash: string;
      workflow_definition_id: string | null;
      workflow_version: string | null;
      node_id: string | null;
      decision_view: Record<string, unknown>;
    };
  }>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return checkedJson<T>(await fetch(`${API_BASE_URL}${path}`, init));
}

export async function loadHitlConfiguration(): Promise<{
  decisionPoints: DecisionPointDefinition[];
  policySets: HitlPolicySet[];
}> {
  const [definitions, policies] = await Promise.all([
    request<{ decision_points: DecisionPointDefinition[] }>("/api/hitl/decision-points"),
    request<{ policy_sets: HitlPolicySet[] }>("/api/hitl/policy-sets"),
  ]);
  return { decisionPoints: definitions.decision_points, policySets: policies.policy_sets };
}

export function activateHitlPolicy(command: {
  scope_kind: string;
  scope_ref_id: string;
  scope_ref_revision?: string | null;
  expected_active_revision_id: string | null;
  change_summary: string;
  rules: HitlPolicyRule[];
}): Promise<HitlPolicySet> {
  return request<HitlPolicySet>("/api/hitl/policy-sets/activate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  });
}

export function previewHitlPolicy(command: {
  decision_point_key: string;
  scopes: Array<{ kind: string; ref_id: string }>;
  facts: Record<string, unknown>;
}): Promise<HitlPreview> {
  return request<HitlPreview>("/api/hitl/policy-preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  });
}

export async function listDurableDecisionRequests(
  sessionId?: string,
): Promise<DurableDecisionRequest[]> {
  const parameters = new URLSearchParams({ status: "pending" });
  if (sessionId) parameters.set("session_id", sessionId);
  const response = await request<{ decision_requests: DurableDecisionRequest[] }>(
    `/api/hitl/decision-requests?${parameters.toString()}`,
  );
  return response.decision_requests;
}

export function resolveDurableDecisionRequest(
  value: DurableDecisionRequest,
  decisions: Array<{ item_key: string; decision: string }>,
  responsePayload: Record<string, unknown> = {},
): Promise<{ decision_request_id: string; status: string }> {
  return request<{ decision_request_id: string; status: string }>(
    `/api/hitl/decision-requests/${value.id}/resolve`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_request_hash: value.request_hash,
        expected_row_version: value.row_version,
        item_decisions: decisions,
        response_payload: responsePayload,
      }),
    },
  );
}

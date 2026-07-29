import { checkedJson } from "../../api-client.js";
import { authenticatedFetch } from "../../authentication-recovery.js";
import { createClientId } from "../../client-id.js";
import { API_BASE_URL } from "../../runtime-config.js";

export interface CollaborationProtocolRule {
  id: string;
  rule_key: string;
  name: string;
  description: string;
  category: string;
  enforcement: "deterministic" | "reviewer" | "human";
  severity: "advisory" | "required" | "prohibited";
  overridable: boolean;
  condition: Record<string, unknown>;
  validator: Record<string, unknown>;
  failure_action: "warn" | "repair" | "rehitl" | "block";
  ordinal: number;
}

export interface CollaborationProtocolDefinition {
  id: string;
  protocol_key: string;
  revision: number;
  name: string;
  description: string;
  status: "active" | "deprecated" | "blocked";
  scenario_kinds: string[];
  phases: Array<{ key?: string; name?: string; description?: string }>;
  context_policy: Record<string, unknown>;
  hitl_policy: Record<string, unknown>;
  execution_policy: Record<string, unknown>;
  validation_policy: Record<string, unknown>;
  writeback_policy: Record<string, unknown>;
  ui_schema: Record<string, unknown>;
  definition_hash: string;
  rules: CollaborationProtocolRule[];
}

export interface CollaborationProtocolBinding {
  id: string;
  scope_id: string;
  scope_kind: "system" | "user" | "project" | "work_item";
  scope_ref_id: string;
  scenario_kind: string;
  protocol_definition_id: string;
  protocol_key: string;
  protocol_revision: number;
  protocol_name: string;
  parameter_overrides: Record<string, unknown>;
  disabled_rule_keys: string[];
  status: "active" | "disabled";
  row_version: number;
}

export interface ProtocolConfiguration {
  scope_id: string;
  principal_id: string;
  scenario_kinds: string[];
  protocols: CollaborationProtocolDefinition[];
  bindings: CollaborationProtocolBinding[];
}

function commandId(kind: string): string {
  return `web:${kind}:${createClientId()}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return checkedJson<T>(await authenticatedFetch(`${API_BASE_URL}${path}`, init));
}

export function loadProtocolConfiguration(): Promise<ProtocolConfiguration> {
  return request("/api/harness/protocols/configuration");
}

export function saveProtocolBinding(input: {
  scope_kind: "user" | "project" | "work_item";
  scope_ref_id: string;
  scenario_kind: string;
  protocol_definition_id: string;
  disabled_rule_keys: string[];
  status: "active" | "disabled";
  expected_row_version: number;
}): Promise<CollaborationProtocolBinding> {
  return request("/api/harness/protocols/bindings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command_id: commandId("save-protocol-binding"),
      parameter_overrides: {},
      ...input,
    }),
  });
}

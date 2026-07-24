import { checkedJson } from "../../api-client.js";
import type { ModelProviderOption } from "../../use-chat-agent";

const API_BASE_URL = import.meta.env?.VITE_API_BASE_URL ?? "http://127.0.0.1:8030";

export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  instructions: string;
  provider_id: string;
  model: string;
  enabled: boolean;
  revision: number;
}

interface AgentListResponse {
  agents: AgentProfile[];
}

export interface UpdateAgentProfile {
  expected_revision: number;
  name: string;
  description: string;
  instructions: string;
  provider_id: string;
  model: string;
  enabled: boolean;
}

export async function listAgents(): Promise<AgentProfile[]> {
  return checkedJson<AgentListResponse>(await fetch(`${API_BASE_URL}/api/agents`)).then(
    (value) => value.agents,
  );
}

export async function updateAgent(
  agentId: string,
  command: UpdateAgentProfile,
): Promise<AgentProfile> {
  const response = await fetch(`${API_BASE_URL}/api/agents/${encodeURIComponent(agentId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  return checkedJson<AgentProfile>(response);
}

export function agentModelOptions(providers: ModelProviderOption[], providerId: string) {
  return providers.find((value) => value.id === providerId)?.models ?? [];
}

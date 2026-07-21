import type { ModelProviderOption } from "./use-chat-agent";

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

async function errorMessage(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { detail?: string } | null;
  return payload?.detail ?? `请求失败：HTTP ${response.status}`;
}

export async function listAgents(): Promise<AgentProfile[]> {
  const response = await fetch(`${API_BASE_URL}/api/agents`);
  if (!response.ok) throw new Error(await errorMessage(response));
  return ((await response.json()) as AgentListResponse).agents;
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
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json() as Promise<AgentProfile>;
}

export function agentModelOptions(
  providers: ModelProviderOption[],
  providerId: string,
) {
  return providers.find((value) => value.id === providerId)?.models ?? [];
}

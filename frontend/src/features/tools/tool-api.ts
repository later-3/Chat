import { checkedJson } from "../../api-client.js";
import { authenticatedFetch } from "../../authentication-recovery.js";
import { API_BASE_URL } from "../../runtime-config.js";

export interface PiRuntimeView {
  enabled: boolean;
  available: boolean;
  integration_mode: "jsonl_rpc_subprocess";
  provider_gate: "every_pi_model_call";
  tool_gate: "every_pi_internal_tool_call";
  allowed_working_roots: string[];
  default_working_directory: string;
}

export interface PiToolConfiguration {
  id: "pi_agent";
  name: string;
  description: string;
  enabled: boolean;
  provider_id: string;
  model: string;
  working_directory: string;
  allowed_tools: string[];
  available_tools: string[];
  thinking_level: string;
  thinking_levels: string[];
  max_model_calls: number;
  timeout_seconds: number;
  system_prompt: string;
  revision: number;
  runtime: PiRuntimeView;
}

export interface ToolExecutionSummary {
  id: string;
  session_id: string;
  run_id: string;
  tool_id: string;
  config_revision: number;
  status: string;
  model_call_count: number;
  internal_tool_call_count: number;
  tokens: { input: number; output: number; cache_read: number; cache_write: number };
  cost: number;
  duration_ms: number;
  failure_code: string | null;
  metrics: Record<string, unknown>;
  started_at: string;
  finished_at: string | null;
}

export async function listTools(): Promise<PiToolConfiguration[]> {
  return checkedJson<{ tools: PiToolConfiguration[] }>(
    await authenticatedFetch(`${API_BASE_URL}/api/tools`),
    "加载Tool配置失败",
  ).then((payload) => payload.tools);
}

export async function updatePiTool(
  value: Omit<
    PiToolConfiguration,
    "id" | "name" | "description" | "available_tools" | "thinking_levels" | "runtime" | "revision"
  > & {
    expected_revision: number;
  },
): Promise<PiToolConfiguration> {
  const response = await authenticatedFetch(`${API_BASE_URL}/api/tools/pi_agent`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  return checkedJson<PiToolConfiguration>(response, "保存pi Tool配置失败");
}

export async function listPiExecutions(): Promise<ToolExecutionSummary[]> {
  const response = await authenticatedFetch(
    `${API_BASE_URL}/api/tools/pi_agent/executions?limit=20`,
  );
  return checkedJson<{ executions: ToolExecutionSummary[] }>(response, "加载pi执行统计失败").then(
    (payload) => payload.executions,
  );
}

import type { ModelProviderOption } from "./use-chat-agent";

export interface Health {
  status: string;
  service: string;
  version: string;
  agent_framework: string;
  protocol: string;
  runtime_mode: "bootstrap" | "model";
  model: string | null;
  model_call_approval: "every_call" | "not_applicable";
  product_sessions: "sqlite";
}

export interface ProviderCatalogResponse {
  default_provider_id: string | null;
  default_model: string | null;
  providers: ModelProviderOption[];
}

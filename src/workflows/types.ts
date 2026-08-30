import type { AgentConfigSelection } from "./agent-config.js";

export interface ChatWorkflowInput {
  readonly projectId?: string;
  readonly chatHome?: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly sessionId?: string;
  readonly workflowInvocationId: string;
  readonly defaultAgentConfigs?: Readonly<Record<string, AgentConfigSelection>>;
  readonly agentConfigs?: Readonly<Record<string, AgentConfigSelection>>;
}

export interface ChatWorkflowResult {
  readonly text: string;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly model: {
    readonly provider: string;
    readonly modelId: string;
  } | null;
}

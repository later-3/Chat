export interface ChatWorkflowInput {
  readonly cwd: string;
  readonly prompt: string;
  readonly sessionId?: string;
  readonly workflowInvocationId: string;
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

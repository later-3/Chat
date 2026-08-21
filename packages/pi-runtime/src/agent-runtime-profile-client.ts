import {
  agentKeySchema,
  agentRuntimeBaselineDtoSchema,
  type AgentKey,
  type AgentRuntimeBaselineDto,
} from "@chat/contracts";
import { PI_EXECUTOR_RUNTIME_HEADER } from "./executor-service-contract.js";

export interface PiAgentRuntimeProfileClientOptions {
  readonly baseUrl: string;
  readonly credential: string;
  readonly fetchFn?: typeof fetch;
}

/**
 * API只通过Pi Executor的私有只读接口读取运行时说明；本模块不加载
 * pi-coding-agent，避免它的网络运行时进入API或Workflow进程。
 */
export function createPiAgentRuntimeProfileClient(options: PiAgentRuntimeProfileClientOptions) {
  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/u, "");
  const cache = new Map<AgentKey, Promise<AgentRuntimeBaselineDto | undefined>>();
  return {
    read(agentKey: AgentKey): Promise<AgentRuntimeBaselineDto | undefined> {
      const parsedAgentKey = agentKeySchema.parse(agentKey);
      if (
        parsedAgentKey !== "direct" &&
        parsedAgentKey !== "project_bootstrap" &&
        parsedAgentKey !== "coding_executor"
      ) {
        return Promise.resolve(undefined);
      }
      const existing = cache.get(parsedAgentKey);
      if (existing !== undefined) return existing;
      const pending = (async () => {
        const response = await fetchFn(
          `${baseUrl}/internal/pi-executor/v1/agent-runtime-profiles/${encodeURIComponent(parsedAgentKey)}`,
          {
            headers: {
              accept: "application/json",
              [PI_EXECUTOR_RUNTIME_HEADER]: options.credential,
            },
          },
        );
        if (!response.ok) {
          throw new Error(`Pi Agent运行时配置不可用:${String(response.status)}`);
        }
        return agentRuntimeBaselineDtoSchema.parse(await response.json());
      })();
      cache.set(parsedAgentKey, pending);
      void pending.catch(() => cache.delete(parsedAgentKey));
      return pending;
    },
  };
}

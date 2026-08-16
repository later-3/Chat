import {
  Agent,
  EnvHttpProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";

/**
 * Provider节点的总预算目前最短为90秒（Note），Planner/Executor为120秒。
 * 连接预算必须显著高于Undici默认10秒，又必须小于最短节点总预算，让节点Abort
 * 仍然拥有最终截止时间。该策略属于Workflow Runtime生产组合根，不是E2E覆盖项。
 */
export const WORKFLOW_PROVIDER_CONNECT_TIMEOUT_MS = 60_000;

interface WorkflowNetworkPolicyDependencies {
  getGlobalDispatcher(): Dispatcher;
  setGlobalDispatcher(dispatcher: Dispatcher): void;
  createAgent(options: Agent.Options): Dispatcher;
  createEnvHttpProxyAgent(options: EnvHttpProxyAgent.Options): Dispatcher;
}

export interface WorkflowNetworkPolicyLease {
  close(): Promise<void>;
}

interface InstalledPolicy {
  readonly previous: Dispatcher;
  readonly owned: Dispatcher;
  leases: number;
  closePromise?: Promise<void>;
}

const defaultDependencies: WorkflowNetworkPolicyDependencies = {
  getGlobalDispatcher,
  setGlobalDispatcher,
  createAgent: (options) => new Agent(options),
  createEnvHttpProxyAgent: (options) => new EnvHttpProxyAgent(options),
};

function dispatcherFamily(dispatcher: Dispatcher): "direct" | "environment_proxy" {
  // Node 24的--use-env-proxy/NODE_USE_ENV_PROXY最终把全局dispatcher装配为
  // EnvHttpProxyAgent。按当前有效dispatcher选择同族实现，避免仅凭环境变量猜测
  // CLI优先级，也避免把已有HTTP(S)/NO_PROXY语义意外降级为直连。
  const constructorName = dispatcher.constructor.name;
  if (constructorName === "Agent") return "direct";
  if (constructorName === "EnvHttpProxyAgent") return "environment_proxy";
  throw new Error(`Workflow网络策略不支持替换自定义全局dispatcher:${constructorName || "unknown"}`);
}

export class WorkflowNetworkPolicyManager {
  private installed: InstalledPolicy | undefined;

  constructor(
    private readonly dependencies: WorkflowNetworkPolicyDependencies = defaultDependencies,
  ) {}

  install(): WorkflowNetworkPolicyLease {
    const active = this.installed;
    if (active !== undefined) {
      active.leases += 1;
      return this.lease(active);
    }

    const previous = this.dependencies.getGlobalDispatcher();
    const family = dispatcherFamily(previous);
    const owned =
      family === "environment_proxy"
        ? this.dependencies.createEnvHttpProxyAgent({
            connectTimeout: WORKFLOW_PROVIDER_CONNECT_TIMEOUT_MS,
            // EnvHttpProxyAgent会把普通Agent选项交给直连池，但连接代理与代理后的
            // 目标TLS分别由ProxyAgent的两个connector创建；两段都必须显式覆盖，
            // 否则启用Node环境代理时仍会退回Undici的10秒默认连接超时。
            proxyTls: { timeout: WORKFLOW_PROVIDER_CONNECT_TIMEOUT_MS },
            requestTls: { timeout: WORKFLOW_PROVIDER_CONNECT_TIMEOUT_MS },
          })
        : this.dependencies.createAgent({
            connectTimeout: WORKFLOW_PROVIDER_CONNECT_TIMEOUT_MS,
          });
    this.dependencies.setGlobalDispatcher(owned);
    const installed: InstalledPolicy = { previous, owned, leases: 1 };
    this.installed = installed;
    return this.lease(installed);
  }

  private lease(installed: InstalledPolicy): WorkflowNetworkPolicyLease {
    let released = false;
    return {
      close: async () => {
        if (released) return;
        released = true;
        installed.leases -= 1;
        if (installed.leases > 0) return;
        if (installed.closePromise !== undefined) return installed.closePromise;

        installed.closePromise = (async () => {
          if (this.installed === installed) this.installed = undefined;
          // 先恢复原dispatcher，避免关闭窗口中的新请求落到已关闭的Agent。若其他
          // 组件已主动替换全局dispatcher，则保留它，只回收本模块拥有的连接池。
          if (this.dependencies.getGlobalDispatcher() === installed.owned) {
            this.dependencies.setGlobalDispatcher(installed.previous);
          }
          await installed.owned.close();
        })();
        return installed.closePromise;
      },
    };
  }
}

const workflowNetworkPolicyManager = new WorkflowNetworkPolicyManager();

export function installWorkflowNetworkPolicy(): WorkflowNetworkPolicyLease {
  return workflowNetworkPolicyManager.install();
}

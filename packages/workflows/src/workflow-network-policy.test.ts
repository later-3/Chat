import { describe, expect, it, vi } from "vitest";
import type { Dispatcher } from "undici";
import {
  WORKFLOW_PROVIDER_CONNECT_TIMEOUT_MS,
  WorkflowNetworkPolicyManager,
} from "./workflow-network-policy.js";

class FakeDispatcher {
  readonly close = vi.fn(async () => undefined);
}

class Agent extends FakeDispatcher {}
class EnvHttpProxyAgent extends FakeDispatcher {}
class CustomDispatcher extends FakeDispatcher {}

function asDispatcher(value: FakeDispatcher): Dispatcher {
  return value as unknown as Dispatcher;
}

function harness(initial: FakeDispatcher) {
  let current = asDispatcher(initial);
  const direct = new Agent();
  const proxy = new EnvHttpProxyAgent();
  const createAgent = vi.fn(() => asDispatcher(direct));
  const createEnvHttpProxyAgent = vi.fn(() => asDispatcher(proxy));
  const setGlobalDispatcher = vi.fn((dispatcher: Dispatcher) => {
    current = dispatcher;
  });
  const manager = new WorkflowNetworkPolicyManager({
    getGlobalDispatcher: () => current,
    setGlobalDispatcher,
    createAgent,
    createEnvHttpProxyAgent,
  });
  return {
    manager,
    direct,
    proxy,
    createAgent,
    createEnvHttpProxyAgent,
    setGlobalDispatcher,
    current: () => current,
    replace: (dispatcher: FakeDispatcher) => {
      current = asDispatcher(dispatcher);
    },
  };
}

describe("Workflow Provider网络策略", () => {
  it("连接预算高于Undici默认值且小于最短Provider节点总预算", () => {
    expect(WORKFLOW_PROVIDER_CONNECT_TIMEOUT_MS).toBeGreaterThan(10_000);
    expect(WORKFLOW_PROVIDER_CONNECT_TIMEOUT_MS).toBeLessThan(90_000);
  });

  it("直连语义下安装60秒Agent，并在最后一个lease关闭时恢复和回收", async () => {
    const previous = new Agent();
    const test = harness(previous);
    const first = test.manager.install();
    const second = test.manager.install();

    expect(test.createAgent).toHaveBeenCalledWith({ connectTimeout: 60_000 });
    expect(test.createEnvHttpProxyAgent).not.toHaveBeenCalled();
    expect(test.current()).toBe(asDispatcher(test.direct));

    await first.close();
    expect(test.direct.close).not.toHaveBeenCalled();
    await second.close();
    await second.close();

    expect(test.current()).toBe(asDispatcher(previous));
    expect(test.direct.close).toHaveBeenCalledTimes(1);
  });

  it("Node环境代理已生效时保持EnvHttpProxyAgent语义", async () => {
    const previous = new EnvHttpProxyAgent();
    const test = harness(previous);
    const lease = test.manager.install();

    expect(test.createEnvHttpProxyAgent).toHaveBeenCalledWith({
      connectTimeout: 60_000,
      proxyTls: { timeout: 60_000 },
      requestTls: { timeout: 60_000 },
    });
    expect(test.createAgent).not.toHaveBeenCalled();
    expect(test.current()).toBe(asDispatcher(test.proxy));

    await lease.close();
    expect(test.current()).toBe(asDispatcher(previous));
    expect(test.proxy.close).toHaveBeenCalledTimes(1);
  });

  it("不覆盖未知自定义dispatcher，也不创建可泄漏Agent", () => {
    const test = harness(new CustomDispatcher());

    expect(() => test.manager.install()).toThrow("不支持替换自定义全局dispatcher");
    expect(test.createAgent).not.toHaveBeenCalled();
    expect(test.createEnvHttpProxyAgent).not.toHaveBeenCalled();
    expect(test.setGlobalDispatcher).not.toHaveBeenCalled();
  });

  it("关闭时若外部已替换dispatcher则保留外部值，但仍回收自建Agent", async () => {
    const test = harness(new Agent());
    const lease = test.manager.install();
    const external = new CustomDispatcher();
    test.replace(external);

    await lease.close();

    expect(test.current()).toBe(asDispatcher(external));
    expect(test.direct.close).toHaveBeenCalledTimes(1);
  });
});

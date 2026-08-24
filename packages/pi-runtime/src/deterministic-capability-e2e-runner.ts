import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AgentSessionPiDirectAgentRunner } from "./direct-agent-executor.js";

/**
 * 非付费浏览器纵向专用：仍走真实AgentSession和生产Tool gate，只把Provider流替换为
 * 进程内确定性Faux。生产组合根从不调用本工厂，也不会读取Provider凭据或发起网络请求。
 */
export function createCapabilityGovernanceE2ERunner() {
  const faux = fauxProvider({
    api: "faux",
    provider: "dashscope-coding",
    models: [{ id: "qwen3.7-plus", name: "Capability Governance Deterministic Provider" }],
  });
  faux.setResponses([
    (context) => {
      const rejected = context.messages.some(
        (message) => message.role === "user" && JSON.stringify(message).includes("拒绝"),
      );
      return fauxAssistantMessage(
        fauxToolCall(
          "bash",
          {
            command: rejected
              ? "printf 'reject-handler\\n' >> .data/e2e/dsh-capability-governance-real/rejected-handler-invocations.log"
              : "printf 'approved-handler\\n' >> .data/e2e/dsh-capability-governance-real/handler-invocations.log && printf 'CAPABILITY_GOVERNANCE_E2E_ONCE\\n' > .data/e2e/dsh-capability-governance-real/tool-output.txt",
          },
          { id: rejected ? "capability-governance-reject-1" : "capability-governance-bash-1" },
        ),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const result = [...context.messages]
        .reverse()
        .find((message) => message.role === "toolResult");
      if (result?.role !== "toolResult") throw new Error("Capability E2E缺少Tool Result");
      if (result.toolCallId === "capability-governance-reject-1") {
        if (!result.isError) throw new Error("Capability E2E拒绝场景没有收到tool.blocked");
        return fauxAssistantMessage("CAPABILITY_GOVERNANCE_E2E_REJECTED");
      }
      if (result.isError) throw new Error("Capability E2E没有取得成功Tool Result");
      return fauxAssistantMessage("CAPABILITY_GOVERNANCE_E2E_COMPLETE");
    },
  ]);
  return new AgentSessionPiDirectAgentRunner({
    model: {
      ...faux.getModel(),
      baseUrl: "https://coding.dashscope.aliyuncs.com",
    },
    createModelRuntime: async () => {
      const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      runtime.registerNativeProvider(faux.provider);
      return runtime;
    },
  });
}

import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ensureChatHome } from "../chat-home.js";
import { readLongAgentConfiguration } from "./configuration.js";

/** UI hints only; durable acceptance revalidates the effective model before accepting attachments. */
export async function readFriendCapabilities(id: string, home: string) {
  const configuration = await readLongAgentConfiguration(id, home);
  const model = configuration.agent.effective.model;
  const directories = await ensureChatHome(home);
  const runtime = await ModelRuntime.create({
    authPath: join(directories.agentDir, "auth.json"),
    modelsPath: join(directories.agentDir, "models.json"),
    allowModelNetwork: false,
  });
  return {
    schemaVersion: 1 as const,
    longAgentId: id,
    images: model !== null && runtime.getModel(model.provider, model.modelId)?.input.includes("image") === true,
    manualCompaction: false,
    followUp: true,
  };
}

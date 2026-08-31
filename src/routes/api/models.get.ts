import { join } from "node:path";
import { createError, defineEventHandler } from "nitro/h3";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ensureChatHome } from "../../chat-home.js";

/**
 * Lists the model catalog from the same Chat Home agent directory that the
 * Workflow assembly path reads, so every selectable model is one the runtime
 * can actually resolve.
 */
export default defineEventHandler(async () => {
  try {
    const home = await ensureChatHome();
    const runtime = await ModelRuntime.create({
      authPath: join(home.agentDir, "auth.json"),
      modelsPath: join(home.agentDir, "models.json"),
    });
    return {
      schemaVersion: 1,
      providers: runtime.getProviders().map((provider) => ({
        id: provider.id,
        name: provider.name,
        authConfigured: runtime.hasConfiguredAuth(provider.id),
      })),
      models: runtime.getModels().map((model) => ({
        provider: model.provider,
        modelId: model.id,
        name: model.name,
        reasoning: model.reasoning,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        authConfigured: runtime.hasConfiguredAuth(model.provider),
      })),
    };
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});

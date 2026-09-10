import { join } from "node:path";
import { createError, defineEventHandler } from "nitro/h3";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ensureChatHome } from "../../chat-home.js";
import { CHAT_THINKING_LEVELS } from "../../model-capabilities.js";
import { readChatModelsConfig } from "../../models-config.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lists only the models the user configured in Chat Home's models.json, with
 * display metadata and auth state resolved through the same runtime the
 * assembly path reads. It never imports the whole Pi built-in catalog, so the
 * picker can only offer models the user actually gave to Chat.
 */
export default defineEventHandler(async () => {
  try {
    const home = await ensureChatHome();
    const authPath = join(home.agentDir, "auth.json");
    const modelsPath = join(home.agentDir, "models.json");
    const config = await readChatModelsConfig();
    const runtime = await ModelRuntime.create({ authPath, modelsPath });

    const providers: Array<{ id: string; name: string; authConfigured: boolean }> = [];
    const models: Array<{
      provider: string;
      modelId: string;
      name: string;
      reasoning: boolean;
      contextWindow: number;
      maxTokens: number;
      authConfigured: boolean;
    }> = [];
    for (const [providerId, rawProvider] of Object.entries(config.config.providers)) {
      if (!isRecord(rawProvider) || !Array.isArray(rawProvider.models)) continue;
      const authConfigured = runtime.hasConfiguredAuth(providerId);
      providers.push({
        id: providerId,
        name: runtime.getProvider(providerId)?.name ?? providerId,
        authConfigured,
      });
      for (const rawModel of rawProvider.models) {
        if (!isRecord(rawModel) || typeof rawModel.id !== "string" || rawModel.id.trim() === "") continue;
        const modelId = rawModel.id;
        const model = runtime.getModel(providerId, modelId);
        models.push({
          provider: providerId,
          modelId,
          name: model?.name ?? modelId,
          reasoning: model?.reasoning ?? false,
          contextWindow: model?.contextWindow ?? 0,
          maxTokens: model?.maxTokens ?? 0,
          authConfigured,
        });
      }
    }
    return { schemaVersion: 1, providers, models, thinkingLevels: CHAT_THINKING_LEVELS };
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});

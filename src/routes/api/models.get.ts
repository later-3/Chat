import { defineEventHandler } from "nitro/h3";

/** 模型由Chat Workflow中的Pi AgentSession选择，前端当前只展示实际返回的模型。 */
export default defineEventHandler(() => ({
  models: {},
  modelList: [],
  defaultModel: null,
  thinkingLevels: {},
  thinkingLevelMaps: {},
  modelScopeWarnings: [],
}));

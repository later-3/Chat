import type { ChatToolProvider } from "../../framework.js";
import manifest from "./tool.json" with { type: "json" };
import { projectConfigureSchema } from "../../../projects/management-contract.js";
import { defineProjectTool } from "../project/runtime.js";

export const PROJECT_CONFIGURE_TOOL_PROVIDER: ChatToolProvider = defineProjectTool(manifest, projectConfigureSchema, async (params, context) => {
  const service = await import("../../../projects/management.js");
  return service.updateProjectConfiguration(params, context);
});

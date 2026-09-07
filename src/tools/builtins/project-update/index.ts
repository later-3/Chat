import type { ChatToolProvider } from "../../framework.js";
import manifest from "./tool.json" with { type: "json" };
import { projectUpdateSchema } from "../../../projects/management-contract.js";
import { defineProjectTool } from "../project/runtime.js";

export const PROJECT_UPDATE_TOOL_PROVIDER: ChatToolProvider = defineProjectTool(manifest, projectUpdateSchema, async (params, context) => {
  const service = await import("../../../projects/management.js");
  return service.updateProject(params, context);
});

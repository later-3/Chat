import type { ChatToolProvider } from "../../framework.js";
import manifest from "./tool.json" with { type: "json" };
import { projectOpenSchema } from "../../../projects/management-contract.js";
import { defineProjectTool } from "../project/runtime.js";

export const PROJECT_OPEN_TOOL_PROVIDER: ChatToolProvider = defineProjectTool(manifest, projectOpenSchema, async (params, context) => {
  const service = await import("../../../projects/management.js");
  return service.openProjectForAgent(params, context);
});

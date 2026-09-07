import type { ChatToolProvider } from "../../framework.js";
import manifest from "./tool.json" with { type: "json" };
import { projectSearchSchema } from "../../../projects/management-contract.js";
import { defineProjectTool } from "../project/runtime.js";

export const PROJECT_SEARCH_TOOL_PROVIDER: ChatToolProvider = defineProjectTool(manifest, projectSearchSchema, async (params, context) => {
  const service = await import("../../../projects/management.js");
  return service.searchProjects(params, context);
});

import type { ChatToolProvider } from "../../framework.js";
import manifest from "./tool.json" with { type: "json" };
import { projectReadSchema } from "../../../projects/management-contract.js";
import { defineProjectTool } from "../project/runtime.js";

export const PROJECT_READ_TOOL_PROVIDER: ChatToolProvider = defineProjectTool(manifest, projectReadSchema, async (params, context) => {
  const service = await import("../../../projects/management.js");
  return service.readProject(params, context);
});

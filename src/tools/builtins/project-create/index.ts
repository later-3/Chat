import type { ChatToolProvider } from "../../framework.js";
import manifest from "./tool.json" with { type: "json" };
import { projectCreateSchema } from "../../../projects/management-contract.js";
import { defineProjectTool } from "../project/runtime.js";

export const PROJECT_CREATE_TOOL_PROVIDER: ChatToolProvider = defineProjectTool(manifest, projectCreateSchema, async (params, context) => {
  const service = await import("../../../projects/management.js");
  return service.createProject(params, context);
});

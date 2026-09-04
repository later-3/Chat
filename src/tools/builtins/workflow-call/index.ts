import manifestJson from "./tool.json" with { type: "json" };
import { createWorkflowCallTool } from "../../../workflows/workflow-call-tool.js";
import { defineChatSystemTool } from "../../framework.js";

/** Chat-owned provider; execution remains behind the narrow Backend runtime bridge. */
export const WORKFLOW_CALL_TOOL_PROVIDER = defineChatSystemTool(
  manifestJson,
  (context) => createWorkflowCallTool(context),
);

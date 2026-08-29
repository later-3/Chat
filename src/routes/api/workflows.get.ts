import { defineEventHandler } from "nitro/h3";
import { listChatWorkflowDefinitions } from "../../workflows/registry.js";

/** Returns the Workflow and Agent definitions registered by Chat. */
export default defineEventHandler(() => ({
  workflows: listChatWorkflowDefinitions(),
}));

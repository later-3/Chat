import { realpath, stat } from "node:fs/promises";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "../../../../../../files/access.js";
import { parseAgentConfigSelection } from "../../../../../../workflows/agent-definition.js";
import { inspectWorkflowAgent } from "../../../../../../workflows/agent-inspection.js";
import { getChatWorkflowDefinition } from "../../../../../../workflows/registry.js";

function errorResponse(error: unknown): never {
  throw createError({
    statusCode: 400,
    statusMessage: error instanceof Error ? error.message : String(error),
  });
}

export default defineEventHandler(async (event) => {
  const workflowId = getRouterParam(event, "workflowId");
  const agentId = getRouterParam(event, "agentId");
  const workflow = workflowId === undefined ? undefined : getChatWorkflowDefinition(workflowId);
  const agent = workflow?.agents.find((candidate) => candidate.id === agentId);
  if (workflow === undefined || agent === undefined) {
    throw createError({ statusCode: 404, statusMessage: "找不到Workflow或Agent" });
  }

  const body = await readBody<unknown>(event);
  if (typeof body !== "object" || body === null || !("cwd" in body) || typeof body.cwd !== "string") {
    throw createError({ statusCode: 400, statusMessage: "cwd必须是字符串" });
  }
  let cwd: string;
  try {
    cwd = await realpath(body.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error("cwd不是目录");
  } catch (error) {
    return errorResponse(error);
  }
  if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) {
    throw createError({ statusCode: 403, statusMessage: "Access denied" });
  }

  try {
    const selection = "selection" in body && body.selection !== undefined
      ? parseAgentConfigSelection(body.selection)
      : undefined;
    return await inspectWorkflowAgent({
      cwd,
      defaultAgent: agent,
      ...(selection === undefined ? {} : { selection }),
    });
  } catch (error) {
    return errorResponse(error);
  }
});

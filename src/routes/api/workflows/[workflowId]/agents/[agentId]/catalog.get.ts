import { realpath, stat } from "node:fs/promises";
import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "../../../../../../files/access.js";
import { listPiExtensions } from "../../../../../../resources/extensions.js";
import { listPiPlugins } from "../../../../../../resources/plugins.js";
import { listPiSkills } from "../../../../../../resources/skills.js";
import { inspectWorkflowAgent } from "../../../../../../workflows/agent-inspection.js";
import { getChatWorkflowDefinition } from "../../../../../../workflows/registry.js";
import { resolveProjectContext } from "../../../../../../projects/registry.js";

/** Keeps Workflow-private Skills inspection-only while returning Personal and Project Skill choices. */
export default defineEventHandler(async (event) => {
  const workflowId = getRouterParam(event, "workflowId");
  const agentId = getRouterParam(event, "agentId");
  const workflow = workflowId === undefined ? undefined : getChatWorkflowDefinition(workflowId);
  const agent = workflow?.agents.find((candidate) => candidate.id === agentId);
  if (workflow === undefined || agent === undefined) {
    throw createError({ statusCode: 404, statusMessage: "找不到Workflow或Agent" });
  }

  const query = getQuery(event);
  const rawProjectId = query.projectId;
  const project = typeof rawProjectId === "string"
    ? await resolveProjectContext(rawProjectId)
    : undefined;
  const rawCwd = project?.cwd ?? query.cwd;
  if (typeof rawCwd !== "string" || rawCwd.trim() === "") {
    throw createError({ statusCode: 400, statusMessage: "cwd必须是字符串" });
  }
  let cwd: string;
  try {
    cwd = await realpath(rawCwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error("cwd不是目录");
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) });
  }
  if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) {
    throw createError({ statusCode: 403, statusMessage: "Access denied" });
  }

  try {
    const [inspection, availableSkills, availableExtensions, availablePlugins] = await Promise.all([
      inspectWorkflowAgent({
        ...(project === undefined ? {} : { projectId: project.projectId, chatHome: project.chatHome }),
        cwd,
        defaultAgent: {
          ...agent,
          tools: { mode: "pi-default" },
          resources: { mode: "inherit" },
        },
        workflowId: workflow.id,
        agentId: agent.id,
        ...(workflow.prepareAgentSession === undefined
          ? {}
          : { prepareAgentSession: workflow.prepareAgentSession }),
      }),
      listPiSkills(cwd, project?.projectId),
      listPiExtensions(cwd, project?.projectId),
      listPiPlugins(cwd, project?.projectId),
    ]);

    const extensionsByPath = new Map(
      inspection.extensions.map((extension) => [extension.resolvedPath, extension]),
    );
    for (const extension of availableExtensions.extensions) {
      if (!extension.enabled || extensionsByPath.has(extension.path)) continue;
      extensionsByPath.set(extension.path, {
        path: extension.path,
        resolvedPath: extension.path,
        sourceInfo: {
          path: extension.path,
          source: extension.source,
          scope: extension.scope === "global" ? "user" : "project",
          origin: extension.origin === "package" ? "package" : "top-level",
        },
        address: extension.address,
        version: extension.version,
        capabilities: {
          tools: [],
          commands: [],
          flags: [],
          shortcuts: [],
          eventHandlers: [],
          hasMarkdownTransformer: false,
        },
      });
    }
    const plugins = availablePlugins.packages
      .filter((plugin) => !plugin.disabled)
      .map((plugin) => ({
        source: plugin.source,
        scope: plugin.scope,
        skills: plugin.resources.filter((resource) => resource.kind === "skill").map((resource) => resource.path),
        extensions: plugin.resources.filter((resource) => resource.kind === "extension").map((resource) => resource.path),
        prompts: plugin.resources.filter((resource) => resource.kind === "prompt").map((resource) => resource.path),
      }));
    return {
      ...inspection,
      skills: availableSkills.skills,
      extensions: [...extensionsByPath.values()],
      plugins,
      diagnostics: [
        ...inspection.diagnostics,
        ...availableSkills.diagnostics.map((diagnostic) => ({ resource: "skill-catalog", ...diagnostic })),
        ...availableExtensions.errors.map((diagnostic) => ({
          resource: "extension-catalog",
          type: "error",
          path: diagnostic.path,
          message: diagnostic.error,
        })),
        ...availablePlugins.diagnostics.map((diagnostic) => ({ resource: "plugin-catalog", ...diagnostic })),
      ],
    };
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) });
  }
});

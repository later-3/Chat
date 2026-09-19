import { ensureAgentHomeProject, resolveProjectContext } from "../projects/registry.js";
import { ensureLongAgentResourceDirs, longAgentConfigRoot } from "./storage.js";
import { buildAgentGroupContextInstructions, readLongAgentAgentGroup, type readFrozenLongAgentAgentGroup } from "./agent-group-service.js";
import { buildReplyFormatInstruction, localDate } from "./reply-template.js";
import { buildLongAgentHandoff } from "./summaries.js";
import type { LongAgentConfig } from "./types.js";

/** Lifecycle and inspection share Friend-owned inputs; public assembly owns project rules/tools/settings. */
export async function prepareLongAgentAssembly(input: {
  readonly agent: LongAgentConfig;
  readonly chatHome: string;
  readonly projectId: string | null;
  readonly turnId: string;
  readonly today?: string;
  readonly groupContext?: Awaited<ReturnType<typeof readFrozenLongAgentAgentGroup>>;
}) {
  const { agent, chatHome } = input;
  const own = await ensureAgentHomeProject(agent.id, agent.name, chatHome);
  await ensureLongAgentResourceDirs(chatHome, agent.id);
  const project = input.projectId === null ? null : await resolveProjectContext(input.projectId, chatHome);
  const group = input.groupContext ?? await readLongAgentAgentGroup(agent.id, chatHome);
  const handoff = await buildLongAgentHandoff({ chatHome, longAgentId: agent.id, ...(input.today === undefined ? {} : { today: input.today }) });
  const format = buildReplyFormatInstruction(agent.responseTemplate, {
    project: project?.name ?? "无协作项目", agentName: agent.name, date: input.today ?? localDate(),
  });
  return {
    invocation: {
      turnId: input.turnId, projectId: input.projectId,
      ownWorkspace: own.cwd, ownResourceRoot: longAgentConfigRoot(chatHome, agent.id),
    },
    agent: {
      ...agent.definition,
      customInstructions: [
        ...agent.definition.customInstructions,
        { text: buildAgentGroupContextInstructions(group) },
        ...(format === null ? [] : [{ text: format }]),
        ...(handoff === null ? [] : [{ text: handoff }]),
      ],
    },
  };
}

import { ensureAgentHomeProject, resolveProjectContext } from "../projects/registry.js";
import { ensureLongAgentResourceDirs, longAgentConfigRoot } from "./storage.js";
import { buildAgentGroupContextInstructions, readLongAgentAgentGroup, type readFrozenLongAgentAgentGroup } from "./agent-group-service.js";
import { buildReplyFormatInstruction, localDate } from "./reply-template.js";
import { buildLongAgentHandoff } from "./summaries.js";
import { longAgentScopeInstructions, type LongAgentScope } from "./scope.js";
import type { LongAgentConfig } from "./types.js";

/** Lifecycle and inspection share Friend-owned inputs; public assembly owns project rules/tools/settings. */
export async function prepareLongAgentAssembly(input: {
  readonly agent: LongAgentConfig;
  readonly chatHome: string;
  readonly projectId: string | null;
  readonly turnId: string;
  readonly today?: string;
  readonly groupContext?: Awaited<ReturnType<typeof readFrozenLongAgentAgentGroup>>;
  /**
   * Backend-resolved authorization scope for this turn. Omitted callers keep the established direct
   * behaviour; a conversation scope excludes private injections and non-authorized tools by default.
   */
  readonly scope?: LongAgentScope;
  /** Grants commitment from the trusted record; produced together with `scope`. */
  readonly scopeGrantsDigest?: string;
}) {
  const { agent, chatHome } = input;
  const own = await ensureAgentHomeProject(agent.id, agent.name, chatHome);
  await ensureLongAgentResourceDirs(chatHome, agent.id);
  const project = input.projectId === null ? null : await resolveProjectContext(input.projectId, chatHome);
  const scope = input.scope;
  const includeGroup = scope === undefined || scope.include.agentGroupInstructions;
  const includeHandoff = scope === undefined || scope.include.dailyHandoff;
  const group = includeGroup ? input.groupContext ?? await readLongAgentAgentGroup(agent.id, chatHome) : undefined;
  const handoff = includeHandoff
    ? await buildLongAgentHandoff({ chatHome, longAgentId: agent.id, ...(input.today === undefined ? {} : { today: input.today }) })
    : null;
  const format = buildReplyFormatInstruction(agent.responseTemplate, {
    project: project?.name ?? "无协作项目", agentName: agent.name, date: input.today ?? localDate(),
  });
  return {
    invocation: {
      turnId: input.turnId, projectId: input.projectId,
      ownWorkspace: own.cwd, ownResourceRoot: longAgentConfigRoot(chatHome, agent.id),
      ...(scope === undefined ? {} : { scope, ...(input.scopeGrantsDigest === undefined ? {} : { scopeGrantsDigest: input.scopeGrantsDigest }) }),
    },
    agent: {
      ...agent.definition,
      customInstructions: [
        ...agent.definition.customInstructions,
        ...(group === undefined ? [] : [{ text: buildAgentGroupContextInstructions(group) }]),
        ...(format === null ? [] : [{ text: format }]),
        ...(handoff === null ? [] : [{ text: handoff }]),
        ...(scope === undefined ? [] : [{ text: longAgentScopeInstructions(scope, { agentName: agent.name }) }]),
      ],
    },
  };
}

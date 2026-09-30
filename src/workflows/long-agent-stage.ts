import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { parseWorkflowAgentDefinition } from "./agent-config.js";
import type { CreateWorkflowAgentSessionOptions } from "./agent-definition.js";
import { readChatSessionRunBinding } from "./session-run-registry.js";
import { requireAcceptedWorkflowTurn } from "./long-agent-context.js";
import { installAcceptedAssembly } from "../long-agents/turn-queue.js";
import { readAssemblySnapshot, persistAssemblySnapshot, assemblyRevision } from "../agents/assembly-context.js";
import { getLiveRoundHandle, registerLiveTurn } from "../long-agents/live-turn.js";
import { projectSessionContext } from "../session-read-model.js";

/** A stage keeps its Workflow role/tools; the trusted owner supplies identity and frozen scope. */
export async function attachLongAgentWorkflowContext(options: CreateWorkflowAgentSessionOptions) {
  const project = options.chatSession.projectContext;
  const context = options.toolContext;
  const invocationId = context?.workflowInvocationId;
  if (project?.kind !== "agent" || invocationId === undefined || context === undefined) return { options };
  const binding = await readChatSessionRunBinding(project.projectDataDir, invocationId);
  if (binding?.acceptedLongAgentTurn === undefined) return { options };
  const turn = await requireAcceptedWorkflowTurn({ acceptedLongAgentTurn: binding.acceptedLongAgentTurn,
    projectId: project.projectId, chatHome: project.chatHome,
    sessionId: options.sessionManager.getSessionId(), workflowInvocationId: invocationId }, context.purpose !== "execution");
  // The owner identity and collaboration files were frozen at admission, even if this stage starts
  // after an hours-long review. A Workflow contributes its role/tools, not a new owner or project.
  installAcceptedAssembly(options.sessionManager, turn, { skipCollaborationHistory: true });
  const owner = readAssemblySnapshot(options.sessionManager, turn.turnId);
  if (owner === undefined) throw new Error("接受轮次缺少装配快照");
  const stageTurnId = `workflow:${invocationId}:${context.stageId}:${options.agent.id}`;
  const role = options.agent;
  const memoryMaintenance = role.id === "session-memory-writer";
  const identityEntry = options.sessionManager.getEntries().find(entry => entry.type === "custom" && entry.customType === "chat.agent-assembly-identity.v1"
    && typeof entry.data === "object" && entry.data !== null && "turnId" in entry.data && entry.data.turnId === turn.turnId);
  const identity = identityEntry?.type === "custom" && typeof identityEntry.data === "object" && identityEntry.data !== null && "instructions" in identityEntry.data
    ? parseWorkflowAgentDefinition({ schemaVersion: 1, id: role.id, name: role.name, description: role.description, systemPrompt: { mode: "pi-default" }, tools: { mode: "none" }, customInstructions: identityEntry.data.instructions }).customInstructions
    : [...(owner.agent.systemPrompt.mode === "replace" ? [{ text: owner.agent.systemPrompt.text }] : []), ...owner.agent.customInstructions];
  // Resolved definitions also carry inspection provenance. Only capability fields belong in an assembly snapshot.
  const agent = parseWorkflowAgentDefinition({
    schemaVersion: role.schemaVersion, id: role.id, name: role.name, description: role.description,
    model: role.model, thinkingLevel: role.thinkingLevel, systemPrompt: role.systemPrompt,
    tools: role.tools, resources: role.resources, customInstructions: [
    ...(memoryMaintenance ? [] : identity), ...role.customInstructions,
  ] });
  const { revision: _revision, ...body } = { ...owner, turnId: stageTurnId, agent,
    ...(memoryMaintenance ? { contextFiles: [] } : {}) };
  if (context.purpose === "execution")
    persistAssemblySnapshot(options.sessionManager, { ...body, revision: assemblyRevision(body) }, { skipCollaborationHistory: true });
  return {
    options: { ...options,
      agent,
      toolContext: { ...context, longAgentId: turn.longAgentId, longAgentTurnId: turn.turnId },
    },
    invocation: { turnId: stageTurnId, ownWorkspace: owner.ownWorkspace, ownResourceRoot: owner.ownResourceRoot, projectId: owner.projectId },
    attachLive(session: AgentSession) {
      let live = getLiveRoundHandle(project.chatHome, turn.turnId);
      if (live === undefined) {
        registerLiveTurn(project.chatHome, turn, session,
          projectSessionContext(options.sessionManager.getEntries(), options.sessionManager.getLeafId()).messages);
        live = getLiveRoundHandle(project.chatHome, turn.turnId)!;
      }
      live.setSession(session);
      live.setRoundPhase(options.toolContext?.stageId === "remember" ? "remember" : "work");
      const unsubscribe = session.subscribe(event => live.publish(event));
      const dispose = session.dispose.bind(session);
      session.dispose = () => { unsubscribe(); dispose(); };
    },
  };
}

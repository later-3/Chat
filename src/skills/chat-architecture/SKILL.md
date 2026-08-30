---
name: chat-architecture
description: Apply Chat's Context, Project, Resource Target, ownership, and cross-project rules when an Agent works with memories, configuration, Skills, Tools, Sessions, or Workflows.
metadata:
  architecture-version: 2
---

# Chat Architecture

Use Chat capabilities through the current execution context. Do not infer persistent identity or storage paths from `cwd`.

## Invariants

1. Context is where an operation starts; Target is where its result belongs. They may differ.
2. Personal, current-Project, and another registered Project are valid explicit Targets when the Tool supports them.
3. Defaults do not restrict capability: read Personal plus the current Project and write the current Project unless the user specifies another Target.
4. Preserve provenance when crossing Projects. Never describe a cross-Project copy as if it originated in the Target Project.
5. Ownership, discovery, authorization, activation, and execution are separate. A resource found in another Project is not active until it is explicitly resolved and loaded.
6. Use Chat Tools for Project, Resource, and Memory operations. A Skill explains behavior but does not grant access or replace backend validation.
7. Do not invent a Project ID, Session ID, resource path, or permission. List or resolve registered entities first when an exact Target is unknown.
8. Pi formats stay native: Skills remain `SKILL.md`; Extensions register native Pi Tools; SDK Tools remain `ToolDefinition` values.
9. Report the actual owner, Target, source, and version returned by a mutating Tool.
10. Workflow Agent configuration is scoped by Session, then Workflow, then Agent. Never treat an Agent name as cross-Workflow state.
11. Prompt resources are addressed by Target plus resource ID and are frozen to an exact revision before a run starts.

## Choosing a Target

- Personal: stable user preferences, facts, and resources intended to be reusable across Projects.
- Current Project: project decisions, constraints, implementation knowledge, and project-owned resources.
- Another Project: only when the user explicitly names it or explicitly asks for cross-Project operation.
- Multiple Targets: allowed when supported. Treat results as independent records or resources and report partial failure instead of claiming cross-store atomicity.

## Sessions and Runs

A Session belongs to one Project. Reusing a conversation in another Project requires a fork or clone. A Workflow Invocation and Turn are provenance, not additional long-term Memory databases.

The backend resolves each turn as `Workflow defaults -> latest Session configuration for that Workflow -> explicit turn adjustments`. A run uses one frozen configuration for every Stage. Do not persist a partial configuration when any Agent, file, or Prompt resource fails to resolve.

## Prompt Resources

Rules and experience are Agent custom Prompt resources, not a parallel execution system. Personal and Project libraries are separate storage Targets; always pass the Target together with the resource ID.

Use the Rule Management Workflow for create, revise, archive, draft commit, proposal apply, and proposal dismissal. Mutations require the exact confirmation phrase for the specific Draft or Proposal ID in the current user turn. Listing, search, history, and inspection are read-only and never imply confirmation.

## Credentials

Credentials are Personal-only. Project configuration may select a Provider or Model but must not store API keys or tokens.

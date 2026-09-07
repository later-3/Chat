---
name: chat-architecture
description: Navigate Chat's authoritative architecture sources and evaluate architecture impact when changing or diagnosing Projects, Workflows, Agent assembly, Sessions, Memory, configuration, resources, or the Frontend-to-Pi execution chain.
metadata:
  architecture-version: 5
---

# Chat architecture

Use this Skill as an architecture navigator and change-impact workflow for the Chat Project. It is not an architecture specification and must not become a second source of truth.

Do not reproduce large parts of the architecture documents in prompts, plans, or reports. Read the relevant source, cite the exact document, and carry forward only the conclusions needed for the current task.

## Find the authoritative source

Start with the Project root `AGENTS.md`, then `docs/architecture/README.md`. Read only the documents selected by the task:

- Development process, handoff and justified architecture exceptions: `docs/development/agent-contribution.md`.
- Module ownership, API changes, resource refresh and long connections: `docs/architecture/chat-module-contracts.md`.
- User feedback, logs, persistence and regression evidence: `docs/development/diagnostics.md`.
- Long Agent Skill discovery/effective versions, native capabilities, testing and implementation order: `docs/architecture/chat-long-agent-engineering-baseline.md`, especially §4 for resources and §9 for accepted decisions.
- Long Agent definition/configuration and independent resources: `docs/long-agents.md` and `docs/architecture/chat-long-agent-capability-model.md`.
- Concurrent work, same-Session ordering and shared writes: `docs/architecture/chat-long-agent-mechanism-contract.md` §3.2; concrete simulation: `docs/architecture/chat-long-agent-interaction-simulations.md` §4.3. Current lock evidence: `src/long-agents/runtime.ts`, not a claim that the target collaboration contract is implemented.
- Long Agent Sessions, history, schedules, Docker and Social: `docs/architecture/chat-long-agent-architecture.md`; acceptance scenarios: `docs/architecture/chat-long-agent-scenarios.md`.
- Long Agent current support/migration: `docs/architecture/chat-long-agent-roadmap.md`. Its approved target differs from the legacy `primarySessionId`, shared Daily and Docker-free implementation. Interaction mechanisms are consolidated in `docs/architecture/chat-long-agent-mechanism-contract.md`; detailed interfaces remain to be designed.
- New capabilities or changes to Agent responsibilities: `docs/architecture/chat-agent-first-principles.md`.
- Project identity, ownership, Target, resource scope, or cross-Project behavior: `docs/architecture/chat-context-resource-model.md` and `docs/architecture/chat-project-framework.md`.
- Workflow, Agent, Stage, Tool, Skill, Prompt, or assembly changes: `docs/architecture/chat-workflow-framework.md` and `docs/architecture/chat-detailed-design.md`.
- Questions about what the product currently does: `docs/architecture/chat-current-architecture.md`, confirmed against implementation and tests.
- Pi contracts or upstream behavior: use the Pi analysis documents named by `docs/architecture/README.md`, then inspect the relevant public Pi interfaces or source.

If documentation and implementation disagree, identify the drift explicitly. Do not rewrite a document merely to legitimize the current code.

## Analyze the change

Before editing, trace scenario → mechanism → architecture/contracts → technical plan → implementation/evidence. Scale detail to risk; do not require a large plan for a small compatible change. State the capability's owner and standard source location. For persistent resources, distinguish Personal, Project, Long-Agent-owned, Workflow-private, and Session/Run configuration using the documented domain contracts.

Trace architecture-sensitive behavior through the actual chain that the user exercises:

```text
Chat Web / NanoClaw Channel or Trigger -> Backend
  -> Workflow or Long Agent lifecycle -> shared Agent assembly -> Pi AgentSession
```

Check the management catalog separately from runtime assembly: discovery, selection, authorization, loading, and execution are different operations. Inspection and execution must resolve the same Agent definition, while a runtime-only capability must not appear as a user-selectable resource.

This repository Skill is development navigation. Editing it or architecture documents does not install the target public Long Agent management Skill into a running Agent; publishing, discovery and resource access require separate implementation and verification.

A new Skill entry can reuse Catalog rendering; a new API enum may require consumer/parser changes. Notifications invalidate read models; they do not replace durable state. Same-Agent work can be concurrent, while writes to the same Session or shared resource require the documented ordering/conflict rules.

## Complete with evidence

Keep the implementation on the existing shared path, update the authoritative document only when the architecture itself changes, and add regression coverage at the boundary that previously failed. For Workflow or Agent assembly changes, verify the real development and production execution paths required by the repository rules; a nearby unit test is not a substitute.

Report the architecture sources consulted, the owner and scope decisions made, and the observable verification result. Update this Skill only when its routing or working method changes—not whenever an architecture detail changes.

Run `pnpm check:architecture` to verify local navigation and the single-source CLI alias. This is structural validation, not proof that an Agent loaded the Skill or that the architecture works. Use a short read-only scenario answer test plus the relevant runtime gates. Keep review evidence in `docs/architecture/reviews/`; do not copy private conversations into Git.

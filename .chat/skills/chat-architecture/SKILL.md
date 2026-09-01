---
name: chat-architecture
description: Navigate Chat's authoritative architecture sources and evaluate architecture impact when changing or diagnosing Projects, Workflows, Agent assembly, Sessions, Memory, configuration, resources, or the Frontend-to-Pi execution chain.
metadata:
  architecture-version: 3
---

# Chat architecture

Use this Skill as an architecture navigator and change-impact workflow for the Chat Project. It is not an architecture specification and must not become a second source of truth.

Do not reproduce large parts of the architecture documents in prompts, plans, or reports. Read the relevant source, cite the exact document, and carry forward only the conclusions needed for the current task.

## Find the authoritative source

Start with `docs/architecture/README.md`, then read only the documents selected by the task:

- New capabilities or changes to Agent responsibilities: `docs/architecture/chat-agent-first-principles.md`.
- Project identity, ownership, Target, resource scope, or cross-Project behavior: `docs/architecture/chat-context-resource-model.md` and `docs/architecture/chat-project-framework.md`.
- Workflow, Agent, Stage, Tool, Skill, Prompt, or assembly changes: `docs/architecture/chat-workflow-framework.md` and `docs/architecture/chat-detailed-design.md`.
- Questions about what the product currently does: `docs/architecture/chat-current-architecture.md`, confirmed against implementation and tests.
- Pi contracts or upstream behavior: use the Pi analysis documents named by `docs/architecture/README.md`, then inspect the relevant public Pi interfaces or source.

If documentation and implementation disagree, identify the drift explicitly. Do not rewrite a document merely to legitimize the current code.

## Analyze the change

Before editing, state the capability's owner and standard source location. For persistent resources, distinguish Personal, Project, Workflow-private, and Session/Run configuration instead of inventing another storage scope.

Trace architecture-sensitive behavior through the actual chain that the user exercises:

```text
Frontend -> Backend -> Workflow -> Agent assembly -> Pi Agent / Pi Coding Agent
```

Check the management catalog separately from runtime assembly: discovery, selection, authorization, loading, and execution are different operations. Inspection and execution must resolve the same Agent definition, while a runtime-only capability must not appear as a user-selectable resource.

## Complete with evidence

Keep the implementation on the existing shared path, update the authoritative document only when the architecture itself changes, and add regression coverage at the boundary that previously failed. For Workflow or Agent assembly changes, verify the real development and production execution paths required by the repository rules; a nearby unit test is not a substitute.

Report the architecture sources consulted, the owner and scope decisions made, and the observable verification result. Update this Skill only when its routing or working method changes—not whenever an architecture detail changes.

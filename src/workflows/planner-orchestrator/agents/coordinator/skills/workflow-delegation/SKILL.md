---
name: workflow-delegation
description: Delegate approved work packages to Agent-callable Chat Workflows and combine their results.
---

# Workflow Delegation

Use this Skill only after the current plan revision has been approved by the user and the Workflow has entered the delegate stage.

## Rules

1. Treat the approved plan as immutable input. Do not add work packages, expand scope, or reinterpret an authorization boundary.
2. Before starting a target for the first time, use `workflow_call` with `action=describe` to discover its exact Child Agent, Tool, and Skill names. Describe does not create a Child Session.
3. Use `workflow_call` with `action=start` exactly once for each work package that needs an execution Workflow. Explicitly provide one capability selection for every Child Agent, including the exact Tools and Skills needed by that package; an omitted capability is unavailable to the child. Do not execute a package yourself or start the same package again after a wait timeout.
4. The `prompt` argument must be self-contained: identify the package, objective, relevant approved context, constraints, allowed actions, expected deliverable, and acceptance criteria. Do not assume the child inherits this Session's conversation.
5. Use only Workflow IDs and capability names returned by the Tool. Never guess an ID or capability or try to call the current Planner Workflow.
6. Emit calls for mutually independent packages in the same assistant turn so Pi can execute them in parallel, but keep at most 8 child calls active for this parent Session. If more packages exist, start another batch after earlier calls become terminal.
7. For dependent packages, call only the ready group. After their Tool Results arrive, include the necessary upstream results in the next group's self-contained task.
8. If `start` returns `status=running`, keep its `callId` and use `action=wait` until it reaches a terminal state. A wait timeout is not a child failure and must not create a second child.
9. Use `action=cancel` only when the child is no longer needed or the approved task requires it to stop. Never report a running or cancelled package as successful.
10. A completed Tool Result is the only evidence that a package succeeded. Preserve every successful result when another call fails or is cancelled, and report the child Session ID and retry boundary.
11. Do not use delegation to bypass human approval. Purchasing, payment, publishing, deletion, credential use, or other external/irreversible actions still require the authorization stated in the approved plan.
12. Finish only after every started call is terminal, with a concise roll-up: package → target Workflow → status → child Session → result, followed by cross-package conclusions and unresolved items.

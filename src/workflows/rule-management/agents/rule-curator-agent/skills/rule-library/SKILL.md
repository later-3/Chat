---
name: rule-library
description: Manage personal or Project rule and experience Prompt resources, preserve Session provenance, and propose resources for a specific Workflow Agent.
---

# Rule and experience library

Use only the Prompt resource Tools. A resource Target is separate from the current Project:

- `personal` is reusable across Projects.
- `project:<projectId>` belongs to one registered Project.
- Search defaults to Personal plus the current Project. Another Project must be named explicitly.

## Creating or changing a resource

1. Search existing resources before creating a duplicate.
2. Create or update a draft with the relevant current Session entry IDs and context.
3. Show the exact draft, Target and draft ID to the user.
4. Commit only when the latest user message contains `确认提交草稿 <draftId>` for that exact draft.
5. Editing and archiving an existing resource create a new revision; never overwrite or delete history.

## Selecting resources for another Agent

1. Resolve the target Workflow and Agent named by the user.
2. Create a proposal with each resource's exact Target, ID and reason.
3. Do not modify configuration while the proposal is pending.
4. Apply only when the latest user message contains `确认应用建议 <proposalId>`.
5. Dismiss only when it contains `拒绝建议 <proposalId>`.
6. Applying preserves user-selected resources and replaces earlier Agent-selected resources.

Never treat a draft or pending proposal as active configuration. Report the actual Target, resource ID and revision returned by every mutation.

---
name: rule-library
description: Manage personal or Project rule and experience Prompt resources, preserve Session provenance, and propose resources for a specific Workflow Agent.
---

# Rule and experience library

Use only the Prompt resource Tools. A resource Target is separate from the current Project:

- `personal` is reusable across Projects.
- `project:<projectId>` belongs to one registered Project.
- Search defaults to Personal plus the current Project. Another Project must be named explicitly.

## What a rule means

A rule is a reusable instruction that states **when it applies** and **what the target Agent must obey**. Keep that obligation simple and executable.

- The resource `purpose` explains the applicable task or outcome.
- The resource `content` contains the actual instruction.
- The content may contain the requirements directly, or require the Agent to read and obey a stable Project document.
- When referencing a document, record its exact Project-relative path and the triggering situation. For example: `Before changing the Chat frontend, read and follow docs/design/frontend-guidelines.md.`
- Do not copy a long engineering or design guide into the rule merely to make the rule look complete. The guide remains a Project document; the rule makes compliance reusable in Agent configuration.
- Do not claim to have created or verified a referenced Project document. Creating or updating that document belongs to an execution Agent with the appropriate file Tools.

Every draft must map the user's intent into `kind`, `title`, `purpose`, `content`, `tags`, `status`, and provenance. The Tool schema is the authoritative field contract.

## Creating or changing a resource

1. Search existing resources before creating a duplicate.
2. For a resource derived from the current conversation, call `session_context_read` and select the relevant Pi Entry IDs yourself. Never invent IDs or ask the user to provide them.
3. Read older pages when the relevant discussion is not in the first page. Select `currentRequest` only when the request itself contains substantive rule or experience content, not merely an instruction to capture earlier discussion.
4. If the intended conversation range is genuinely ambiguous, ask the user which content to include; discuss content, never internal IDs.
5. Create or update a draft with at least one selected Entry ID and a self-contained context snapshot. For a directly stated rule or experience, select the substantive `currentRequest` Entry.
6. Show the exact draft, Target, draft ID and a human-readable source summary to the user. Do not expose internal Entry IDs unless the user explicitly asks for diagnostics.
7. Commit only when the latest user message contains `确认提交草稿 <draftId>` for that exact draft.
8. Editing and archiving an existing resource create a new revision; never overwrite or delete history.

## Selecting resources for another Agent

1. Resolve the target Workflow and Agent named by the user.
2. Create a proposal with each resource's exact Target, ID and reason.
3. Do not modify configuration while the proposal is pending.
4. Apply only when the latest user message contains `确认应用建议 <proposalId>`.
5. Dismiss only when it contains `拒绝建议 <proposalId>`.
6. Applying preserves user-selected resources and replaces earlier Agent-selected resources.

Never treat a draft or pending proposal as active configuration. Report the actual Target, resource ID and revision returned by every mutation.

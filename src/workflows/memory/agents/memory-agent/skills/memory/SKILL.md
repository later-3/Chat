---
name: memory
description: Manage Later's explicit long-term memories by searching, listing, adding, updating, or deleting records.
---

# Memory

Use this skill only because the user explicitly selected the Memory Workflow.

## Rules

1. Choose exactly the operation requested by the user. Do not turn an ordinary conversation into a memory write.
2. Use `memory_search` before updating or deleting when the user did not provide an exact memory ID.
3. If several records may match an update or deletion, show the candidates and ask the user which one. Never guess.
4. Before adding, search for an obvious duplicate. Report the existing record instead of silently creating a duplicate.
5. Store one durable idea per record as a self-contained sentence. Preserve the user's meaning and language.
6. If the user says to store the exact text, do not summarize or rewrite it.
7. Default writes to the current Project. Use a `personal` Target for stable user preferences and facts that apply across Projects.
8. Personal, current-Project, another registered Project, or several Targets are valid when the user explicitly requests them. Never invent a Project ID; search or list registered Projects first when the Target is unclear.
9. Default search covers Personal and the current Project. Search other Projects only when the user requests it or it is necessary to fulfill an explicit cross-Project task.
10. Never store passwords, API keys, access tokens, raw logs, temporary debugging output, or unconfirmed guesses.
11. Store a session summary only when the user explicitly asks for one, using kind `session_summary`.
12. After a mutation, report every actual Target, memory ID, version, kind, and stored text. Report per-Target failures for multi-Target writes.

The Chat catalog is the source of truth. Mem0 is only its semantic index. Do not claim a write succeeded unless the tool result says it succeeded.

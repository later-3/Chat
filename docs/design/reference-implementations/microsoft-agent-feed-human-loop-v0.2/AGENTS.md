# Microsoft Agent Feed Human Loop v0.2 Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Approved prototype decisions

1. This prototype studies Microsoft Power Apps Agent Feed as a **multi-Agent supervision surface**, not as a social activity feed.
2. Match the current Fluent side-pane/full-screen anatomy and density while using Chat-specific multi-project fixture content.
3. Cover four typed intervention paths: assistance, structured data acceptance, revision-bound decision, and `outcome_unknown` reconciliation.
4. A feed item is always a projection of a Project, Run, Decision, Evidence or Update object. The related record owns the durable fact.
5. Never expose a generic Retry for unknown external side effects. Reconciliation is a separate command.
6. Informational review items have no fake approval action; unavailable shell controls are disabled with a reason.
7. Desktop supports side-pane and focused full-screen supervision. Mobile starts from the feed list and uses a full-screen detail with position-preserving Back.
8. Generated Agent portraits are own-work reference assets. Official Microsoft screenshots remain external, link-only evidence and are not committed.
9. v0.2 extends the adapted Fluent / Power Apps reference without changing the production Chat UI or replacing the original v0.1 freeze.
10. Request changes is structured task feedback: free text, typed requirements, Evidence selection, scope, and optional material filename. It is not a general chat surface.
11. Decision approval first commits a revision/hash/scope/Evidence-bound Decision fact; only a later state resumes the waiting Product Run.
12. Assistance, Project Update candidates, outcome_unknown reconciliation, and Agent delegation each have separate commands and terminal states. There is no generic Complete, Retry, or Undo.
13. Agent-to-Agent coordination events show participant visibility and are never labeled as Product facts. Related records own the durable state.
14. Desktop retains Fluent full-screen three-column supervision. 391×844 mobile uses Feed → full-screen detail → record and preserves typed object identity on Back.

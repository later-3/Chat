# Prototype Instructions

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

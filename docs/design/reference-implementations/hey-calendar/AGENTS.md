# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Approved prototype direction

- This is a private reference-study implementation of current HEY Calendar, not Chat production UI.
- The selected visual truths are the official Day, Week, Year, Event composer, and email-to-event screenshots captured on 2026-08-09.
- The primary interaction paths are `Day → Week → Year → Day` and `source email → event candidate → schedule conflict check → adjust time → save`.
- Calendar source owns event color; Day/Week/Year are projections over the same Event objects.
- Event, Sometime task, Habit, Journal, and day decoration stay separate object types even when they share a date.
- The reference may preserve HEY's playful blue/violet shell and continuous time layouts. Chat translation must separately document Take / Adapt / Refuse and must not inherit arbitrary decoration, emoji semantics, or calendar ownership of Work/Project state.
- All visible controls in core paths must navigate, update shared in-memory state, open an actionable surface, or explain why they are disabled. No silent no-op controls.

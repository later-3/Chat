# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Approved prototype direction

- This is a private reference-study implementation of current Linear, not Chat production UI.
- The selected visual truths are Linear's current official Peek, Project Update, health selector, and Pulse images captured on 2026-08-09.
- The primary interaction paths are `Issue List → Peek → adjacent Issue → close/full detail` and `Project Overview → update candidate → human publish → history/Pulse`.
- Linear's 2026 Agent-assisted Project Update is in scope because it directly proves a candidate-draft pattern: the Agent gathers recent context and drafts, but a person refines and publishes.
- Project health is authored judgment and must never be computed from issue completion.
- The prototype may faithfully reproduce Linear's dark density for study. Chat translation must separately document Take / Adapt / Refuse and must not inherit Linear's black-grey skin, shortcut-only discoverability, or Popular ranking as defaults.
- All visible controls in the core paths must navigate, update the same in-memory object, open an actionable surface, or explain why they are disabled. No silent no-op controls.

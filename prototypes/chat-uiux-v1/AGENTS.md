# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Approved direction for this prototype

- Preserve the approved personal-home information architecture, but make the product feel like a lively personal creation and collaboration space instead of a restrained office dashboard.
- Use Material 3 Expressive as an influence for shape, color, motion, and hierarchy; do not imitate a Google product literally.
- Avoid purple, AI gradients, cold gray administration styling, dense border grids, and important text below 14px.
- Use teal, coral, warm yellow, sky blue, and warm neutral surfaces. Color communicates area and state, not productivity scores.
- Keep Personal Home, Continuous Chat, Workflow Run, and Approval inside one App Shell.
- The right-side Workbench is a view container, not a Canvas. Workflow nodes and route facts must match public product/runtime facts and never expose hidden reasoning.
- Interactions must be demonstrable: rail navigation, activity-day selection, explicit context selection, Workbench open/close, node inspection, approval editing, save, continue, and return to chat.
- Treat the current prototype as visual baseline v1. Improve it incrementally instead of restarting the visual direction.
- Add emotional value first through four bounded patterns: state-grounded home greetings, meaningful action feedback, public AI run-state motion, and a living collaboration calendar whose visual states remain traceable to product facts.
- Vary expression by surface: Home, Calendar, and Idea Garden may be lively; Continuous Chat stays warm and calm; Workflow, Approval, Trace, and settings stay precise and restrained.
- Defer theme editors, custom illustration systems, complex animation engines, gamification, and broad rebranding until their user value and maintenance cost are separately approved.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

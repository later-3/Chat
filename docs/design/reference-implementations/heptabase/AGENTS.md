# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Approved prototype direction

- This is a private reference-study implementation of current Heptabase, not Chat production UI.
- The selected visual truths are the official 2026 Whiteboard + Card detail and Whiteboard + PDF + AI Chat screenshots captured from `heptabase.com` on 2026-08-09. External screenshots are local-only evidence and stay ignored by Git.
- The primary paths are `Card Library → Card → all Whiteboard placements → focus location → predictable back` and `Whiteboard → explicit AI context → cited candidate → save as a new Card`.
- Card identity is owned by the shared Card Library. Whiteboards own placements and local spatial annotations only; moving or removing a placement never duplicates or deletes the Card.
- Collaboration is explicit per Whiteboard. A collaborator sees only shared boards and cards explicitly placed on them; the prototype must not imply account-wide visibility.
- The mobile experience rewrites spatial relationships into an ordered outline with explicit back navigation; it must not shrink the desktop canvas into an unreadable miniature.
- All visible controls in the core paths must act on the shared in-memory model, open an actionable surface, or be disabled with a reason. No silent no-op controls.

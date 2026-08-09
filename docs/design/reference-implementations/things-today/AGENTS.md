# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Approved prototype direction

- The user approved the Basecamp reference implementation with “像了”; Things must now meet the same high-fidelity gate before any Chat translation.
- This is a private reference-study implementation of Things Today, not Chat production UI.
- `evidence/source-things-today.jpg` is the only visual truth for the default Today viewport.
- `evidence/source-things-todo-open.png`, `evidence/source-things-when.png`, and `evidence/source-things-quick-find.png` are supporting truths for interactive states.
- Preserve Things' macOS window, two organization axes, whitespace, row rhythm, source subtitles, in-place detail, and nearby popovers.
- Do not reuse the rejected UL1 shell, Chat fixtures, Chat themes, cards, badges, or product copy.
- The primary flow is `Today → To-do detail → When → This Evening / Tomorrow → complete or reschedule`.

## Full-interaction acceptance

- The reference must cover the complete visible Things navigation model, not only Today: Inbox, Today, Upcoming, Anytime, Someday, Logbook, Areas, Projects, Headings, Quick Find special lists, task detail, and the bottom toolbar.
- Research official Things behavior and visual evidence before changing the prototype. Do not use a generic project screen as a placeholder for built-in lists with different responsibilities.
- Every control that looks interactive must either perform the expected front-end interaction or be visibly disabled with an explanation. Silent no-op buttons are not acceptable.
- Keep this a front-end reference study: in-memory state and realistic feedback are sufficient; do not add sync, accounts, notifications, or a backend.
- Preserve object identity across projections. Scheduling or moving a to-do changes its attention/parent fields; it must not create a duplicate object or misuse `completed` as a hiding flag.

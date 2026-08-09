# Things Full Interaction Reference — Design QA

- Date: 2026-08-09
- Prototype: `docs/design/reference-implementations/things-today`
- Scope: Things macOS six system lists, Areas, Projects, Headings, hidden lists, task detail, and transient interaction surfaces
- Final result: `passed`

## Visual truth

The implementation was checked against the supplied Today reference pack and official Things support visuals for Inbox, Upcoming, Anytime, Someday, Projects, and Headings.

Primary sources:

1. Local Today/detail/When/Quick Find reference pack under `/Users/xulater/.codex/visualizations/2026/08/08/019fdf03-85ed-7cb1-9f70-bb5939fda78f/chat-ui-reference-pack/things/`.
2. Things system-list documentation: `https://culturedcode.com/things/support/articles/4001304/`.
3. Things dates and system-list visuals: `https://culturedcode.com/things/support/articles/2803579/`.
4. Things Headings visual and behavior: `https://culturedcode.com/things/support/articles/2803577/`.
5. Things Areas and Projects behavior: `https://culturedcode.com/things/support/articles/6378414/`.

Browser-rendered v0.2 evidence is kept under `evidence/interaction-audit/` and ignored by Git because the comparison sources are copyrighted research material:

- `implementation-today-final-v3-window.jpg`
- `implementation-inbox-final-v3-window.jpg`
- `implementation-upcoming-final-v3-window.jpg`
- `implementation-anytime-final-v3-window.jpg`
- `implementation-someday-final-v3-window.jpg`
- `implementation-logbook-final-v3-window.jpg`
- `implementation-project-final-v3-window.jpg`

## Viewport and normalization

- Browser: Codex in-app browser.
- Browser CSS viewport during pixel comparison: `3200 × 2844`, `devicePixelRatio: 0.75`.
- Things window: `1188 × 1028` CSS px at scale `1`.
- Comparison crop: `1188 × 1028`, taken from the exact application-window bounds.
- Today state was compared with the supplied source at identical `1188 × 1028` dimensions.
- Official list screenshots use different outer crops, so Inbox/Upcoming/Anytime/Someday comparisons use the Things content window, hierarchy, density, and state anatomy rather than background pixels outside the app.

## Full-view comparison

No actionable P0/P1/P2 visual difference remains.

1. Today preserves the source's `296 / 892` sidebar-content split, title and calendar position, row cadence, source subtitles, evening separation, and fixed toolbar.
2. Inbox preserves the title, tag filtering row, compact capture list, expandable task detail, deadline treatment, and moved-out confirmation behavior.
3. Upcoming uses date groups, calendar-event context, scheduled to-dos, deadline-only to-dos, and future Projects without collapsing them into a generic Project page.
4. Anytime groups the same live task objects by Area/Project and retains Today stars, tags, deadline metadata, and parent navigation.
5. Someday groups someday to-dos by Area and renders someday Projects separately.
6. Project pages preserve editable notes, inherited/direct tags, filters, ordered Headings, section menus, deadline chips, and same-page task expansion.

Residual P3 differences:

1. Font Awesome glyphs have slightly different optical weight from Things' proprietary symbols.
2. Browser system-font rasterization differs slightly from the native macOS screenshots.
3. Some official screenshots show a different private database density; the prototype keeps the approved coherent fixture instead of fabricating those private records.

## Interaction coverage

The in-memory object model keeps filing, scheduling, deadline, status, Inbox capture, Heading membership, and tags as independent fields. The same task id is projected into every applicable view without duplication.

Browser-verified paths:

1. Navigated all six system lists and confirmed each has its own semantics and layout.
2. Expanded a to-do and edited title, notes, and checklist items.
3. Opened independent When, Move, Tags, and Deadline dialogs; Escape closes only the top layer and keeps task detail open.
4. Scheduled a task to Tomorrow and confirmed it moved from Today to Upcoming.
5. Moved a task to another Project and used Undo; scheduling stayed unchanged.
6. Added a tag, filtered by it, and confirmed unrelated tasks were excluded.
7. Set a deadline and opened the hidden Deadlines list through Quick Find.
8. Completed a task, opened Logbook, and reopened the same task.
9. Moved an Inbox task to an Area and confirmed the Inbox moved-out acknowledgement path.
10. Created a Heading, opened its menu, and exposed Convert to Project.
11. Created a new Project through New List and changed list settings.
12. Created a to-do from Upcoming and confirmed the page-specific Tomorrow default.
13. Used Quick Find Continue Search plus Arrow/Enter to open a hidden list.
14. Opened Area Tags and Rename dialogs.
15. Exercised the new-window control; when the in-app browser blocked the popup, the prototype gave explicit feedback instead of silently doing nothing.

Accessibility and control sweep:

- All native buttons declare a click behavior or an explicit disabled state.
- The seven transient interaction families have distinct accessible dialog names.
- Icon-only controls expose accessible names.
- Keyboard direct typing does not steal Space from focused buttons.
- Quick Find restores focus, clears its query, and supports ArrowUp/ArrowDown/Enter.
- Toasts use `role="status"`; Undo is bound to the exact action snapshot.

## Automated verification

- `npm test`: passed.
- Interaction contracts: `17/17` passed.
- Sites worker/package tests: `4/4` passed.
- `npm run build`: passed; Vite emitted the production client and Sites package.

The interaction contracts cover six list projections, cross-view object identity, Today/Anytime and deadline/Upcoming overlap, project lifecycle fixtures, all When branches, Move destinations, complete/cancel/restore, five hidden lists, Quick Find object types, page-specific new-task defaults, silent-button sweep, and accessible dialog naming.

## Comparison history

### v0.1

The first implementation matched Today, task detail, When, and Quick Find, but non-Today sidebar destinations were generic placeholders and several visible controls were silent.

### v0.2 iteration 1

- `[P1]` Filing and scheduling were conflated; Tomorrow/Someday/Clear incorrectly used completion to hide tasks.
- `[P1]` Move reused the When dialog.
- `[P1]` six system lists did not own distinct projections.
- `[P2]` Today gained an unreferenced tag-filter row and checklist indicators on every checklist-bearing task.

Fix: introduced the normalized Things model, distinct list projections and dialogs, independent task fields, Area/Project/Heading views, and complete controller actions.

### v0.2 final

- Removed the unreferenced Today tag-filter row.
- Restored checklist markers to the source-specific fixture flag.
- Recompared Today at native dimensions and Inbox/Upcoming/Anytime/Someday/Project against official visuals.
- Ran the full browser interaction sweep and `21/21` automated checks.

No actionable P0/P1/P2 issue remains.

final result: passed

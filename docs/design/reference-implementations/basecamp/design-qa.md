# Basecamp reference implementation · Design QA

## Comparison target

- Source visual truth: `evidence/source-basecamp-home.png` (`2266 × 1282`), copied from the user-provided Basecamp Home screenshot and ignored by Git.
- Normalized source: `evidence/source-basecamp-home-normalized.png` (`1707 × 960`). The source was proportionally downsampled and center-cropped by 6 px vertically so it matched the browser capture dimensions.
- Final Home implementation: `evidence/implementation-home-final-v2.png` (`1707 × 960`).
- Browser CSS viewport: `1707 × 960`; reported `devicePixelRatio: 1.5`; screenshot API output is `1707 × 960`, so source and implementation are compared at equal output pixels.
- State: `?view=home`, warm light background, search empty, default stars.
- Full-view comparison: `evidence/home-comparison-final-v2.png`.
- Focused comparison: `evidence/home-focus-comparison-final-v2.png`, covering account mark, jump search, all 8 project cards, avatars, chips, stars, and card copy.
- Supporting official interaction captures: `evidence/official-basecamp-homepage-current.png`, `evidence/official-basecamp-todos.png`, and `evidence/official-basecamp-todo-detail.png`.
- Final flow captures: `evidence/implementation-project-final.png`, `evidence/implementation-todos-final.png`, and `evidence/implementation-todo-final.png`.

## Findings

No actionable P0/P1/P2 mismatch remains in the approved scope.

### Fonts and typography

- The implementation uses the macOS/system sans stack and matches the source hierarchy, weight contrast, line height, and primary wrapping.
- Card names, secondary notes, global navigation, activity copy, and footer labels are visually aligned in the focused comparison.
- P3: the exact proprietary/source font build is not bundled; small glyph-width and antialiasing differences remain.

### Spacing and layout rhythm

- The final Home central panel matches the normalized source at `x=547–1162`.
- The five scope regions align: global navigation, left account actions, central project destinations, right activity projection, and bottom personal bar.
- Search, card rows, card heights, avatar baselines, star positions, and chip baselines align in the focused comparison.
- Border radii, hairlines, background separation, and the low-elevation card treatment match the source character.

### Colors and visual tokens

- The warm page background, slightly darker central panel, white project cards, blue links, pale-blue access chips, yellow stars, and activity-type colors map to the source.
- State color is not used as the sole label; project access, activity copy, and actions remain textual.

### Image quality and asset fidelity

- Basecamp's official mask and official Project tool thumbnails are used as source assets rather than hand-drawn substitutes.
- The Enormicom account mark was generated as a raster asset with the built-in ImageGen workflow, chroma-keyed, locally de-keyed, inspected, and tightly cropped.
- Local portrait assets preserve the source's photographic avatar density, circular crops, overlap, and presence cues.
- P3: portrait identities and the Enormicom mark are study-safe close variants rather than exact copies of the screenshot subjects.

### Copy and content

- The Home screen reproduces the visible project names, notes, activity events, personal navigation, account actions, and search prompt.
- Project Room, Project Tasks, and task detail use the official current Basecamp demo's object hierarchy and representative copy.

## Comparison history

### Pass 1 · blocked

- Evidence: `evidence/implementation-home-pass1.png` and `evidence/home-comparison-pass1.png`.
- Findings: central panel was too wide and too far left; the desktop density was larger than the normalized source; the generated account mark had excess transparent padding.
- Fixes: normalized the source to the actual browser capture, tightened the account mark, and recalculated the three-column shell from the source coordinates.

### Pass 2 · blocked

- Evidence: `evidence/implementation-home-pass2.png` and `evidence/home-comparison-pass2.png`.
- Findings: source central panel was `x=547–1162`, while the implementation was `x=499–1058`; activity and account regions therefore entered the wrong scope positions.
- Fixes: changed the shell tracks to `358px / 616px / 356px` with `40px` gaps, placing the central panel at the source coordinates.

### Pass 3 · blocked

- Evidence: `evidence/implementation-home-pass3.png` and `evidence/home-comparison-pass3.png`.
- Findings: central panel and activity coordinates aligned, but the full view still showed compressed project-card rhythm.
- Fixes: opened a focused central-board comparison before accepting the pass.

### Pass 4 · blocked

- Evidence: `evidence/implementation-home-final.png` and `evidence/home-focus-comparison-final.png`.
- Findings: focused comparison confirmed project cards were too short, the account mark was too small, and card typography was too quiet.
- Fixes: increased the account mark to `82px`, search height to `54px`, card height to `146px`, card radius to `12px`, and restored source-like name, note, chip, star, and avatar sizing.

### Final pass · passed

- Evidence: `evidence/implementation-home-final-v2.png`, `evidence/home-comparison-final-v2.png`, and `evidence/home-focus-comparison-final-v2.png`.
- Result: no actionable P0/P1/P2 visual mismatch remains. Residual font rasterization, avatar identity, and study-safe account-mark differences are P3.

## Primary interactions tested

1. Search / Jump filters 8 projects down to the matching project and restores the list.
2. Project star toggles `aria-pressed` from `true` to `false` and back.
3. Background droplet cycles the environment theme without changing project facts.
4. `Shift + J` focuses Search / Jump.
5. `Home → Enormicom HQ → Project Tasks → Run project kickoff and define scope` reaches the correct deep-link state.
6. Mark as complete changes the visible action to `Completed`.
7. Two in-product Back actions restore Project Tasks and Project Room; browser Back then restores Home.
8. Browser console check returned zero warnings or errors.

## Implementation checklist

- [x] Source and implementation captured at equal output dimensions.
- [x] Full-view and focused-region comparisons inspected together.
- [x] P0/P1/P2 differences fixed and re-captured.
- [x] Core navigation, filtering, star, theme, completion, keyboard, and return paths tested.
- [x] Final browser console check clean.

## Follow-up polish

- P3: replace the study-safe Enormicom mark and portrait set only if exact licensed assets become available.
- P3: test the exact Basecamp font build only if it can be legally and technically sourced for this private reference specimen.

final result: passed

## User acceptance

- Date: 2026-08-09
- Feedback: “像了”
- Acceptance result: passed

---

## v0.2 · UI and full-interaction pass

### Evidence

- Figma audit and acceptance board: [Basecamp Reference v0.2 — UI & Interaction Audit](https://www.figma.com/design/9dcDDPleuMKECmq4NzQYPk), section `4:2`.
- Final editable Home capture in the same Figma file: node `8:6`.
- Same-size browser comparisons inspected together during the final pass:
  - `/tmp/basecamp-home-comparison-v02.png`
  - `/tmp/basecamp-project-comparison-v02.png`
  - `/tmp/basecamp-tasks-comparison-v02.png`
  - `/tmp/basecamp-detail-comparison-v02.png`
- Final standalone task surface: `/tmp/basecamp-tasks-default-v02.png`.

### Visual findings

1. Home retains the v0.1 approved five-scope layout, card dimensions, search position, account mark, warm background, typography hierarchy, stars, avatars, access chips, and fixed My bar.
2. Project Room keeps the approved dark tool-grid character while changing every tool hint from a misleading `Preview` to the actionable `Open` state.
3. Project Tasks now uses the same `1080px` content width as Project Room, with a `16px` heading/content separation, a consistent divider, `30px` between lists, and `12px` between list copy and its first task row.
4. Todo detail stays at a readable `1000px` measure. Title, assignee, date, notes, attachment, subtasks, and comments remain visually ordered; editing controls are quiet until hover/focus or explicit activation.
5. Dialogs, popovers, inline composers, filters, empty states, and toasts share the same dark surface, border, radius, focus ring, and action hierarchy.
6. No actionable P0/P1/P2 visual mismatch remains in the v0.2 scope. Exact source font rasterization and study-safe portraits remain P3.

### Interaction findings

1. Eight Home project cards open eight distinct Project identities; stars share state between Home and Project Room.
2. Activity, Calendar, Reports, Everything, My Tasks, My Events, Do Today, Bookmarks, Notes, and New for you open distinct aggregate projections.
3. Make project, add folder, invite, Adminland, Support, and external-link preview use named dialogs with real form/settings state or an explicit disabled reason.
4. Search / Jump covers Project, Person, Page, and To-do with Arrow Up/Down, Enter, Escape, and direct object routing.
5. Message Board, Docs & Files, Project Tasks, Chat, Schedule, and Workflow all open and expose a working primary creation action.
6. Project Tasks supports View as, status/owner filters, bookmark, Hill update/history, add to-do, complete/reopen, and distinct detail routing.
7. Todo detail shares the same object as the list: complete/reopen, bookmark, title, owner, date, notes, subtask, and comment changes project back without duplication.
8. Browser Back/Forward and in-product Back restore Project → Tool → Item scope; the mobile Basecamp mark has an explicit accessible name.

### Responsive and accessibility checks

| CSS viewport | Result |
|---|---|
| `1220px` | `980px` tool content, no horizontal overflow |
| `880px` | `700px` single-column content, no horizontal overflow |
| `374px × 812px` | `331px` content, no horizontal overflow, minimum visible button height `44px` |

- Five representative routes (Home, Reports, Project, Tasks, Todo detail) had zero unnamed visible buttons at the mobile breakpoint.
- Dialog and Reports shell remained inside the `374px` viewport.
- Browser console returned zero warnings or errors from the application.

### Verification

- `npm test`: 17/17 passed.
- `npm run build`: passed and emitted the Sites client/server contract.
- Browser main path passed: Home → distinct Project → all six tools → create/complete/filter task → Todo detail → subtask/comment/bookmark → Back with shared state.

v0.2 final result: passed

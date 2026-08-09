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

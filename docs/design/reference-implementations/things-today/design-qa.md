# Things Today Reference — Design QA

- Date: 2026-08-09
- Prototype: `docs/design/reference-implementations/things-today`
- Target state: Things macOS `Today` with supporting detail, When, and Quick Find states
- Final result: `passed`

## Visual truth and rendered evidence

Source visual truth:

1. `/Users/xulater/.codex/visualizations/2026/08/08/019fdf03-85ed-7cb1-9f70-bb5939fda78f/chat-ui-reference-pack/things/01-today-current.jpg`
2. `/Users/xulater/.codex/visualizations/2026/08/08/019fdf03-85ed-7cb1-9f70-bb5939fda78f/chat-ui-reference-pack/things/06-todo-open-mac.png`
3. `/Users/xulater/.codex/visualizations/2026/08/08/019fdf03-85ed-7cb1-9f70-bb5939fda78f/chat-ui-reference-pack/things/09-when-popover-mac.png`
4. `/Users/xulater/.codex/visualizations/2026/08/08/019fdf03-85ed-7cb1-9f70-bb5939fda78f/chat-ui-reference-pack/things/08-quick-find-mac.png`

Browser-rendered implementation evidence (kept local and ignored by Git because the source images are copyrighted research material):

1. `evidence/implementation-default-large-qa.png`
2. `evidence/implementation-window-large-qa.png`
3. `evidence/default-window-native-comparison-qa.png`
4. `evidence/detail-comparison-qa.png`
5. `evidence/when-comparison-qa.png`
6. `evidence/quick-find-comparison-qa.png`

## Viewport and normalization

- Browser: Codex in-app browser.
- CSS viewport: `2400 × 2133`.
- `devicePixelRatio`: `0.75`.
- Browser screenshot pixels: `3200 × 2844`.
- Implementation window: `1188 × 1028` CSS px at scale `1`, located at `x=606`, `y=552.67`.
- Default source crop: `1188 × 1028` from source `1340 × 1181`, crop origin `x=76`, `y=52`.
- Default implementation crop: `1188 × 1028` from the browser screenshot, crop origin `x=606`, `y=553`.
- Density normalization: none for the final default comparison; both source and implementation are compared at native `1188 × 1028` pixels.
- State: default Today view, same task fixture, same sidebar hierarchy, calendar block, daytime list, This Evening section, and bottom toolbar.

## Full-view comparison

Evidence: `evidence/default-window-native-comparison-qa.png` places the source on the left and the implementation on the right at identical dimensions.

No actionable P0/P1/P2 differences remain. The implementation preserves the source's macOS window proportions, `296 / 892` sidebar-content split, Today title position, calendar block size, task-row density, Project/Area subtitles, low-weight This Evening section, and fixed bottom action bar.

Residual P3 differences:

1. Font Awesome's project and toolbar glyphs have slightly different optical weight from Things' proprietary icons.
2. The implementation's This Evening anchor is roughly 8–10 px lower than the source, without changing the above-the-fold hierarchy or hiding content.
3. System-font rasterization differs slightly between the official screenshot and browser capture.

These are accepted for a private interaction reference prototype and do not block the high-fidelity gate.

## Focused comparisons

### To-do detail

- Evidence: `evidence/detail-comparison-qa.png`.
- Result: the white raised sheet, checkbox-title-note anatomy, checklist dividers, When control, Tags, and Deadline positions match the official pattern.
- The fixture copy and checklist length differ intentionally; the interaction anatomy and density are the comparison target.

### When / natural-language date

- Evidence: `evidence/when-comparison-qa.png`.
- Result: dark popover surface, input treatment, selected blue row, pink calendar icons, suggestion hierarchy, and right-aligned date hints match the source.

### Quick Find

- Evidence: `evidence/quick-find-comparison-qa.png`.
- Result: centered floating palette, search field, highlighted first result, mixed Project/To-do results, metadata alignment, and Continue Search row match the source.
- Result count differs because the prototype uses the approved Today fixture rather than the source screenshot's complete private database.

## Required fidelity surfaces

1. **Fonts and typography** — system font stack, hierarchy, weights, line height, subtitles, truncation, and numeric alignment match the source closely. No broken wrapping or cramped text was observed.
2. **Spacing and layout rhythm** — frame, sidebar width, main padding, calendar block, row cadence, Area grouping, This Evening separation, radius, borders, and elevation match. No overlap or hidden persistent control remains.
3. **Colors and visual tokens** — neutral backgrounds, hairlines, Today yellow, calendar colors, deadline pink, selected gray, and blue focus states visually align with the source and remain legible.
4. **Image and asset fidelity** — the reference surface contains no required photographic or illustrative asset. Standard UI symbols use one consistent Font Awesome family; no placeholder image, handcrafted SVG, CSS illustration, gradient, or emoji substitute was introduced.
5. **Copy and content** — fixture content is coherent across Today, Project, detail, When, and Quick Find. Parent Project/Area identity remains visible wherever the source pattern requires it.

## Interaction and accessibility verification

Browser-tested paths:

1. Open Today To-do in place and close it.
2. Open When and type `in 3`; receive `in 3 days / weeks / months` suggestions.
3. Move the selected task to This Evening; the same object moves below the This Evening heading and a local Undo action appears.
4. Move the task to Tomorrow and Undo; the row disappears from Today and is restored without duplication.
5. Complete a task and Undo.
6. Open Quick Find from the toolbar, search `to`, and jump back to Today.
7. Start Quick Find by directly typing a character while no input is focused.
8. Create `Review prototype notes` with Magic Plus; it appears at the top of Today with an Inbox source.
9. Navigate to Prepare Presentation and render the Slides and notes, Preparation, and Facilities sections.

Accessibility checks:

- Interactive controls are semantic buttons or labeled text inputs.
- Icon-only controls expose accessible names.
- Keyboard typing opens Quick Find; Escape closes transient UI.
- Native focus treatment remains available, and selected states are not communicated by color alone.
- Browser console errors checked after the complete flow: `0`.

## Comparison history

### Iteration 1

- Earlier evidence: `evidence/default-window-comparison-v1.png` (local research evidence, ignored by Git).
- Findings: `[P2]` sidebar groups were vertically compressed; `[P2]` This Evening began too high and weakened the daytime/evening separation.
- Fix: restored the larger gap before Today, increased Area grouping rhythm, and moved the evening section lower while preserving the fixed toolbar.

### Iteration 2

- Earlier evidence: `evidence/default-window-comparison-v2.png` and `evidence/default-window-comparison-v3.png` (local research evidence, ignored by Git).
- Findings: remaining `[P2]` drift in sidebar cadence and This Evening position.
- Fix: aligned navigation row spacing, content padding, task rhythm, and the final evening anchor to the official screenshot.

### Final verification

- Post-fix evidence: `evidence/default-window-native-comparison-qa.png`, plus the three focused comparison images.
- Result: prior P2 findings are resolved. No actionable P0/P1/P2 finding remains.

## Build and packaging checks

- `npm run build`: passed.
- `npm run test:sites`: passed, `4/4` tests.
- Required packaged files were emitted under `dist/client`, `dist/server`, and `dist/.openai`.

## Follow-up polish

Only the three P3 fidelity differences listed above remain. They should be reconsidered only if the user requests a tighter Things clone; they do not justify changing the approved interaction reference before the Chat translation stage.

final result: passed

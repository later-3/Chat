# Linear reference implementation · Design QA

## Comparison target

- Peek source visual truth: `evidence/source-linear-peek.png` (`2880 × 1736`), Linear official Peek screenshot.
- Peek normalized source: `1920 × 1157`; source downsampled to the browser screenshot output dimensions.
- Peek implementation: `evidence/implementation-peek-final.png` (`1920 × 1157`).
- Peek full-view comparison: `evidence/comparison-peek-final.png` (`3840 × 1157`).
- Project Update source visual truth: `evidence/source-linear-update-health.png` (`2880 × 750`), Linear official health-selection composer screenshot.
- Project Update focused comparison: `evidence/comparison-update-composer-final.png` (`3840 × 500`), equal-size source and implementation composer-top regions.
- Desktop CSS viewports: Peek `1440 × 868`; Project Update `1440 × 753`. The browser reported `devicePixelRatio: 0.75`, while its screenshot API emitted `1920 × 1157` and `1920 × 1004`; comparisons therefore normalize by actual output pixels, not the reported density scalar.
- Mobile CSS viewport: `391 × 844`; browser output `520 × 1125`.
- States: selected Issue + open Peek; Atlas Project Overview + Agent candidate composer; mobile list, Peek, and composer.

## Findings

No actionable P0/P1/P2 mismatch remains in the approved reference-study scope.

### Fonts and typography

- The system sans stack preserves Linear's compact product hierarchy: 12px scan text, restrained 16–18px section headings, and a 27px Peek title.
- Issue keys, metadata, body text, labels, control copy, and narrative wrapping remain legible at desktop and mobile widths.
- P3: Linear's exact font build and rasterization are not bundled, so glyph width and antialiasing vary slightly from the official captures.

### Spacing and layout rhythm

- Final Peek measures `1004 × 510 CSS px`, centered over the post-sidebar workspace; the official source's wide temporary-reading proportion is restored.
- List rows, column headers, section groups, Project Overview tracks, Update cards, composer sections, and history entries share a compact 4/8px-derived rhythm.
- Composer header and footer are sticky inside its bounded scroller, keeping Close, Discard, and Publish visible at `1440 × 753` and `391 × 844`.
- At `391 × 844`, body `scrollWidth` equals `clientWidth` (`391`); persistent mobile navigation and the bottom-sheet Peek remain reachable.

### Colors and visual tokens

- Near-black workspace surfaces, low-contrast hairlines, violet focus/accent, and green/amber/red health semantics match the official dark reference character.
- Health and status never rely on color alone: each state includes icon and text.
- Disabled controls are visually quieter and carry an explanatory title; focus-visible rings remain distinct from selected state.

### Image quality and asset fidelity

- The reference screens contain no required photographic or illustrative assets.
- Product icons use the Phosphor icon package consistently instead of handcrafted SVG, emoji, CSS drawings, or text-symbol substitutes.
- P3: study fixture avatars use labeled initial fallbacks because no licensed portrait set is required by the selected source states.

### Copy and content

- Copy stands alone as a plausible product workspace: issue titles, descriptions, project goals, milestones, source provenance, health narrative, comments, and feed labels agree across views.
- Candidate copy explicitly says `not published`; automated observations are visibly separated from the lead's narrative.
- Scope-boundary controls say why they are unavailable instead of silently pretending to work.

### Interaction and accessibility

- `Space`, press-and-hold Space, `↑ / ↓`, `Esc`, visible Peek actions, full-detail navigation, browser Back, and focus restoration were exercised in the in-app browser.
- Dialogs have names and modal semantics; inputs and selects have accessible names; comment and publish actions expose disabled prerequisites.
- Browser console check returned zero page errors. A browser-client telemetry timeout was external to the page and did not appear in page logs.

## Comparison history

### Pass 1 · blocked

- Evidence: `evidence/implementation-peek-pass1.png` and `evidence/comparison-peek-pass1.png`.
- Finding: Peek was `730 × 391 CSS px`, materially narrower and shorter than the official source; the metadata read as compact pills rather than a temporary reading surface.
- Fix: increased the Peek to `1004 × 510`, restored source-like horizontal breathing room, removed pill borders, and increased title/body rhythm.

### Pass 2 · passed for Peek

- Evidence: `evidence/implementation-peek-final.png` and `evidence/comparison-peek-final.png`.
- Result: object scale, overlay proportion, information hierarchy, typography, spacing, palette, and source-like metadata density have no remaining P0/P1/P2 drift. The interaction footer is an intentional study addition that exposes the full-detail transition.

### Project Update pass 1 · blocked

- Evidence: `evidence/implementation-update-composer-pass1.png`.
- Finding: at the official comparison width, the internal composer scroller placed Discard and Publish below the visible viewport, hiding persistent actions.
- Fix: made composer and schedule headers/footers sticky within the bounded modal scroller.

### Project Update final pass · passed

- Evidence: `evidence/implementation-update-composer-final.png` and `evidence/comparison-update-composer-final.png`.
- Result: the 3-state health control, narrative editor, dark surface hierarchy, cancel/publish actions, and semantic color mapping retain the official composer intent. Candidate provenance and source evidence are intentional current-Linear additions, not design drift.

### Responsive pass · passed

- Evidence: `evidence/implementation-mobile-list.png`, `evidence/implementation-mobile-peek.png`, and `evidence/implementation-mobile-composer.png`.
- Result: no overlap or horizontal overflow; Peek becomes a bottom sheet; the Project Update composer keeps its publish action visible while its evidence body scrolls.

## Primary interactions tested

1. Issue List row → Peek by visible action and Space.
2. Peek `Next issue` changes `LIN-342 → LIN-338`; URL and selected row follow.
3. Close Peek restores focus to the selected Issue row.
4. Full Detail changes `LIN-338` to Done; returning to Peek shows Done from the same state object.
5. Empty manual update cannot publish.
6. Write with Agent creates a labeled candidate with 3 sources and observed changes; it does not enter Pulse.
7. Human edit + Publish increases Atlas Updates `2 → 3` and adds the same update to Overview, history, and Recent Pulse.
8. Comment is attached to the latest update; reaction buttons mutate the same Update.
9. Update schedule can change to Never and displays `No update expected` without changing health.
10. Pulse `For me / Popular / Recent / At risk projects` produces distinct projections; custom risk results all show At risk.
11. Pulse subscription toggles to Subscribed with status feedback.
12. Desktop and `391 × 844` mobile list, Peek, Project Overview, and composer remain usable.

## Implementation checklist

- [x] Official source and rendered implementation opened and compared in combined images.
- [x] Full-view Peek and focused Project Update comparisons inspected.
- [x] All P0/P1/P2 findings fixed and re-captured.
- [x] Core pointer, keyboard, form, history, state-projection, and responsive paths tested.
- [x] 14/14 automated tests passed; production build passed; browser page logs clean.

## Follow-up polish

- P3: use Linear's exact font only if it can be legally and technically bundled for private study.
- P3: replace initial avatars with licensed portraits only if a future research question depends on people-density fidelity.

final result: passed

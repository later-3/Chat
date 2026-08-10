# HEY Calendar reference sub-application — design QA

final result: passed

## Comparison target

- Source visual truth: `evidence/source-mobile.png`, copied without modification from `/Users/xulater/Code/Chat-hey-calendar-reference-v01/docs/design/reference-implementations/hey-calendar/evidence/mobile-day-final.png`.
- Browser-rendered implementation: `evidence/mobile-day.png`.
- Combined comparison input: `evidence/compare-mobile.png`, generated from `evidence/compare-mobile.html` with the frozen Day on the left and the deduplicated Day on the right.
- State: Day, Sunday 2026-08-09, source theme, embedded mode, all four Calendars visible.
- Browser CSS viewport: 391 × 844; device pixel ratio 1.5; implementation capture: 391 × 843 pixels.
- Source pixels: 520 × 1125. Both source and implementation are normalized to 391 CSS pixels wide in the comparison input.

## Required fidelity surfaces

- Fonts and typography: the original system/SF stack, centered date hierarchy, event title/time hierarchy, and small supporting labels are unchanged.
- Spacing and layout rhythm: header, date navigation, mobile agenda, Event blocks, Habit rail, and bottom navigation retain the frozen HEY markup and responsive CSS. Removing Sometime intentionally moves Habits upward.
- Colors and tokens: the original HEY blue/violet shell, calendar-owned Event colors, orange date underline, neutral backgrounds, and semantic conflict/free colors remain unchanged.
- Image and asset fidelity: the original profile avatar and nighttime texture are copied under `public/assets/hey/` and referenced through `/assets/hey/...`; Phosphor icons remain the original icon system.
- Copy and content: Day, Week, Year, Journal, Habits, create-from-message, source provenance, Event fields, conflict feedback, and save/update copy remain intact. Only Sometime task copy and search results were removed.

No additional focused crop was needed because the normalized mobile comparison keeps the complete header and readable agenda blocks visible; the Event composer was separately exercised in the live browser.

## Interaction and responsive evidence

- `scrollWidth === 391` at the 391px viewport.
- Day renders six agenda Events and no Sometime content.
- Every visible button, input, select, and textarea measured at least 44 × 44px after the mobile target correction.
- Day → Week → Year → Day passed; Week showed three weeks and Year showed 12 months.
- Create from message opened `Lunch with Tim` as an unsaved candidate with source provenance and one `Client review` conflict.
- Choosing 4pm changed the candidate to 16:00–17:00 and produced “No overlap at this time.”
- Save created exactly one visible `Lunch with Tim` Event and closed the composer.
- HEY navigation retained `embedded=1` and `theme=source` in its URL.
- Fresh-tab app-origin console errors and warnings: 0.

## Comparison history

1. Initial standalone preview exposed two React copies through dependency optimization. Local Vite configs now use the original React plugin and dedupe React/React DOM; both production build and live render pass.
2. First mobile measurement found 40px header/date/Habit controls and 42px arrow widths. Mobile overrides raised these to 44px.
3. Post-fix measurement found 0 undersized visible controls and no horizontal overflow.

## Findings

- No actionable P0, P1, or P2 differences remain.
- Expected difference: the Sometime strip and add-task dialog are absent. Things is the only Action owner in the combined product, so retaining them would be a functional duplication rather than visual fidelity.

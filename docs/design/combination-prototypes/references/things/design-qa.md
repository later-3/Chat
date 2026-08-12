# Things reference sub-application — design QA

final result: passed

## Comparison target

- Source visual truth: `evidence/source-mobile.png`, copied without modification from the frozen Things mobile reference at `/Users/xulater/.codex/visualizations/2026/08/08/019fdf03-85ed-7cb1-9f70-bb5939fda78f/chat-ui-reference-pack/things/05-today-iphone.png`.
- Browser-rendered implementation: `evidence/mobile-today.png`.
- Combined comparison input: `evidence/compare-mobile.png`, generated from `evidence/compare-mobile.html` with source on the left and implementation on the right.
- State: Today, source theme, embedded mode, no open task detail.
- Browser CSS viewport: 391 × 844; device pixel ratio 1.5; implementation capture: 391 × 843 pixels.
- Source pixels: 500 × 888. The comparison page normalizes both images to 391 CSS pixels wide. The source's shorter viewport is retained rather than cropped or stretched.

## Required fidelity surfaces

- Fonts and typography: the frozen system/SF font stack, Today hierarchy, task title/subtitle pairing, deadline emphasis, and This Evening hierarchy remain intact. Fixture names differ where the frozen implementation already differed from the supporting iPhone image.
- Spacing and layout rhythm: desktop keeps the frozen 1188 × 1028 window. At 391px the same markup becomes a native single-column surface rather than a scaled desktop window. Calendar rows are deliberately taller than the supporting source so every clickable Event projection has a 44px target.
- Colors and tokens: Things yellow, calendar-source colors, neutral task text, deadline pink, evening blue, separators, and original shadows remain unchanged.
- Image and icon fidelity: the exact Font Awesome CSS and webfonts are bundled locally; no placeholder glyphs or recreated SVGs were introduced.
- Copy and content: Today, This Evening, task details, When, Deadline, completion, Undo, and Quick Find remain the frozen Things interactions. The calendar summary intentionally uses HEY Event IDs, titles, and start times instead of the old five hard-coded Things fixtures.

No additional focused crop was needed: the full side-by-side comparison keeps the heading, calendar rows, first tasks, deadline, and the start of This Evening legible. Browser measurements separately checked every visible control.

## Interaction and responsive evidence

- `scrollWidth === 391` at the 391px viewport.
- Five calendar rows project `event-focus`, `event-client`, `event-lunch`, `event-critique`, and `event-call`; every row measures 44px and is fully clickable.
- Every visible button, input, select, and textarea measured at least 44 × 44px.
- Task detail opened; When opened; choosing This Evening moved the same task into the evening section and showed the exact Undo toast.
- The Event rows only emit `chat:navigate`; no Event editor exists in Things.
- Fresh-tab app-origin console errors and warnings: 0.

## Comparison history

1. First mobile measurement found 40px task checkbox widths and 22px source-link heights. The mobile grid and source buttons were increased to 44px without changing the desktop reference.
2. Post-fix measurement found 0 undersized visible controls and no horizontal overflow.

## Findings

- No actionable P0, P1, or P2 differences remain.
- Expected difference: the official mobile source has native iOS back/down chrome, while this sub-application must retain the frozen web prototype markup and its Quick Find/bottom toolbar.
- Expected difference: the calendar summary is taller and contains HEY Events, because cross-scene Event identity and 44px targets are explicit combination requirements.

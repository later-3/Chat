# HEY Calendar reference implementation — Design QA

## Evidence

- Source visual truth:
  - `evidence/source-day-official.png` — current official HEY Calendar Day help screenshot, 2304 × 1342 px.
  - `evidence/source-event-official.png` — current official Event composer help screenshot, 754 × 695 px.
- Browser-rendered implementation:
  - `evidence/day-final.png` — desktop Day, 1920 × 1200 screenshot pixels.
  - `evidence/composer-new-full.png` — desktop New Event, 1920 × 1200 screenshot pixels.
  - `evidence/mobile-day-final.png` — mobile Day, 520 × 1125 screenshot pixels.
  - `evidence/mobile-composer-final.png` — mobile New Event, 520 × 1125 screenshot pixels.
- Combined comparison input:
  - `evidence/compare-day.png` — source and implementation in one 2880 × 900 image.
  - `evidence/compare-composer.png` — source and focused implementation composer in one 1920 × 1042 image.

## Normalization

- Desktop CSS viewport: 1440 × 900; browser-reported `devicePixelRatio: 0.75`; Browser capture output: 1920 × 1200. The implementation was downsampled to the CSS target for the combined Day comparison.
- Official Day source: center-cropped from 2304 × 1342 to 2147 × 1342 before downsampling to 1440 × 900, removing aspect-ratio-only edge differences.
- Composer focus region: implementation dialog bounding box was 720 × 781 CSS px at x=360, y=59; its corresponding capture region was normalized beside the official 754 × 695 composer.
- Mobile CSS viewport: 391 × 844; Browser capture output: 520 × 1125. The page reported `scrollWidth: 391`, so there was no page-level horizontal overflow.

## State

1. Day: Sunday, August 9, 2026; all four Calendars visible; current-time marker at 3:21pm; Sometime and Habits visible.
2. Composer: unsaved Personal candidate at 11am–12pm with no title, optional details collapsed, day schedule visible, save disabled.
3. Mobile: same Day and same New Event state using the responsive vertical agenda and bottom-sheet composer.

## Findings

No actionable P0 / P1 / P2 difference remains.

- Typography: the implementation uses a system sans stack with comparable heavy display headings, medium UI labels, compact timeline labels, deliberate vertical Event text, and no broken wrapping or truncation in the tested states.
- Spacing and layout: the desktop preserves HEY's large quiet header, continuous timeline, tall duration blocks, night boundaries, and Sometime strip. The composer keeps the official compact blue outline and grouped date / metadata hierarchy; it is intentionally taller because the scheduling peek is always visible for this study path.
- Colors and tokens: blue is the shell action color; Event colors are semantic Calendar-source tokens. Tentative treatment and conflict / success feedback have shape or text equivalents and do not rely on color alone.
- Image quality: the nighttime texture and profile image are real raster assets at sufficient resolution, with no placeholder, emoji, CSS-art, inline-SVG, masking halo, or visible compression defect. Product UI icons come from one consistent library.
- Copy and content: text describes the standalone prototype's real behavior. Source, conflict, save, hidden-calendar search, personal practice, and autosave labels do not imply external effects.
- Responsive behavior: the 391 × 844 Day becomes a vertical agenda rather than a shrunken horizontal canvas; the composer preserves the fixed Cancel / Add action and scrollable content; all persistent targets are at least 44px.
- Accessibility and states: semantic dialogs and labels are present; save-disabled reason, visible focus, pressed / checked state, status toast, keyboard shortcuts, and Escape close behavior were exercised.

Accepted differences:

1. The official Day screenshot visually includes adjacent-day hours around the focal date; this bounded fixture renders the selected 24-hour date. The preserved design conclusion is continuous duration and day/night context, not an infinite-time implementation.
2. The official generic Event screenshot is shorter; this prototype keeps the conflict peek visible in the composer because source-to-commit scheduling is the primary scenario under study.
3. No current official mobile screenshot covers the exact same state. Mobile QA therefore checks responsive integrity and interaction equivalence, not pixel-for-pixel mobile branding.

## Focused region comparison

The composer required a focused comparison because the full-page Day image made field hierarchy, icon alignment, disabled state, date grouping, and footer action placement too small to judge. `evidence/compare-composer.png` contains both focused regions in the same input. No additional crop was necessary for the timeline because the full Day comparison keeps event duration, nighttime, current-time marker, and Sometime readable.

## Comparison history

1. Runtime pre-pass found one P2 behavior issue: Escape was ignored while an input or textarea had focus. The keyboard handler was reordered so Escape closes the topmost draft, Search, Journal, Habits, menu, or Sometime dialog before form-field shortcut suppression. Browser retest passed for Search and unsaved Event draft.
2. Visual pass 1 compared `compare-day.png` and `compare-composer.png` after that fix. It found no actionable P0 / P1 / P2 issue, so no post-comparison visual fix was required.

## Primary interactions tested

1. Day → Week → Year → Day, URL state, current selection, 3 adjacent Week sections, 12 Year months.
2. Email → candidate → conflict → choose free slot → Save; candidate stayed absent from Day until Save.
3. Edit saved Event → change Calendar → Update; one stable Event remained and its source color changed.
4. Hide Work Calendar → Day and Search both hide Work Events → restore Calendar.
5. Search Event / Sometime / Journal and route to the real projection.
6. Add / complete Sometime, edit Journal, toggle Habit, edit Day name.
7. D / U / Y / N / left / right / Escape shortcuts, including focused inputs.
8. Desktop and mobile Day / composer; mobile Week / Year entry; page-level horizontal overflow check.

Browser console errors and warnings checked: 0.

## Follow-up polish

- P3: if a future study needs infinite Day navigation, extend the timeline to adjacent-day hours without changing the Event model.
- P3: if a signed-in official mobile state becomes available, add a same-state mobile source comparison.

final result: passed

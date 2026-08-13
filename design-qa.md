# Design QA — K7 AnythingLLM × K2 Things

- source visual truth:
  - `docs/design/references/evidence/anythingllm-v0.1/screenshots/02-anythingllm-start-official-1240x720.png`
  - `docs/design/combination-prototypes/evidence/stage1/visual-compare/things-today-final-raw.png`
- implementation screenshot: `design-qa-implementation-final-1280x800.png`
- mobile evidence: `design-qa-mobile-390x844.png`
- dark-theme correction: `design-qa-theme-fix-dark.png`
- reported defect comparison: `design-qa-theme-fix-comparison.png`
- full-view comparison: `design-qa-comparison-final.png`
- focused comparison: `design-qa-focused-final.png`
- viewport: desktop 1280 × 800 CSS px，mobile 390 × 844 CSS px
- pixels / density: screenshots were captured at deviceScaleFactor 1; source K7 is 1240 × 720，source K2 is 1920 × 1200，implementation is 1280 × 800. The full comparison normalizes the two sources to 640 × 400 and preserves the implementation at 1280 × 800.
- state: light theme，empty conversation，workflow configuration tab，advanced workflow steps collapsed，three desktop panes open.

## Findings

- Fonts and typography: passed. The implementation uses the product's system stack with PingFang SC and matches the restrained, medium-weight UI text of K2; the empty-state title adopts the centered K7 hierarchy without imitating its dark palette.
- Spacing and layout rhythm: passed. The left navigation remains compact，the conversation owns the largest calm surface，and the work area uses shallow cards instead of a long debugging panel. Pane boundaries have no overflow at 1280 × 800.
- Colors and visual tokens: passed. Warm white，soft gray side surfaces，subdued blue selection，and low-contrast separators follow K2. Dark theme remains available as an explicit preference.
- Image quality and assets: passed. The selected references contain no app-owned raster asset that this product screen needs to reproduce; no placeholder image，CSS illustration，handmade SVG，or emoji substitute was introduced.
- Copy and content: passed. Development-facing copy such as “真实规划会话”“查看演示工作区” and workflow version/date strings were removed from the primary surface; implementation keeps product terms required for the real workflow.
- Interaction states: passed. Advanced workflow settings open and close，the right work area collapses and restores，mobile switches between chat and work，and the navigation drawer opens at 320 px without horizontal overflow.
- Console: passed. No browser console errors were observed in the verified interaction pass.

## Comparison history

### Pass 1 — blocked

- P2: persisted local layout opened without navigation and left the conversation only 440 px wide，so the reference hierarchy was not visible as a three-pane composition.
- P2: top-right connection copy，model implementation wording，workflow version and publish date still read like a diagnostic surface.
- Fixes: restored the three-pane state for QA，widened the conversation through the persisted splitter control，reduced connection to a status dot，renamed the model chip to “自动模型”，removed version and publish date from the workflow picker，and softened pane separators.
- post-fix evidence: `design-qa-implementation-final-1280x800.png` and `design-qa-comparison-final.png`.

### Pass 2 — passed

- No actionable P0 / P1 / P2 differences remain for the user's chosen hybrid direction. The build intentionally keeps Chat's existing three-pane product layout rather than cloning either source application's exact structure.

### Pass 3 — blocked after user evidence

- P1: restore and collapse actions were absolutely positioned over the conversation title，so persisted narrow layouts could render “打开导航 / 规划” and “打开工作 / 收起对话” on top of one another.
- P1: the K2 light-theme override used literal white translucent and hover surfaces，so dark mode mixed a dark application bar with large light work surfaces.
- Fixes: moved navigation，conversation，and work restore actions into normal header flex layout; removed the floating restore buttons; added semantic translucent，hover，shadow，and dark-surface tokens; changed dark mode to a coordinated charcoal hierarchy with subdued blue emphasis.
- post-fix evidence: `design-qa-theme-fix-dark.png` and `design-qa-theme-fix-comparison.png`.

### Pass 4 — passed

- At 1280 × 720，the three conversation-header actions occupy non-overlapping horizontal ranges (20–88，388–464，472–540 px)，horizontal overflow is 0，and dark surfaces resolve consistently to charcoal values: header `rgba(24,24,27,.94)`，chat `rgb(24,24,27)`，work `rgb(28,28,31)`，composer `rgb(40,40,45)`.

## Focused region comparison

`design-qa-focused-final.png` compares K7's centered empty conversation and composer，K2's bright content / sidebar treatment，and the implementation's center surface. It confirms the requested structural influence，type hierarchy，white-space ratio，surface contrast，and blue emphasis at readable scale.

## Follow-up polish

- P3: replace remaining text-only collapse actions with a consistent icon set after the product selects an icon library.
- P3: add realistic session and project data to judge dense-list rhythm once the visual direction is approved.

final result: passed

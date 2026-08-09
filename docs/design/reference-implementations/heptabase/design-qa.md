# Heptabase Workbench reference · Design QA

## Comparison target

- Source visual truth (external, local-only, ignored by Git):
  - `evidence/source-official-whiteboard.webp` — current official Whiteboard + Card detail, `3456 × 2160`.
  - `evidence/source-official-ai-research.png` — current official Whiteboard + PDF + AI chat, `3456 × 2160`.
- Source pages, checked 2026-08-09/10:
  - <https://heptabase.com/>
  - <https://wiki.heptabase.com/user-interface-logic>
  - <https://support.heptabase.com/en/articles/13009956-what-data-can-ai-access-when-i-turn-on-the-space-search-option-in-an-ai-conversation>
  - <https://support.heptabase.com/en/articles/10510497-collaboration-q-a>
- Browser-rendered implementation:
  - `evidence/implementation-desktop-final.png` — `1440 × 900` pixels, desktop CSS viewport `1440 × 900` after in-app Browser density normalization.
  - `evidence/implementation-mobile-final.png` — `391 × 844` pixels, mobile CSS viewport `391 × 844` after in-app Browser density normalization.
- Composed comparison inputs:
  - `evidence/comparison-desktop-final.png` — full-view source and implementation rendered together at equal `16:10` aspect.
  - `evidence/comparison-focused-final.png` — Card/Workbench region rendered together for typography, panel anatomy and object continuity review.
- State: `Project Solution · 研究地图`, canonical Card selected, Card panel open; mobile main surface uses the same objects as an ordered outline.

## Density normalization

The in-app Browser reported `devicePixelRatio = 0.75`. Its desktop screenshot buffer is the inverse-density raster of the complete `1440 × 900` CSS rectangle (`1920 × 1200` raw). Its mobile no-clip buffer is `520 × 1125` with the complete `391 × 844` CSS viewport in the top-left rendered region and density padding on the right / bottom; JPEG chroma rounding exposes that region as `390 × 844`, so QA crops the complete rendered region and performs a one-pixel horizontal normalization to `391 × 844`. Desktop is rescaled to `1440 × 900`. No browser chrome or blank density padding enters the comparison.

The official source is `3456 × 2160` (`16:10`). The comparison page displays source and implementation in equal `16:10` frames using `object-fit: contain`, so differences are not caused by density, crop or browser chrome.

## Findings

No actionable P0/P1/P2 finding remains.

### Required fidelity surfaces

1. **Fonts and typography — passed.** Both source and implementation use a neutral sans-serif workbench hierarchy. Small navigation, compact Card metadata, a readable Card title and long-form editor remain distinct. The prototype intentionally uses Chinese fixture copy and the system/Inter fallback rather than copying a proprietary font build.
2. **Spacing and layout rhythm — passed.** The app preserves the source’s working proportions: stable shell, large spatial surface, compact object Cards and an adjacent reference/editor panel. Left Apps/Tabs navigation is intentionally expanded because the current official UI logic documents it as part of the context model; the marketing screenshot shows a collapsed state.
3. **Colors and visual tokens — passed.** Neutral grey shell, white Card surfaces and restrained section colors match the source’s visual grammar. Color never carries state alone; selected/focused states also use outline, text and structure.
4. **Image quality and asset fidelity — passed.** The target contains no app-owned illustration that must be reproduced. UI icons come from Phosphor rather than hand-drawn SVG/CSS substitutes. External screenshots remain ignored, link-only evidence.
5. **Copy and content — passed.** Fixture copy covers work, evidence, methods and a personal hobby Project without pretending to be production data. Card, placement, AI candidate, access log and permission boundaries are explicit.
6. **States and interactions — passed.** Browser-verified paths cover Card Library filtering/placement, canonical Card editing, all locations, focus and Back, explicit AI context and access log, candidate-to-Card save, Whiteboard permission changes, mobile navigation and predictable return.
7. **Responsiveness — passed.** `391 × 844` has `scrollWidth = clientWidth = 391`; the desktop canvas becomes a Section-grouped outline rather than a miniature. Desktop initial, mobile Card / Library / Chat / Share and mobile outline scans all found `0` enabled controls below `44 × 44`.
8. **Accessibility — passed for the prototype gate.** Placement Card bodies are native buttons, all four mobile panel tabs retain explicit accessible names, Share traps focus inside an inert background, closes on Escape and restores its trigger. All enabled controls have a `44 × 44` browser-measured hit area, visible focus and keyboard-native activation; a reduced-motion branch is present. This does not claim full screen-reader coverage or 200% zoom productization.

## Comparison history

### Pass 1 — blocked

- P2: mobile rendered all Section containers before all Cards, losing the source relationship between spatial grouping and object placement.
- P2: mobile scan found `14` visible controls below `44 × 44`, including canvas actions and placement actions.
- Fixes: introduced an explicit Section-grouped mobile outline over the same Card/placement model; enlarged mobile header, panel, canvas and placement targets; added a real mobile navigation drawer; disabled out-of-scope controls instead of leaving silent no-ops.

### Pass 2 — visual direction passed; independent QA reopened

- Post-fix mobile evidence: `evidence/implementation-mobile-final.png`.
- Browser metrics: CSS viewport `391 × 844`, horizontal overflow `0`, visible controls below `44 × 44`: `0`.
- Desktop structural comparison: `evidence/comparison-desktop-final.png`.
- Focused Card/editor comparison: `evidence/comparison-focused-final.png`.
- Console: `0` error / warning.
- At that checkpoint: core model tests `8/8`; Sites contracts `4/4`.
- Independent audit then found `6 P1 + 2 P2`: compact enabled hit areas, mouse-only placement Card opening, unnamed mobile tabs, incomplete Share focus lifecycle, globally scoped permissions, no repository browser runner, and static permission subtitle / stale QA copy.

### Pass 3 — remediation passed

- All enabled controls now share a measured `44 × 44` interaction box on desktop and mobile while retaining compact visual content.
- Placement Card opening is a native button; Move / Remove remain sibling actions.
- Panel tabs have explicit `aria-label`; Share sets background surfaces `inert`, traps Tab, handles Escape and restores the Share trigger.
- Permission state is `permissionsByBoardId[boardId][personId]`; two shared Whiteboards carry different permissions and a unique Card proves independent visibility. Person subtitles derive from current access.
- Added `tests/ui-contract.test.mjs` and a repository-owned `tests/heptabase-browser-e2e.mjs` runner for the user-selected in-app Browser. The repeatable runner covers desktop / mobile viewport, 44px scans, keyboard Card entry, named tabs, Library placement, location / Back continuity, explicit AI context / provenance, Share focus / permission lifecycle, mobile navigation and console.
- Automated result: model / UI contracts `15/15`; Sites contracts `4/4`; real IAB browser gates `9/9`; total `28/28`. The ninth gate opens Share on desktop, crosses to the mobile breakpoint, closes it and verifies focus falls back to the visible `Open navigation` control.
- Browser metrics: desktop `1440 × 900`, `scrollWidth = 1440`; mobile `391 × 844`, `scrollWidth = 391`; enabled controls below `44 × 44 = 0`; unnamed enabled controls `0`; app console error / warning `0`.
- Final own-work evidence: `evidence/implementation-desktop-final.png`, `evidence/implementation-mobile-final.png`, `evidence/comparison-desktop-final.png` and `evidence/comparison-focused-final.png`.

## Follow-up polish

- P3: add a touch gesture for reordering Cards within the mobile outline; the current button equivalent is complete and accessible, so this does not block the reference contract.
- P3: add a second focused comparison for AI chat once Heptabase publishes a stable high-resolution current screenshot for that exact panel state.

final result: passed

#!/usr/bin/env bash
# Build the 3×3 reference workbench mechanism visual index.
# Uses only ffmpeg (scale, pad, color, vstack, overlay). No drawtext, no external deps.
# Deterministic: same inputs → same output bytes.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# ── Fixed paths (relative to repo root) ──────────────────────────────
SRC_1="$REPO_ROOT/docs/design/combination-prototypes/evidence/stage1/visual-compare/basecamp-project-room-final-raw.png"
SRC_2="$REPO_ROOT/docs/design/combination-prototypes/evidence/stage1/visual-compare/things-today-final-raw.png"
SRC_3="$REPO_ROOT/docs/design/combination-prototypes/evidence/stage1/visual-compare/linear-list-peek-final-raw.png"
SRC_4="$REPO_ROOT/docs/design/combination-prototypes/evidence/stage1/visual-compare/hey-day-final-raw.png"
SRC_5="$REPO_ROOT/docs/design/combination-prototypes/evidence/stage1/visual-compare/agent-feed-final-raw.png"
SRC_6="$REPO_ROOT/docs/design/combination-prototypes/evidence/stage1/visual-compare/heptabase-whiteboard-final-raw.png"
SRC_7="$REPO_ROOT/docs/design/references/evidence/anythingllm-v0.1/screenshots/06-open-computer-active-run-official-1280x720.png"
SRC_8="$REPO_ROOT/docs/design/references/evidence/orca-v0.1/screenshots/03-diff-annotation.png"
SRC_9="$REPO_ROOT/docs/design/references/evidence/plane-v0.1/screenshots/03a-github-overview.webp"

OUTPUT="$REPO_ROOT/docs/design/references/evidence/reference-workbench-mechanism-index-v0.1.png"

# ── Grid geometry ────────────────────────────────────────────────────
CANVAS_W=2400
CANVAS_H=1620
PAD=10          # outer padding
GAP=5           # gap between cells
CELL_W=790      # (2400 - 2*10 - 2*5) / 3 = 790
CELL_H=530      # (1620 - 2*10 - 2*5) / 3 = 530
BAR_H=12        # type bar height at top of each cell
IMG_AREA_H=$((CELL_H - BAR_H))  # 518

# ── Type bar colors ──────────────────────────────────────────────────
# 1–6: frozen prototype → dark green #2d5016
# 7–9: workbench sample → indigo #4b0082
FROZEN_COLOR="0x2d5016"
SAMPLE_COLOR="0x4b0082"

# ── Pre-flight: check all inputs exist ───────────────────────────────
SOURCES=("$SRC_1" "$SRC_2" "$SRC_3" "$SRC_4" "$SRC_5" "$SRC_6" "$SRC_7" "$SRC_8" "$SRC_9")
for i in "${!SOURCES[@]}"; do
  if [ ! -f "${SOURCES[$i]}" ]; then
    echo "ERROR: missing source $((i+1)): ${SOURCES[$i]}" >&2
    exit 1
  fi
done

# ── Temp directory with explicit cleanup ─────────────────────────────
TMPDIR_WORK="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_WORK"' EXIT

# ── Step 1: For each source, create a full cell (bar + contained image) ──
for i in "${!SOURCES[@]}"; do
  idx=$((i + 1))

  # Choose bar color based on index
  if [ "$idx" -le 6 ]; then
    BAR_COLOR="$FROZEN_COLOR"
  else
    BAR_COLOR="$SAMPLE_COLOR"
  fi

  # Scale source to fit IMG_AREA (contain), pad to fill width
  # Then overlay the type bar at top
  ffmpeg -y -i "${SOURCES[$i]}" \
    -filter_complex "
      [0:v]scale=${CELL_W}:${IMG_AREA_H}:force_original_aspect_ratio=decrease,
           pad=${CELL_W}:${IMG_AREA_H}:(ow-iw)/2:(oh-ih)/2:color=white[scaled];
      color=c=${BAR_COLOR}:s=${CELL_W}x${BAR_H}[bar];
      [bar][scaled]vstack=inputs=2
    " \
    -frames:v 1 \
    "$TMPDIR_WORK/cell_$idx.png" 2>/dev/null
done

# ── Step 2: Compose 3×3 grid onto white canvas ──────────────────────
# Cell positions (top-left corner):
#   Row 0: y = PAD = 10
#   Row 1: y = PAD + CELL_H + GAP = 545
#   Row 2: y = PAD + 2*(CELL_H + GAP) = 1080
#   Col 0: x = PAD = 10
#   Col 1: x = PAD + CELL_W + GAP = 805
#   Col 2: x = PAD + 2*(CELL_W + GAP) = 1600

ffmpeg -y \
  -f lavfi -i "color=c=white:s=${CANVAS_W}x${CANVAS_H}" \
  -i "$TMPDIR_WORK/cell_1.png" \
  -i "$TMPDIR_WORK/cell_2.png" \
  -i "$TMPDIR_WORK/cell_3.png" \
  -i "$TMPDIR_WORK/cell_4.png" \
  -i "$TMPDIR_WORK/cell_5.png" \
  -i "$TMPDIR_WORK/cell_6.png" \
  -i "$TMPDIR_WORK/cell_7.png" \
  -i "$TMPDIR_WORK/cell_8.png" \
  -i "$TMPDIR_WORK/cell_9.png" \
  -filter_complex "
    [0:v][1:v]overlay=10:10[g1];
    [g1][2:v]overlay=805:10[g2];
    [g2][3:v]overlay=1600:10[g3];
    [g3][4:v]overlay=10:545[g4];
    [g4][5:v]overlay=805:545[g5];
    [g5][6:v]overlay=1600:545[g6];
    [g6][7:v]overlay=10:1080[g7];
    [g7][8:v]overlay=805:1080[g8];
    [g8][9:v]overlay=1600:1080
  " \
  -frames:v 1 \
  "$OUTPUT" 2>/dev/null

# ── Step 3: Verify output ───────────────────────────────────────────
if [ ! -f "$OUTPUT" ]; then
  echo "ERROR: output was not created" >&2
  exit 1
fi

OUT_W=$(sips -g pixelWidth  "$OUTPUT" | awk '/pixel/{print $2}')
OUT_H=$(sips -g pixelHeight "$OUTPUT" | awk '/pixel/{print $2}')

if [ "$OUT_W" != "$CANVAS_W" ] || [ "$OUT_H" != "$CANVAS_H" ]; then
  echo "ERROR: output size ${OUT_W}x${OUT_H} != expected ${CANVAS_W}x${CANVAS_H}" >&2
  exit 1
fi

echo "OK  ${OUT_W}x${OUT_H}  $OUTPUT"

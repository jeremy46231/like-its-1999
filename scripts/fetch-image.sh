#!/usr/bin/env bash
#
# Mirror the v86 Windows 98 disk image locally so we can fully self-host it.
#
# The image is served by copy.sh's CDN (i.copy.sh) as 256 KiB "parts" named by
# byte range, e.g. windows98/0-262144.img. v86 (with use_parts: true) fetches
# these lazily. We download every part into public/images/windows98/ and serve
# them through Vite instead — copy.sh blocks cross-origin hotlinking by Referer,
# and the event needs a self-hosted image regardless (see tmp-chat-notes.md).
#
# Idempotent: re-running only fetches parts that are missing or the wrong size.
set -euo pipefail

SRC="https://i.copy.sh/windows98"
IMAGES="$(cd "$(dirname "$0")/.." && pwd)/public/images"
DEST="$IMAGES/windows98"
STATE="windows98_state-v2.bin.zst" # saved-state snapshot -> instant boot
CHUNK=262144
TOTAL=$((300 * 1024 * 1024)) # 300 MiB, must match `size` in emulator/main.js
PARTS=$((TOTAL / CHUNK))

mkdir -p "$DEST"

# Saved-state snapshot (RAM+CPU frozen at a settled desktop). ~13 MiB single file.
if [ ! -f "$IMAGES/$STATE" ]; then
  echo "Fetching state snapshot $STATE"
  curl -fsS --retry 3 -o "$IMAGES/$STATE" "https://i.copy.sh/$STATE"
fi

echo "Fetching $PARTS parts into $DEST"

seq 0 $((PARTS - 1)) | xargs -P 32 -I{} bash -c '
  i="$1"; src="$2"; dest="$3"; chunk="$4"
  s=$((i * chunk)); e=$((s + chunk))
  name="${s}-${e}.img"
  out="$dest/$name"
  # Skip parts already downloaded at the expected size.
  if [ -f "$out" ] && [ "$(stat -f%z "$out" 2>/dev/null || stat -c%s "$out")" -eq "$chunk" ]; then
    exit 0
  fi
  curl -fsS --retry 3 -o "$out" "$src/$name" || { echo "FAILED part $i ($name)" >&2; rm -f "$out"; exit 1; }
' _ {} "$SRC" "$DEST" "$CHUNK"

echo "Done. $(ls -1 "$DEST" | wc -l | tr -d ' ') files, $(du -sh "$DEST" | cut -f1) total."

// Bake a v86 state's disk overlays into base image files — "flatten" — so guest
// writes captured only in a save_state live on disk instead of in a fragile RAM
// overlay. Fully automated: it clones each base, paints the matching overlay's blocks
// in, and verifies the result mounts as FAT.
//
// This is the JS replacement for scripts/flatten.py + parse_state.py: same state
// parser as the extractor (state.js), so there's one source of truth for the format.
//
// Overlay→disk assignment: v86 serialises overlays in the order disks are registered
// (hda then hdb), so overlay[i] maps to base[i] by default. Each result is then
// mounted and probed; a base that won't mount after flattening is reported as an
// error (likely a wrong pairing) unless --force is given.

import { parseState, maybeGunzip } from './state.js'
import { nodeFileSource } from './blockdev.js'
import { OverlayBlockDevice } from './blockdev.js'
import { FatFs } from './fat.js'

// Apply an overlay's blocks onto an already-cloned output image file (Node).
// Returns the number of blocks written.
export async function applyOverlayToFile(outPath, overlay) {
  const fs = await import('node:fs/promises')
  const handle = await fs.open(outPath, 'r+')
  try {
    const bs = overlay.blockSize
    // Sort by index so writes are sequential (kinder to the disk).
    const idxs = [...overlay.blocks.keys()].sort((a, b) => a - b)
    for (const idx of idxs) {
      const bytes = overlay.block(idx)
      await handle.write(bytes, 0, bytes.length, idx * bs)
    }
    return idxs.length
  } finally {
    await handle.close()
  }
}

// Does `outPath` mount as a FAT filesystem with a parseable root directory?
async function mountsOk(outPath) {
  try {
    const base = await nodeFileSource(outPath)
    try {
      const fs = await FatFs.open(new OverlayBlockDevice(base, null))
      const entries = await fs.readdir('/')
      return entries.length > 0
    } finally {
      await base.close?.()
    }
  } catch {
    return false
  }
}

// Flatten one base→out with a chosen overlay. Clones base to out first.
export async function flattenOne(
  basePath,
  outPath,
  overlay,
  { verify = true } = {}
) {
  const fs = await import('node:fs/promises')
  await fs.copyFile(basePath, outPath)
  const written = await applyOverlayToFile(outPath, overlay)
  const ok = verify ? await mountsOk(outPath) : null
  return {
    written,
    blocks: overlay.blockCount,
    bytes: overlay.maxByte,
    mountsOk: ok,
  }
}

// ---------------------------------------------------------------------------------
// Node CLI:  node flatten.js <state> <base> <out> [<base2> <out2> ...]
//
//   node flatten.js state.bin hda.img hda-flat.img            # 1 disk
//   node flatten.js state.bin hda.img hda-flat.img hdb.img hdb-flat.img
//
// Pairs bases with overlays in order (overlay[0]→first base, ...). Override the
// overlay used for a given base with VMFS_OVERLAY_MAP="0,1" (comma-separated indices,
// one per base). Pass --force to write even if a result fails the FAT mount check.
// ---------------------------------------------------------------------------------

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`

if (isMain) {
  const fsp = await import('node:fs/promises')
  const args = process.argv.slice(2)
  const force = args.includes('--force')
  const positional = args.filter((a) => a !== '--force')
  const [statePath, ...pairs] = positional

  if (!statePath || pairs.length < 2 || pairs.length % 2 !== 0) {
    console.error(`usage: node flatten.js <state> <base> <out> [<base2> <out2> ...]
  pairs bases with overlays in order; override with VMFS_OVERLAY_MAP="0,1"
  --force  write even if a flattened image fails the FAT mount check`)
    process.exit(1)
  }

  const stateBytes = new Uint8Array(await fsp.readFile(statePath))
  const { overlays, blockSize } = parseState(await maybeGunzip(stateBytes))
  console.error(
    `state has ${overlays.length} overlay(s), block size ${blockSize}:`
  )
  overlays.forEach((o, i) =>
    console.error(
      `  #${i}: ${o.blockCount} blocks, touches up to ${(o.maxByte / 1e6).toFixed(1)} MB`
    )
  )

  const map = process.env.VMFS_OVERLAY_MAP
    ? process.env.VMFS_OVERLAY_MAP.split(',').map(Number)
    : null

  const bases = []
  for (let i = 0; i < pairs.length; i += 2)
    bases.push({ base: pairs[i], out: pairs[i + 1] })

  let failed = false
  for (let i = 0; i < bases.length; i++) {
    const overlayIdx = map ? map[i] : i
    const overlay = overlays[overlayIdx]
    if (!overlay) {
      console.error(`no overlay #${overlayIdx} for base ${bases[i].base}`)
      process.exit(1)
    }
    const { base, out } = bases[i]
    const r = await flattenOne(base, out, overlay)
    const status = r.mountsOk === false ? 'FAILED FAT mount' : 'ok'
    console.log(
      `${base} + overlay#${overlayIdx} -> ${out}: wrote ${r.written} blocks [${status}]`
    )
    if (r.mountsOk === false && !force) failed = true
  }

  if (failed) {
    console.error(
      '\none or more images failed to mount — check the overlay↔base pairing ' +
        '(VMFS_OVERLAY_MAP) or pass --force to keep the output anyway.'
    )
    process.exit(2)
  }
}

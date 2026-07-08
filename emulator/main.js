import { V86 } from 'v86'

// Vite resolves these to served URLs (dev) or hashed asset URLs (build).
import wasmUrl from 'v86/build/v86.wasm?url'
import seabiosUrl from './vendor/bios/seabios.bin?url'
import vgabiosUrl from './vendor/bios/vgabios.bin?url'

// The Windows 98 disk image, self-hosted.
//
// The image is a 300 MiB disk served in 256 KiB "parts" (see use_parts below).
// The parts live in public/images/windows98/ and are downloaded from copy.sh's
// CDN by `npm run fetch-image` (scripts/fetch-image.sh) — they're gitignored
// because of their size. We self-host rather than hotlinking i.copy.sh because
// copy.sh blocks cross-origin requests by Referer (403), and the event needs a
// self-hosted image regardless (see tmp-chat-notes.md).
const IMAGE_HOST = '/images/'

const emulator = new V86({
  wasm_path: wasmUrl,
  bios: { url: seabiosUrl },
  vga_bios: { url: vgabiosUrl },

  screen_container: document.getElementById('screen_container'),

  memory_size: 128 * 1024 * 1024,
  vga_memory_size: 8 * 1024 * 1024,

  hda: {
    url: IMAGE_HOST + 'windows98/.img',
    size: 300 * 1024 * 1024,
    async: true,
    fixed_chunk_size: 256 * 1024,
    use_parts: true,
  },

  // Instant boot: restore copy.sh's saved-state snapshot (RAM + CPU frozen at a
  // settled desktop) instead of cold-booting. This is what makes copy.sh appear
  // instant. The .zst is decompressed by v86's built-in zstd. Downloaded by
  // `npm run fetch-image` alongside the disk parts.
  initial_state: { url: IMAGE_HOST + 'windows98_state-v2.bin.zst' },

  autostart: true,
})

// Minimal status wiring so it's obvious the thing is alive while it loads.
// Once the guest is running we clear it — otherwise the last "loaded — booting…"
// message just sits there forever (which it did before). download-progress keeps
// firing for lazy disk reads during normal use, so we only show it pre-start.
const status = document.getElementById('status')
const setStatus = (text) => {
  if (status) status.textContent = text
}

let running = false
emulator.add_listener(
  'emulator-loaded',
  () => !running && setStatus('booting…')
)
emulator.add_listener('emulator-started', () => {
  running = true
  setStatus('')
})
emulator.add_listener('download-progress', (e) => {
  if (running || !e.file_name || !e.total) return
  setStatus(
    `downloading ${e.file_name} — ${Math.round((100 * e.loaded) / e.total)}%`
  )
})

// Integer scaling: Win98 is pixel art, so arbitrary scaling looks mushy. We pick
// the largest whole-number multiple of the guest resolution that fits the space
// (v86 applies image-rendering: pixelated for us, so it stays crisp). Recomputed
// whenever the guest changes resolution, the window resizes, or we enter/exit
// fullscreen.
const holder = document.getElementById('screen_holder')
let guestW = 0
let guestH = 0

function rescale() {
  if (!guestW || !guestH) return
  const dpr = window.devicePixelRatio || 1

  // Available space in *device* pixels. In fullscreen the target (#screen_container)
  // covers the physical screen; and because it's inside an iframe, window.innerWidth
  // doesn't grow, so we measure against screen.* there instead of the holder.
  const fs = document.fullscreenElement != null
  const availW = (fs ? window.screen.width : holder.clientWidth) * dpr
  const availH = (fs ? window.screen.height : holder.clientHeight) * dpr

  // Crispness means an integer number of *device* pixels per guest pixel — so we
  // maximize that, not the CSS multiple (which needn't be integer). v86 maps its
  // scale param as deviceMultiple = scale * dpr^2, so invert to get the scale.
  const deviceMultiple = Math.max(
    1,
    Math.floor(Math.min(availW / guestW, availH / guestH))
  )
  const scale = deviceMultiple / (dpr * dpr)
  emulator.screen_set_scale(scale, scale)
}

emulator.add_listener('screen-set-size', ([w, h]) => {
  guestW = w
  guestH = h
  rescale()
})
window.addEventListener('resize', rescale)
document.addEventListener('fullscreenchange', rescale)

// Fullscreen the emulator + capture mouse and keyboard. screen_go_fullscreen()
// fullscreens #screen_container, locks the keyboard, and grabs the pointer
// (requestPointerLock) in one call. The parent iframe must allow both (see
// index.html at the repo root).
document.getElementById('fullscreen').addEventListener('click', () => {
  emulator.screen_go_fullscreen()
})

// Expose for poking around in the console during development.
window.emulator = emulator

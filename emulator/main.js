import { V86 } from 'v86'

// Vite resolves these to served URLs (dev) or hashed asset URLs (build).
import wasmUrl from 'v86/build/v86.wasm?url'
import seabiosUrl from './vendor/bios/seabios.bin?url'
import vgabiosUrl from './vendor/bios/vgabios.bin?url'
import {
  loadSavedState,
  saveState,
  clearSavedState,
  exportState,
  importState,
} from './persist.js'

// Our custom Windows 98 image (built in tmp-image-build/, checkpoint 03):
//   - C: (hda) — Win98 SE + absolute mouse (vbmouse) + True Color (VBEMP) + the
//     web-dev toolkit's registry/DLLs + configured desktop & home pages.
//   - D: (hdb) — the toolkit: EditPlus, Netscape (Communicator+Composer), Paint
//     Shop Pro 6, GIF Construction Set, WS_FTP LE, Flash 4.
//   - state.bin.zst — instant-boot RAM snapshot of the settled desktop.
// The disks are async: reads stream in 256 KiB chunks and guest writes go to an
// in-memory overlay that is never written back — so D: is effectively read-only and
// only C: writes matter for a submission.
//
// Base URL for these assets. Local dev serves them from /vm/ (Vite static, gitignored).
// The images are ~1.3 GB — too big for the Vercel deploy — so in production they live
// on object storage (Cloudflare R2). Point VITE_VM_BASE at that bucket's public URL;
// it MUST end in a slash and the host MUST support HTTP Range requests + CORS.
const VM = import.meta.env.VITE_VM_BASE || '/vm/'

// If the user has a saved session (IndexedDB), boot straight into it; otherwise boot
// the shipped instant-boot snapshot. Top-level await is fine in an ES module.
const savedState = await loadSavedState()

const emulator = new V86({
  wasm_path: wasmUrl,
  bios: { url: seabiosUrl },
  vga_bios: { url: vgabiosUrl },

  screen_container: document.getElementById('screen_container'),

  // Must match the values the snapshot was captured with, or restore_state fails.
  memory_size: 128 * 1024 * 1024,
  vga_memory_size: 32 * 1024 * 1024, // matches the VBEMP 032MB True Color driver

  hda: {
    url: VM + 'hda.img',
    size: 314572800,
    async: true,
    fixed_chunk_size: 256 * 1024,
  },
  hdb: {
    url: VM + 'hdb.img',
    size: 1073741824,
    async: true,
    fixed_chunk_size: 256 * 1024,
  },

  // Instant boot: restore a saved session if we have one, else the shipped
  // settled-desktop snapshot. v86's built-in zstd decompresses the shipped .zst;
  // saved sessions come in already-decompressed as a buffer.
  initial_state: savedState
    ? { buffer: savedState }
    : { url: VM + 'state.bin.zst' },

  autostart: true,
})

// Minimal status wiring so it's obvious the thing is alive while it loads.
// Once the guest is running we clear it — download-progress keeps firing for lazy
// disk reads during normal use, so we only show it pre-start.
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

// Integer scaling: Win98 is pixel art, so we draw it at the largest whole number
// of DEVICE pixels per guest pixel that fits — crisp, no mushy fractional scaling.
//
// screen_set_scale(s) does NOT map s directly to pixels: v86 folds in an internal
// per-video-mode factor (1 in SVGA/True Color, 2 in plain VGA) that is NOT the
// devicePixelRatio. So: devicePxPerGuestPx = s * modeFactor * dpr. We measure
// modeFactor (rather than assume it) whenever the mode changes, then invert.
const holder = document.getElementById('screen_holder')
const canvas = document.querySelector('#screen_container canvas')
let guestW = 0
let guestH = 0
let modeFactor = 1 // CSS px per guest px at scale 1; re-measured per video mode

function measureModeFactor() {
  if (!guestW) return
  emulator.screen_set_scale(1, 1)
  modeFactor = canvas.getBoundingClientRect().width / guestW || 1
}

function rescale() {
  if (!guestW || !guestH) return
  const dpr = window.devicePixelRatio || 1
  // Always measure the holder: whether the parent fullscreens the iframe or (standalone)
  // the holder goes fullscreen itself, the viewport grows to the screen, so the holder
  // already reflects the available space in *device* pixels.
  const availW = holder.clientWidth * dpr
  const availH = holder.clientHeight * dpr
  const deviceMultiple = Math.max(
    1,
    Math.floor(Math.min(availW / guestW, availH / guestH))
  )
  const scale = deviceMultiple / (modeFactor * dpr)
  emulator.screen_set_scale(scale, scale)
}

emulator.add_listener('screen-set-size', ([w, h]) => {
  guestW = w
  guestH = h
  measureModeFactor()
  rescale()
})
window.addEventListener('resize', rescale)
document.addEventListener('fullscreenchange', rescale)

// Fullscreen the emulator. Prefer the parent shell — it's the top-level document, so
// only it can keyboard.lock() (which lets Esc/Tab/etc reach Win98). We call it
// synchronously from this click so the user-activation (which propagates to the
// parent) is still valid for requestFullscreen. Standalone (no parent), fullscreen the
// holder ourselves. Either way NO pointer lock: the absolute-mouse driver tracks the
// host 1:1, whereas a pointer lock switches the guest to relative mouse (inverted Y,
// unnatural sensitivity).
document.getElementById('fullscreen').addEventListener('click', () => {
  let parentFn = null
  try {
    if (window.parent !== window)
      parentFn = window.parent.enterEmulatorFullscreen
  } catch {}
  if (parentFn) parentFn()
  else holder.requestFullscreen?.().catch(() => {})
})

// The parent owns the fullscreen (it's on the iframe element), so we can't see it via
// document.fullscreenElement here — it messages us instead. Hide the toolbar + rescale.
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.data?.type !== 'fullscreen') return
  document.body.classList.toggle('fs', e.data.on)
  rescale()
})

// --- State persistence --------------------------------------------------------
// Save the running session (gzip-compressed) to IndexedDB, restore it on next load
// (see the initial_state above), and export/import it as a file — the same artifact
// we'll upload to / download from the server later.
const $ = (id) => document.getElementById(id)
const clock = () =>
  new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

let saving = false
async function doSave(label = 'saved') {
  if (saving) return
  saving = true
  try {
    const bytes = await saveState(emulator)
    setStatus(`${label} ${clock()} · ${(bytes / 1e6).toFixed(1)} MB`)
  } catch (e) {
    setStatus('save failed')
    console.error(e)
  } finally {
    saving = false
  }
}

$('save')?.addEventListener('click', () => doSave())
$('export')?.addEventListener('click', () => exportState(emulator))
$('import-btn')?.addEventListener('click', () => $('import')?.click())
$('import')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0]
  if (!file) return
  setStatus('importing…')
  const ok = await importState(emulator, file)
  setStatus(ok ? `imported ${clock()}` : 'import failed (not a valid state)')
  e.target.value = ''
})
$('reset')?.addEventListener('click', async () => {
  if (!confirm('Discard your saved session and reset to the clean image?'))
    return
  await clearSavedState()
  location.reload()
})

// Autosave periodically and when the tab is hidden (best-effort before close).
setInterval(() => doSave('autosaved'), 120_000)

// Listen on the TOP document (same-origin): the iframe's own visibilitychange is
// unreliable, and the top document is the authoritative tab-visibility source. We
// prefer visibilitychange over 'blur' — blur fires on every focus change (devtools,
// alt-tab to another app, address bar), far too often for a ~65 MB save, and it also
// fires while the tab is still visible. This only fires when the tab is genuinely
// hidden (switch/minimize/close). pagehide is a best-effort catch for navigation/
// close (async may not finish there — the 2-min timer is the real safety net).
const topDoc = (() => {
  try {
    return window.top.document
  } catch {
    return document
  }
})()
topDoc.addEventListener('visibilitychange', () => {
  if (topDoc.visibilityState === 'hidden') doSave('autosaved')
})
window.addEventListener('pagehide', () => doSave('autosaved'))

// Expose for poking around in the console during development.
window.emulator = emulator

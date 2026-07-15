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
  fetchState,
} from './persist.js'
import { createFileBrowser, openLiveFs } from './vmfs/filebrowser.js'
import { createCdromControl } from './cdrom-ui.js'
import { installAtapiCdromFix } from './cdrom-atapi-fix.js'

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

// A ?share=<url> parameter turns this tab into a read-only viewer of someone else's
// exported machine: we fetch that .bin.gz and boot from it instead of the user's own
// session, autosave is disabled, and a manual save warns before it clobbers whatever
// the user had saved locally. This lets a state be handed around by URL.
const shareUrl = new URLSearchParams(location.search).get('share')

// If the user has a saved session (IndexedDB), boot straight into it; otherwise boot
// the shipped instant-boot snapshot. Top-level await is fine in an ES module.
// A shared machine wins over both — but if it fails to load we fall back to normal.
let sharedState = null
if (shareUrl) {
  try {
    const s = document.getElementById('status')
    if (s) s.textContent = 'loading shared machine…'
    sharedState = await fetchState(shareUrl)
  } catch (e) {
    console.error('shared machine failed to load:', e)
    alert(`Couldn't load the shared machine:\n${e.message}\n\nBooting normally.`)
  }
}
const isShared = !!sharedState

const savedState = isShared ? null : await loadSavedState()

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
  initial_state: sharedState
    ? { buffer: sharedState }
    : savedState
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
async function doSave(label = 'saved', { auto = false } = {}) {
  // A shared machine (?share=) isn't the user's session to persist, so drop every
  // autosave centrally here — the timer/visibility/pagehide/unload hooks below stay
  // wired unconditionally and simply no-op. Manual saves still go through (guarded by
  // their own overwrite warning on the Save button).
  if (auto && isShared) return
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

// A shared machine indicates itself in the toolbar and never autosaves. A manual save
// is still allowed, but it overwrites the user's own saved session — so we warn first.
if (isShared) $('shared-badge')?.removeAttribute('hidden')

$('save')?.addEventListener('click', () => {
  if (
    isShared &&
    !confirm(
      "You're viewing a shared machine. Saving will overwrite your own saved " +
        'machine with it. Are you sure?'
    )
  )
    return
  doSave()
})
$('export')?.addEventListener('click', () => exportState(emulator))

// Screenshot: export the guest framebuffer as a PNG with every guest pixel blown up
// to a 3×3 block (nearest-neighbour, no blur) so the pixel art reads crisply at a
// comfortable size. screen_make_screenshot() returns an <img> already at native guest
// resolution (graphics) or char-cell resolution (text mode); we just upscale it.
const SHOT_SCALE = 3
$('screenshot')?.addEventListener('click', async () => {
  const img = emulator.screen_make_screenshot()
  if (!img) return setStatus('screenshot unavailable')
  try {
    if (img.decode) await img.decode()
    else if (!img.complete)
      await new Promise((res, rej) => {
        img.onload = res
        img.onerror = rej
      })
    const c = document.createElement('canvas')
    c.width = img.naturalWidth * SHOT_SCALE
    c.height = img.naturalHeight * SHOT_SCALE
    const ctx = c.getContext('2d')
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(img, 0, 0, c.width, c.height)
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'))
    const stamp = new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[:T]/g, '-')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `like-its-1999-${stamp}.png`
    a.click()
    URL.revokeObjectURL(a.href)
    setStatus(`screenshot ${clock()}`)
  } catch (e) {
    console.error(e)
    setStatus('screenshot failed')
  }
})
$('import-btn')?.addEventListener('click', () => $('import')?.click())
$('import')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0]
  if (!file) return
  setStatus('importing…')
  const ok = await importState(emulator, file)
  setStatus(ok ? `imported ${clock()}` : 'import failed (not a valid state)')
  e.target.value = ''
})
// File browser: read the disks straight from the live VM's buffers (merges the
// guest's writes and reuses v86's chunk cache — no save_state, no re-download) and let
// the user download files / folders. Built lazily on first click, then reused; each
// disk's FAT is only read when that disk is first opened.
let browser = null
$('browse')?.addEventListener('click', async () => {
  try {
    if (!browser)
      browser = createFileBrowser({
        disks: [
          { label: 'C:\\', fs: () => openLiveFs(emulator, 'hda') },
          { label: 'D:\\', fs: () => openLiveFs(emulator, 'hdb') },
        ],
      })
    browser.open('/')
  } catch (e) {
    setStatus('browse failed: ' + e.message)
    console.error(e)
  }
})

// --- CD-ROM: user image import + preset discs ---------------------------------
// v86 always builds a secondary-master ATAPI CD-ROM device (see cpu.js), even when
// no `cdrom` is passed at boot — so emulator.set_cdrom()/eject_cdrom() just work,
// no change to the V86 config above needed. Win98 sees it as drive E:, and only one
// disc can be "in the drive" at a time, same as the real hardware this emulates. The
// toolbar button + upload/preset/dev-iso modal live in cdrom-ui.js.
//
// Preset discs are static, hosted, read-only images (built like hda.img). Mount them
// by URL (`{ url, size, async: true }`) rather than `{ buffer }` — that makes v86
// treat it like hda/hdb (an AsyncXHRBuffer whose save_state only serializes its
// sparse overlay), so a preset never gets embedded whole into every autosave.
// URL mounts only work with the ATAPI patches below — see cdrom-atapi-fix.js.
installAtapiCdromFix(emulator)
const PRESETS = [
  {
    id: 'win98se',
    label: 'Windows 98 Second Edition (E:\\win98)',
    url: VM + 'presets/win98se.iso',
    size: 655591424,
  },
]

$('cdrom-slot')?.replaceWith(
  createCdromControl({ emulator, presets: PRESETS, setStatus })
)

// Like power-cycling the PC: reboots the CPU + reloads the BIOS and clears RAM, so
// Win98 comes up from a cold start. The disks (C:, D:, and whatever's in the CD-ROM
// drive) are untouched — unlike "Reset" below, no disk state is discarded, and the
// machine boots straight back into the current C:.
//
// We must zero RAM ourselves: v86's restart() (-> cpu.reboot_internal()) deliberately
// leaves memory intact, which is a *warm* reboot. Win98 does not survive that here — it
// boots on top of the previous session's stale VMM structures and wedges (bare desktop,
// hourglass, ring-0 spin forever). Clearing RAM first turns it into a real cold boot,
// which also makes this the recovery path for a memory-corrupted session (e.g. a broken
// ?share= snapshot): the poisoned RAM is thrown away and only the clean disk survives.
$('reboot')?.addEventListener('click', () => {
  if (
    !confirm(
      'Force-reboot the machine? Unsaved work in open programs will be lost.'
    )
  )
    return
  const cpu = emulator.v86.cpu
  cpu.zero_memory(0, cpu.memory_size[0]) // cold boot: discard RAM (see above)
  emulator.restart() // synchronous — cpu.reboot_internal() has already run by the time this returns
  setStatus(`rebooted ${clock()}`)
})

$('reset')?.addEventListener('click', async () => {
  if (!confirm('Discard your saved session and reset to the clean image?'))
    return
  await clearSavedState()
  location.reload()
})

// Autosave periodically and when the tab is hidden (best-effort before close).
setInterval(() => doSave('autosaved', { auto: true }), 120_000)

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
  if (topDoc.visibilityState === 'hidden') doSave('autosaved', { auto: true })
})
window.addEventListener('pagehide', () => doSave('autosaved', { auto: true }))

// Warn before the tab actually closes/navigates away, and kick off a best-effort
// save right then too — visibilitychange usually beats us to it, but this covers
// browsers/paths where hidden fires late or not at all. beforeunload must be bound
// on the top window (closing/navigating the iframe alone doesn't leave the page).
const topWin = (() => {
  try {
    return window.top
  } catch {
    return window
  }
})()
topWin.addEventListener('beforeunload', (e) => {
  doSave('autosaved', { auto: true })
  e.preventDefault()
  e.returnValue = ''
})

// Expose for poking around in the console during development.
window.emulator = emulator

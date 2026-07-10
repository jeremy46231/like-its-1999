// A single toolbar button + <dialog> for the guest's one CD-ROM drive: mount a file
// upload (reencoded via media-import.js — images and audio/MIDI mixed freely), a
// preset disc, or (dev only) a raw .iso for testing. Styled to match
// vmfs/filebrowser.js's dialog. See main.js for why set_cdrom()/eject_cdrom() need no
// boot-time config, and why presets mount by URL while uploads mount as a buffer.
import { buildMediaCdrom } from './media-import.js'
import { buildIso9660 } from './vmfs/iso9660.js'
import { uniqueBaseName } from './iso-name.js'

const CSS = `
.cdrom-dialog { width: min(420px, 92vw); padding: 0; border: 1px solid #888; background: #fff; color: #111; font: 13px system-ui, sans-serif; }
.cdrom-dialog::backdrop { background: rgba(0,0,0,.4); }
.cdrom-body { display: flex; flex-direction: column; }
.cdrom-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid #ddd; }
.cdrom-head .title { flex: 1; font-weight: bold; }
.cdrom-section { padding: 10px; border-bottom: 1px solid #eee; display: flex; flex-direction: column; gap: 6px; }
.cdrom-section .label { font-weight: bold; }
.cdrom-section .hint { color: #888; }
.cdrom-row { display: flex; gap: 6px; align-items: center; }
.cdrom-row select { flex: 1; }
.cdrom-foot { display: flex; gap: 8px; padding: 8px 10px; }
.cdrom-foot .msg { flex: 1; color: #888; align-self: center; }
.cdrom-dialog button { cursor: pointer; }
.cdrom-dialog button[disabled], .cdrom-dialog input[disabled] { opacity: .5; cursor: default; }
.cdrom-body .cdrom-section:last-of-type { border-bottom: none; }
`

function injectStyles() {
  if (document.getElementById('cdrom-style')) return
  const el = document.createElement('style')
  el.id = 'cdrom-style'
  el.textContent = CSS
  document.head.appendChild(el)
}

// `presets`: [{ id, label, url, size }, ...]. `setStatus`: the toolbar status line.
export function createCdromControl({ emulator, presets = [], setStatus = () => {} }) {
  injectStyles()

  const btn = document.createElement('button')
  btn.type = 'button'
  let mounted = false
  let busy = false
  const renderBtn = () => {
    btn.textContent = mounted ? 'Eject CD' : 'Mount CD'
    btn.disabled = busy
  }
  renderBtn()

  // A restored saved session can already have a disc in the drive before this
  // control ever runs a mount() itself (see persist.js) — sync the label once the
  // emulator's devices actually exist, so "Mount CD" doesn't lie about an
  // already-inserted disc. Same internal-reach pattern as vmfs/blockdev.js's
  // openLiveFs (there's no public V86 API for "is a disc currently in the drive").
  emulator.add_listener('emulator-started', () => {
    if (emulator.v86?.cpu?.devices?.cdrom?.has_disk?.()) {
      mounted = true
      renderBtn()
    }
  })

  const dialog = document.createElement('dialog')
  dialog.className = 'cdrom-dialog'
  dialog.innerHTML = `
    <div class="cdrom-body">
      <div class="cdrom-head">
        <span class="title">Mount CD (E:\\)</span>
        <button data-close>Close</button>
      </div>
      <div class="cdrom-section" data-files-section>
        <span class="label">Upload files</span>
        <span class="hint">Images: .png, .jpg, .gif (animated), .webp, .bmp</span>
        <span class="hint">Audio: .mp3, .wav, .ogg, .mid</span>
        <input type="file" accept="image/*,audio/*,.mid,.midi" multiple data-files />
      </div>
    </div>`
  document.body.appendChild(dialog)

  const body = dialog.querySelector('.cdrom-body')
  const $ = (sel) => dialog.querySelector(sel)
  const mountControlsExtra = [] // dev-only controls append themselves here

  if (presets.length) {
    const section = document.createElement('div')
    section.className = 'cdrom-section'
    section.innerHTML = `
      <span class="label">Preset discs</span>
      <div class="cdrom-row">
        <select data-preset></select>
        <button data-mount-preset>Mount</button>
      </div>`
    const select = section.querySelector('select')
    for (const p of presets) {
      const opt = document.createElement('option')
      opt.value = p.id
      opt.textContent = p.label
      select.append(opt)
    }
    body.append(section)
  }

  // import.meta.env.DEV is inlined + dead-code-eliminated by Vite in production —
  // this whole section (and the listener behind it) never ships.
  if (import.meta.env.DEV) {
    const section = document.createElement('div')
    section.className = 'cdrom-section'
    section.innerHTML = `
      <span class="label">Load .iso (dev only)</span>
      <input type="file" accept=".iso" data-iso />`
    body.append(section)
  }

  // Dev-only escape hatch on "Upload files" above: skip the reencode entirely and
  // put raw file bytes straight onto the disc, unsanitized — for testing against
  // files that specifically shouldn't survive the real pipeline (e.g. verifying a
  // renamed non-image actually gets rejected by the real path, by comparing against
  // what raw passthrough does instead). import.meta.env.DEV strips this whole block,
  // including buildRawCdrom, from production.
  let prepareFiles = (files) => buildMediaCdrom(files)
  if (import.meta.env.DEV) {
    const label = document.createElement('label')
    label.innerHTML = '<input type="checkbox" data-skip-reencode /> Skip reencode (dev only)'
    $('[data-files-section]').append(label)
    const skipReencodeCheckbox = label.querySelector('[data-skip-reencode]')
    mountControlsExtra.push(skipReencodeCheckbox)

    const buildRawCdrom = async (files) => {
      const used = new Set()
      const entries = []
      for (const file of files) {
        const dot = file.name.lastIndexOf('.')
        const ext = dot === -1 ? 'BIN' : file.name.slice(dot + 1)
        const data = new Uint8Array(await file.arrayBuffer())
        entries.push({ name: `${uniqueBaseName(file.name, used)}.${ext}`, data })
      }
      return buildIso9660({ volumeLabel: 'RAW', files: entries })
    }

    prepareFiles = (files) =>
      skipReencodeCheckbox.checked ? buildRawCdrom(files) : buildMediaCdrom(files)
  }

  const foot = document.createElement('div')
  foot.className = 'cdrom-foot'
  foot.innerHTML = '<span class="msg"></span>'
  body.append(foot)
  const setMsg = (t) => (foot.querySelector('.msg').textContent = t || '')

  // Controls that kick off a mount — disabled while one is in flight so a slow
  // reencode can't be left to resolve in the background and clobber whatever gets
  // mounted afterward. (Belt-and-suspenders: the generation counter below is what
  // actually guarantees correctness even if one of these somehow fires anyway.)
  const mountControls = [
    $('[data-files]'),
    $('[data-mount-preset]'),
    $('[data-preset]'),
    $('[data-iso]'),
    ...mountControlsExtra,
  ].filter(Boolean)
  const setBusy = (b) => {
    busy = b
    renderBtn()
    for (const el of mountControls) el.disabled = b
  }

  $('[data-close]').addEventListener('click', () => dialog.close())

  // Monotonic token identifying the "current" mount/eject action. A mount() only
  // applies its result if it's still current when it finishes — otherwise a newer
  // action (another mount, or an explicit eject) has already superseded it, and
  // applying a stale result anyway is exactly the "closed the dialog on the files
  // upload, mounted the preset instead, then the files upload finished late and
  // silently overwrote it" bug this fixes.
  let generation = 0

  // `prepare` does the slow, cancellable-in-effect part (reencoding, or just an
  // arrayBuffer() read); `apply` does the actual emulator.set_cdrom() call, which is
  // effectively instant for every caller below.
  async function mount(prepare, apply, label) {
    const myGen = ++generation
    setBusy(true)
    setMsg(`mounting ${label}…`)
    try {
      const prepared = await prepare()
      if (myGen !== generation) return // superseded — drop this result entirely

      // v86 raises the guest's media-change interrupt on eject() but not on a plain
      // insert (checked tmp-v86/src/ide.js: set_disk_buffer(), used by set_cdrom()
      // for every insert, never calls push_irq() — only eject() does). Swapping
      // straight from one disc to another can leave the guest not proactively
      // notified, only discovering the new disc whenever it happens to re-poll on
      // its own — which is the "E: sometimes shows empty" bug. Ejecting first
      // guarantees an interrupt actually fires. Safe unconditionally: eject() is a
      // no-op if the drive's already empty.
      emulator.eject_cdrom()
      await apply(prepared)
      if (myGen !== generation) return // superseded mid-apply

      mounted = true
      setStatus(`mounted ${label}`)
      dialog.close()
    } catch (e) {
      if (myGen !== generation) return // don't report a stale error over a newer action
      mounted = false
      setMsg('error: ' + e.message)
      console.error(e)
    } finally {
      if (myGen === generation) setBusy(false)
    }
  }

  $('[data-files]').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) return
    mount(
      () => prepareFiles(files),
      (iso) => emulator.set_cdrom({ buffer: iso.buffer }),
      `${files.length} file(s)`
    )
  })

  $('[data-mount-preset]')?.addEventListener('click', () => {
    const preset = presets.find((p) => p.id === $('[data-preset]').value)
    if (!preset) return
    mount(
      () => preset,
      (p) =>
        emulator.set_cdrom({
          url: p.url,
          size: p.size,
          async: true,
          fixed_chunk_size: 256 * 1024,
        }),
      preset.label
    )
  })

  $('[data-iso]')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    mount(
      () => file.arrayBuffer(),
      (buffer) => emulator.set_cdrom({ buffer }),
      file.name
    )
  })

  btn.addEventListener('click', () => {
    if (busy) return
    if (mounted) {
      generation++ // invalidate any in-flight mount so it can't clobber this eject
      emulator.eject_cdrom()
      mounted = false
      renderBtn()
      setStatus('CD ejected')
    } else {
      setMsg('')
      dialog.showModal()
    }
  })

  return btn
}

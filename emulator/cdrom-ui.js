// A single toolbar button + <dialog> for the guest's one CD-ROM drive: mount a file
// upload (reencoded via media-import.js — images and audio/MIDI mixed freely), a
// preset disc, or (dev only) a raw .iso for testing. Styled to match
// vmfs/filebrowser.js's dialog. See main.js for why set_cdrom()/eject_cdrom() need no
// boot-time config, and why presets mount by URL while uploads mount as a buffer.
import { buildMediaCdrom } from './media-import.js'

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
  const renderBtn = () => (btn.textContent = mounted ? 'Eject CD' : 'Mount CD')
  renderBtn()

  const dialog = document.createElement('dialog')
  dialog.className = 'cdrom-dialog'
  dialog.innerHTML = `
    <div class="cdrom-body">
      <div class="cdrom-head">
        <span class="title">Mount CD (E:\\)</span>
        <button data-close>Close</button>
      </div>
      <div class="cdrom-section">
        <span class="label">Upload files</span>
        <span class="hint">Images: .png, .jpg, .gif (animated), .webp, .bmp</span>
        <span class="hint">Audio: .mp3, .wav, .ogg, .mid</span>
        <input type="file" accept="image/*,audio/*,.mid,.midi" multiple data-files />
      </div>
    </div>`
  document.body.appendChild(dialog)

  const body = dialog.querySelector('.cdrom-body')
  const $ = (sel) => dialog.querySelector(sel)

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

  const foot = document.createElement('div')
  foot.className = 'cdrom-foot'
  foot.innerHTML = '<span class="msg"></span>'
  body.append(foot)
  const setMsg = (t) => (foot.querySelector('.msg').textContent = t || '')

  $('[data-close]').addEventListener('click', () => dialog.close())

  async function mount(doMount, label) {
    setMsg(`mounting ${label}…`)
    try {
      await doMount()
      mounted = true
      renderBtn()
      setStatus(`mounted ${label}`)
      dialog.close()
    } catch (e) {
      setMsg('error: ' + e.message)
      console.error(e)
    }
  }

  $('[data-files]').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) return
    await mount(async () => {
      const iso = await buildMediaCdrom(files)
      await emulator.set_cdrom({ buffer: iso.buffer })
    }, `${files.length} file(s)`)
  })

  $('[data-mount-preset]')?.addEventListener('click', () => {
    const preset = presets.find((p) => p.id === $('[data-preset]').value)
    if (!preset) return
    mount(
      () =>
        emulator.set_cdrom({
          url: preset.url,
          size: preset.size,
          async: true,
          fixed_chunk_size: 256 * 1024,
        }),
      preset.label
    )
  })

  $('[data-iso]')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    await mount(
      async () => emulator.set_cdrom({ buffer: await file.arrayBuffer() }),
      file.name
    )
  })

  btn.addEventListener('click', () => {
    if (mounted) {
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

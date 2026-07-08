// v86 state persistence.
//
// A save_state() is ~65 MB raw (128 MB RAM + disk overlay), so this does NOT use
// localStorage (5-10 MB, strings only) — it uses IndexedDB, which stores binary
// ArrayBuffers directly with a large disk-backed quota. States are gzip-compressed
// (native CompressionStream) before storage so they're small on disk and ready to
// hand off / upload as-is.
//
// A saved state is only valid against the exact disks + memory config it was captured
// with, so each save is tagged with IMAGE_ID — bump it whenever the base image
// (public/vm/) changes so stale, incompatible saves are ignored instead of crashing
// the restore.
export const IMAGE_ID = 'win98-checkpoint03-v1'

const DB_NAME = 'like-its-99'
const STORE = 'vm'
const KEY = 'state'
const STATE_MAGIC = 0x86768676 // v86 state header magic; sanity-checks decompression

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbGet(key) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbSet(key, value) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function idbDel(key) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function gzip(buffer) {
  const cs = new CompressionStream('gzip')
  const stream = new Response(buffer).body.pipeThrough(cs)
  return new Response(stream).arrayBuffer()
}

async function gunzip(buffer) {
  const ds = new DecompressionStream('gzip')
  const stream = new Response(buffer).body.pipeThrough(ds)
  return new Response(stream).arrayBuffer()
}

function looksLikeState(buffer) {
  if (!buffer || buffer.byteLength < 16) return false
  return new Int32Array(buffer, 0, 1)[0] >>> 0 === STATE_MAGIC
}

// Returns the decompressed state ArrayBuffer to boot from, or null (→ ship snapshot).
export async function loadSavedState() {
  try {
    const rec = await idbGet(KEY)
    if (!rec || rec.imageId !== IMAGE_ID) return null
    const raw = await gunzip(rec.gz)
    return looksLikeState(raw) ? raw : null
  } catch {
    return null
  }
}

// Capture + compress + store. Returns the compressed byte length.
export async function saveState(emulator) {
  const raw = await emulator.save_state()
  const gz = await gzip(raw)
  await idbSet(KEY, { imageId: IMAGE_ID, gz, at: Date.now() })
  return gz.byteLength
}

export async function clearSavedState() {
  await idbDel(KEY)
}

// Download the current state as a gzipped file — the same artifact we'd upload to
// the server or hand to someone else.
export async function exportState(emulator) {
  const raw = await emulator.save_state()
  const gz = await gzip(raw)
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([gz], { type: 'application/gzip' }))
  a.download = 'like-its-1999-state.bin.gz'
  a.click()
  URL.revokeObjectURL(a.href)
}

// Load a state file (gzipped or raw), restore it live, and persist it. Returns true
// on success. Used to receive a passed-around / downloaded state.
export async function importState(emulator, file) {
  let raw = await file.arrayBuffer()
  const isGzip = new Uint8Array(raw, 0, 2)
  if (isGzip[0] === 0x1f && isGzip[1] === 0x8b) raw = await gunzip(raw)
  if (!looksLikeState(raw)) return false
  await emulator.restore_state(raw)
  await idbSet(KEY, { imageId: IMAGE_ID, gz: await gzip(raw), at: Date.now() })
  return true
}

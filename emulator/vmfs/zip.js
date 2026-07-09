// A tiny isomorphic ZIP writer — enough to package an extracted directory tree.
// Supports STORE (no compression) and DEFLATE. Deflate uses CompressionStream in the
// browser and node:zlib in Node; if neither is available it falls back to STORE.
// No ZIP64 (fine for the small trees we export here).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++)
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

async function deflateRaw(bytes) {
  if (typeof CompressionStream !== 'undefined') {
    try {
      const cs = new CompressionStream('deflate-raw')
      const stream = new Response(bytes).body.pipeThrough(cs)
      return new Uint8Array(await new Response(stream).arrayBuffer())
    } catch {
      /* fall through */
    }
  }
  try {
    const { deflateRawSync } = await import('node:zlib')
    return new Uint8Array(deflateRawSync(bytes))
  } catch {
    return null // no deflate available → caller uses STORE
  }
}

// DOS date/time from an ISO-ish "YYYY-MM-DDTHH:MM:SS" string (or now-ish default).
function dosDateTime(iso) {
  let y = 1980,
    mo = 1,
    d = 1,
    h = 0,
    mi = 0,
    s = 0
  const m = iso && /^(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)/.exec(iso)
  if (m) [, y, mo, d, h, mi, s] = m.map(Number)
  const date =
    (((Math.max(1980, y) - 1980) & 0x7f) << 9) | ((mo & 0xf) << 5) | (d & 0x1f)
  const time = ((h & 0x1f) << 11) | ((mi & 0x3f) << 5) | ((s >> 1) & 0x1f)
  return { date, time }
}

const enc = new TextEncoder()

function u16(n) {
  return [n & 0xff, (n >> 8) & 0xff]
}
function u32(n) {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]
}

export class ZipWriter {
  constructor({ compress = true } = {}) {
    this.compress = compress
    this.files = [] // {nameBytes, crc, csize, usize, method, date, time, data, offset}
    this.chunks = []
    this.offset = 0
  }

  _push(arr) {
    const u = arr instanceof Uint8Array ? arr : new Uint8Array(arr)
    this.chunks.push(u)
    this.offset += u.length
  }

  // Add a file. `data` is a Uint8Array. `name` uses forward slashes.
  async add(name, data, mtime) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    const nameBytes = enc.encode(name)
    const crc = crc32(bytes)
    let method = 0
    let stored = bytes
    if (this.compress && bytes.length > 0) {
      const def = await deflateRaw(bytes)
      if (def && def.length < bytes.length) {
        method = 8
        stored = def
      }
    }
    const { date, time } = dosDateTime(mtime)
    const rec = {
      nameBytes,
      crc,
      csize: stored.length,
      usize: bytes.length,
      method,
      date,
      time,
      offset: this.offset,
    }
    this.files.push(rec)

    // Local file header.
    this._push([
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(method),
      ...u16(time),
      ...u16(date),
      ...u32(crc),
      ...u32(rec.csize),
      ...u32(rec.usize),
      ...u16(nameBytes.length),
      ...u16(0),
    ])
    this._push(nameBytes)
    this._push(stored)
  }

  // Finish and return the complete ZIP as a Uint8Array.
  finish() {
    const cdStart = this.offset
    for (const f of this.files) {
      this._push([
        ...u32(0x02014b50),
        ...u16(20),
        ...u16(20),
        ...u16(0),
        ...u16(f.method),
        ...u16(f.time),
        ...u16(f.date),
        ...u32(f.crc),
        ...u32(f.csize),
        ...u32(f.usize),
        ...u16(f.nameBytes.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(f.offset),
      ])
      this._push(f.nameBytes)
    }
    const cdSize = this.offset - cdStart
    this._push([
      ...u32(0x06054b50),
      ...u16(0),
      ...u16(0),
      ...u16(this.files.length),
      ...u16(this.files.length),
      ...u32(cdSize),
      ...u32(cdStart),
      ...u16(0),
    ])

    const total = this.offset
    const out = new Uint8Array(total)
    let pos = 0
    for (const c of this.chunks) {
      out.set(c, pos)
      pos += c.length
    }
    return out
  }
}

// Convenience: package a FatFs.walk() tree into a ZIP. `fs` is a FatFs, `tree` is the
// result of fs.walk(path). Entry names are made relative to the tree root, prefixed
// with the root folder's own name so the zip contains one top-level folder.
export async function zipTree(fs, tree, { compress = true } = {}) {
  const zip = new ZipWriter({ compress })
  const rootName = tree.name && tree.name !== '/' ? tree.name : 'root'
  const add = async (node, prefix) => {
    for (const f of node.files) {
      const bytes = await fs.readFile(f.path)
      await zip.add(`${prefix}/${f.name}`, bytes, f.mtime)
    }
    for (const d of node.dirs) await add(d, `${prefix}/${d.name}`)
  }
  await add(tree, rootName)
  return zip.finish()
}

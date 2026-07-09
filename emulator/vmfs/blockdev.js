// A read-only block device that presents a base disk image with a v86 overlay
// painted on top — the disk exactly as the guest saw it when the state was saved.
//
// The base is any BaseSource: an object with `readRange(offset, length) ->
// Promise<Uint8Array>` and optionally a `size`. Overlay blocks (guest writes) are
// served from memory; everything else is read from the base. Reads from the base are
// coalesced into the fewest contiguous ranges possible, so when the base is a remote
// URL we issue the minimum number of Range requests and never fetch a byte we don't
// need.

export class OverlayBlockDevice {
  // overlay: DiskOverlay | null. base: BaseSource. blockSize defaults to overlay's.
  constructor(base, overlay, blockSize) {
    this.base = base
    this.overlay = overlay || null
    this.blockSize = blockSize || overlay?.blockSize || 256
    this.bytesFetched = 0
    this.rangeRequests = 0
  }

  get size() {
    return this.base.size ?? 0
  }

  // Read [offset, offset+length) as a single Uint8Array.
  async read(offset, length) {
    const out = new Uint8Array(length)
    const bs = this.blockSize
    const first = Math.floor(offset / bs)
    const last = Math.floor((offset + length - 1) / bs)

    // Figure out which whole blocks are missing from the overlay, then read them
    // from the base in coalesced runs. Blocks present in the overlay are painted in
    // afterward. We fetch base data block-aligned so the copy math stays simple.
    let runStart = -1
    const runs = []
    for (let b = first; b <= last; b++) {
      const missing = !this.overlay || !this.overlay.hasBlock(b)
      if (missing && runStart === -1) runStart = b
      if (!missing && runStart !== -1) {
        runs.push([runStart, b - 1])
        runStart = -1
      }
    }
    if (runStart !== -1) runs.push([runStart, last])

    for (const [rs, re] of runs) {
      const rOff = rs * bs
      const rLen = (re - rs + 1) * bs
      const data = await this.#baseRead(rOff, rLen)
      // Copy the requested slice of this run into out.
      const copyStart = Math.max(offset, rOff)
      const copyEnd = Math.min(offset + length, rOff + rLen)
      out.set(
        data.subarray(copyStart - rOff, copyEnd - rOff),
        copyStart - offset
      )
    }

    // Paint overlay blocks over the result.
    if (this.overlay) {
      for (let b = first; b <= last; b++) {
        const blk = this.overlay.block(b)
        if (!blk) continue
        const bOff = b * bs
        const copyStart = Math.max(offset, bOff)
        const copyEnd = Math.min(offset + length, bOff + bs)
        out.set(
          blk.subarray(copyStart - bOff, copyEnd - bOff),
          copyStart - offset
        )
      }
    }

    return out
  }

  async #baseRead(offset, length) {
    // Clamp to the base size if known (the last block may run past the end).
    let len = length
    if (this.base.size != null)
      len = Math.min(len, Math.max(0, this.base.size - offset))
    if (len <= 0) return new Uint8Array(length)
    const data = await this.base.readRange(offset, len)
    this.bytesFetched += data.length
    this.rangeRequests += 1
    if (len === length) return data
    // Pad the tail (past EOF) with zeros so callers always get `length` bytes.
    const padded = new Uint8Array(length)
    padded.set(data, 0)
    return padded
  }
}

// BaseSource backed by a local file (Node). Uses a file handle + positional reads,
// so only the requested ranges ever touch disk.
export async function nodeFileSource(path) {
  const fs = await import('node:fs/promises')
  const handle = await fs.open(path, 'r')
  const { size } = await handle.stat()
  return {
    size,
    async readRange(offset, length) {
      const buf = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(buf, 0, length, offset)
      return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead)
    },
    async close() {
      await handle.close()
    },
  }
}

// BaseSource backed by an HTTP URL that supports Range requests (browser or Node).
// `size` is discovered lazily from the first ranged response's Content-Range.
export function httpRangeSource(url, knownSize) {
  let size = knownSize ?? null
  return {
    get size() {
      return size
    },
    async readRange(offset, length) {
      const end = offset + length - 1
      const res = await fetch(url, {
        headers: { Range: `bytes=${offset}-${end}` },
      })
      if (res.status !== 206 && res.status !== 200)
        throw new Error(`range fetch failed: HTTP ${res.status} for ${url}`)
      if (size == null) {
        const cr = res.headers.get('content-range')
        const m = cr && /\/(\d+)$/.exec(cr)
        if (m) size = parseInt(m[1], 10)
      }
      return new Uint8Array(await res.arrayBuffer())
    },
  }
}

// A FatFs device backed by a *running* v86 emulator's disk buffer.
//
// This is the efficient path for browsing the live VM: v86's `buffer.get()` already
// merges the guest's writes over the base image AND reuses the emulator's own chunk
// cache — so we don't save_state, don't parse an overlay, and don't re-download bytes
// the VM already has. It also reflects unsaved changes. v86 requires 256-byte-aligned
// reads, so we align to the block boundary and slice the result.
//
// `buffer` is emulator.v86.cpu.devices.ide.primary.master.buffer (C:) etc. Unlike the sources
// above this is a complete device (it exposes `read`, not `readRange`) because the
// overlay is already baked into what `get()` returns.
export function v86Device(buffer, size = buffer.byteLength) {
  const ALIGN = 256
  return {
    size,
    read(offset, length) {
      const start = Math.floor(offset / ALIGN) * ALIGN
      const end = Math.min(size, Math.ceil((offset + length) / ALIGN) * ALIGN)
      return new Promise((resolve) => {
        buffer.get(start, end - start, (data) => {
          const from = offset - start
          resolve(data.subarray(from, from + length))
        })
      })
    },
  }
}

// BaseSource backed by an in-memory buffer (tests, or an already-loaded image).
export function bufferSource(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  return {
    size: bytes.length,
    async readRange(offset, length) {
      return bytes.subarray(offset, offset + length)
    },
  }
}

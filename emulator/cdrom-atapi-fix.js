// Runtime patches to v86's ATAPI CD-ROM emulation (v86 src/ide.js), applied to the
// IDEInterface prototype reached through the live cdrom device. Together they fix
// "mount a disc → E:\ stays empty" failures that in practice only hit URL-mounted
// (async) presets; file uploads mount as fully in-memory SyncBuffers and dodge every
// one of these by accident. See cdrom-ui.js for the mount paths that depend on this.
//
// Bug 1 — Win98 never notices a disc swap. v86's TEST UNIT READY answers GOOD
// whenever a disc is present, and its `medium_changed` flag is only ever consumed
// by ATA GET MEDIA STATUS (0xDA), which Win98 never issues — it detects media
// changes purely by polling TEST UNIT READY (~every 4 s) and watching for a
// not-ready → ready transition. Our mount flow ejects and re-inserts in the same
// tick, so no poll ever observes the empty drive and Windows keeps believing
// whatever it already believed about the disc. Real ATAPI drives answer the first
// TEST UNIT READY after a media change with CHECK CONDITION / UNIT ATTENTION /
// "medium may have changed" (sense key 6, additional sense 0x28), and Win98 relies
// on exactly that; patch 1 adds that response.
//
// Bug 2 — Win98 kills async reads. For an async buffer, v86 answers a READ(10) by
// holding status = BSY until the XHR lands. Win98's PIO CD driver polls status
// twice, sees BSY, and immediately issues DEVICE RESET — real drives never expose
// a long busy data phase (a cold drive instead fails fast with "becoming ready"
// and lets the OS retry), so the driver has no patient path we could appeal to:
// experimentally, BSY (0xD0 or 0x80) earns an instant reset, and a clean
// not-ready error earns a ~30-shot retry burst within 250 ms before CDFS reports
// failure up the stack. On a slow network every variant ends with E:\ looking
// empty. The fix (patch 2) makes the wait invisible instead: on a cache miss we
// force the virtual CPU into v86's HLT state — checked between single
// instructions, so the driver never gets to poll at all — kick off the chunk
// fetch, and on arrival re-dispatch the same packet (this.data still holds it)
// against the now-warm cache, which completes synchronously with the normal DRQ +
// IRQ. The guest experiences a zero-length wait no matter the network latency;
// the human sees the VM pause briefly on cold reads, like an old drive seeking.
// Timer interrupts may wake the halted CPU early (that's also what un-wedges a
// session that got saved mid-fetch), so a reset can still sneak in — the
// generation counter below drops the stale re-dispatch and the guest's own retry
// then hits the warm cache, thanks to patches 3 and 4.
//
// Bug 3 — v86's reset handler aborts in-flight XHRs, so before these patches each
// reset threw away the very fetch the retry needed, and every retry started
// another doomed cold read. Patch 3 orphans pending reads instead of aborting:
// guest-facing callbacks are dropped through v86's existing cancelled-id
// plumbing, but the XHRs complete and populate the chunk cache.
//
// Bug 4 — the abort was also v86's only duplicate-request limiter (it has no
// in-flight dedup of range fetches). Without patch 4, any retry loop starts a new
// XHR for a chunk that's already downloading; on a link slower than the retry
// cadence the browser's request queue grows without bound while every queued
// request still transfers a full redundant chunk — observed melting a laptop with
// millions of requests under devtools "Slow 4G". Patch 4 makes an identical
// concurrent request join the existing fetch instead. ATAPI allows a single
// outstanding command, so the in-flight set stays tiny.
//
// The prototype patches key off `this.is_atapi`, so the hard disks' IDE
// interfaces (which share the prototype) keep stock behavior.

export function installAtapiCdromFix(emulator) {
  emulator.add_listener('emulator-started', () => {
    // Same internal-reach caveat as elsewhere: there's no public API for any of
    // this, so feature-detect every internal we touch and degrade to stock
    // behavior (presets mount unreliably, uploads still fine) if a v86 upgrade
    // moves the furniture.
    const cdrom = emulator.v86?.cpu?.devices?.cdrom
    if (!cdrom) return
    const proto = Object.getPrototypeOf(cdrom)
    if (proto.__atapiCdromFixInstalled) return
    const ok =
      typeof proto.atapi_handle === 'function' &&
      typeof proto.atapi_check_condition_response === 'function' &&
      typeof proto.cancel_io_operations === 'function' &&
      typeof proto.set_cdrom === 'function' &&
      typeof proto.eject === 'function' &&
      typeof proto.push_irq === 'function' &&
      'medium_changed' in cdrom &&
      cdrom.in_progress_io_ids instanceof Map &&
      cdrom.cancelled_io_ids instanceof Set
    if (!ok) {
      console.warn(
        'cdrom-atapi-fix: v86 internals changed, patches not applied'
      )
      return
    }
    proto.__atapiCdromFixInstalled = true

    // Bumped by anything that invalidates an in-flight command (reset, eject,
    // disc swap) so a halt-fetch that raced one of those won't complete a
    // command the guest has since abandoned.
    let generation = 0

    const cachedRead = (buffer, start, len) => {
      try {
        return buffer.get_from_cache(start, len)
      } catch {
        return null
      }
    }

    const origAtapiHandle = proto.atapi_handle
    proto.atapi_handle = function () {
      const cmd = this.data[0]

      // Patch 1: first TEST UNIT READY (packet byte 0 === 0) after an insert
      // reports UNIT ATTENTION / "medium may have changed", once. Mirrors what
      // v86's own "command without medium" branch does: check-condition response
      // + IRQ, skipping the normal command dispatch entirely.
      if (this.is_atapi && this.buffer && this.medium_changed && cmd === 0) {
        this.medium_changed = false
        this.data_pointer = 0
        this.current_atapi_command = 0
        this.atapi_check_condition_response(6, 0x28)
        this.push_irq()
        return
      }

      // Patch 2: READ(10)/READ(12) that misses the chunk cache — halt the CPU,
      // fetch, re-dispatch warm. Sync buffers have no get_from_cache and fall
      // through to the stock (always-synchronous) path.
      if (
        (cmd === 0x28 || cmd === 0xa8) &&
        this.is_atapi &&
        this.buffer &&
        typeof this.buffer.get_from_cache === 'function' &&
        this.cpu?.in_hlt
      ) {
        const lba =
          ((this.data[2] << 24) |
            (this.data[3] << 16) |
            (this.data[4] << 8) |
            this.data[5]) >>>
          0
        const count =
          cmd === 0xa8
            ? ((this.data[6] << 24) |
                (this.data[7] << 16) |
                (this.data[8] << 8) |
                this.data[9]) >>>
              0
            : (this.data[7] << 8) | this.data[8]
        const start = lba * this.sector_size
        const len = count * this.sector_size
        if (
          len > 0 &&
          start + len <= this.buffer.byteLength &&
          !cachedRead(this.buffer, start, len)
        ) {
          const myGen = ++generation
          // BSY for the handful of instructions that can still run before the
          // halt lands — the same interim status stock v86 shows.
          this.status_reg = 0xd0
          this.cpu.in_hlt[0] = 1
          this.buffer.get(start, len, () => {
            if (generation === myGen) origAtapiHandle.call(this)
            this.cpu.in_hlt[0] = 0
          })
          return
        }
      }

      return origAtapiHandle.call(this)
    }

    // Patch 3: on device reset, orphan the pending reads instead of aborting
    // them. Marking the ids cancelled makes read_buffer drop the guest callback
    // when the response lands (v86 already has that plumbing); not calling
    // abort() lets the response land at all, which fills the chunk cache for the
    // guest's retry.
    const origCancel = proto.cancel_io_operations
    proto.cancel_io_operations = function () {
      if (!this.is_atapi) return origCancel.call(this)
      generation++
      for (const id of this.in_progress_io_ids.keys())
        this.cancelled_io_ids.add(id)
      this.in_progress_io_ids.clear()
    }

    const origEject = proto.eject
    proto.eject = function () {
      if (this.is_atapi) generation++
      return origEject.call(this)
    }

    // Patch 4: dedup the disc buffer's range fetches. set_cdrom() is the only way
    // any disc buffer enters the drive (a reload comes back with an empty drive,
    // so restores don't bypass it), which makes it the one choke point where we
    // can wrap the buffer's get(). Identical concurrent requests share one fetch;
    // every requester's callback still runs. Synchronous buffers (uploads) pass
    // through the same wrapper unharmed — get() completes inline, so the
    // in-flight window is zero.
    const origSetCdrom = proto.set_cdrom
    proto.set_cdrom = function (buffer) {
      if (this.is_atapi) generation++
      if (buffer && typeof buffer.get === 'function' && !buffer.__cdromDedup) {
        buffer.__cdromDedup = true
        const origGet = buffer.get.bind(buffer)
        const inflight = new Map()
        buffer.get = (offset, length, fn, options) => {
          const key = offset + ':' + length
          const waiters = inflight.get(key)
          if (waiters) {
            waiters.push(fn)
            return
          }
          inflight.set(key, [fn])
          origGet(
            offset,
            length,
            (data) => {
              const done = inflight.get(key)
              inflight.delete(key)
              for (const w of done) w(data)
            },
            options
          )
        }
      }
      return origSetCdrom.call(this, buffer)
    }
  })
}

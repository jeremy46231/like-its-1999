// Re-encode one uploaded font file (see media-import.js, which routes uploads to the
// three pipelines by extension). Same reencode-not-passthrough model as
// image-import.js / audio-import.js: fonteditor-core parses the font into its
// table/glyph object model and we serialize a fresh font from that model — a renamed
// non-font fails to parse and is rejected, and the re-emit keeps only the tables it
// understands (glyf outlines, cmap, metrics, name), dropping hint bytecode, DSIG,
// GPOS/GSUB, embedded bitmaps and any unknown table wholesale. Only decoded glyph data
// makes the trip, never the original bytes.
//
// Output is ALWAYS a glyf-based TrueType (.TTF) — the one outline flavor Win98's GDI
// rasterizes universally. The important consequence: CFF/PostScript OpenType (.otf,
// and CFF-flavored .woff/.woff2) is converted cubic->quadratic into glyf, because
// Win98 cannot render OpenType-CFF (OTTO) at all. WOFF/WOFF2 are just compressed sfnt
// wrappers, so they decompress and convert through the same path.

// fonteditor-core doesn't expose its woff2 brotli wasm through its package "exports"
// map, so reach the asset by relative path: Vite emits it as a hashed asset and hands
// back its URL, which is exactly what woff2.init() wants. This is just a string at
// module-eval time — the wasm itself isn't fetched until a woff2 upload triggers init.
import woff2WasmUrl from '../node_modules/fonteditor-core/woff2/woff2.wasm?url'

// fonteditor-core (+ its wasm) is heavy, so load it lazily on first font upload rather
// than pulling it into the initial bundle every visitor downloads.
let corePromise
const loadCore = () => (corePromise ??= import('fonteditor-core'))

// The brotli wasm behind woff2 decoding must be initialised once before Font.create
// can read a .woff2. Memoized so repeated woff2 uploads don't re-init.
let woff2Promise
const ensureWoff2 = (woff2) => (woff2Promise ??= woff2.init(woff2WasmUrl))

// Dispatch (media-import.js) already guaranteed one of these four extensions.
const TYPE_BY_EXT = { ttf: 'ttf', otf: 'otf', woff: 'woff', woff2: 'woff2' }

// Re-encode one File as a font. Returns { ext: 'TTF', data }; throws if it won't parse
// as the font container its extension claims.
export async function reencodeFont(file, ext) {
  const { Font, woff2 } = await loadCore()
  const type = TYPE_BY_EXT[ext]
  if (type === 'woff2') await ensureWoff2(woff2)

  const buffer = await file.arrayBuffer()
  let font
  try {
    font = Font.create(buffer, { type })
  } catch {
    throw new Error(`"${file.name}" is not a decodable font`)
  }
  // toBuffer:true → an ArrayBuffer holding a freshly written glyf TrueType.
  const out = font.write({ type: 'ttf', toBuffer: true })
  return { ext: 'TTF', data: new Uint8Array(out) }
}

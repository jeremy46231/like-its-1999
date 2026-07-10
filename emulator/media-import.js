// Single "upload files" entry point for the CD-ROM modal (cdrom-ui.js): each file is
// tried as an image first, then as audio/MIDI, and only rejected if neither reencode
// pipeline can make sense of it. The disc doesn't care what's on it, so there's no
// reason to make the user sort their files into two buckets before uploading.
import { buildIso9660 } from './vmfs/iso9660.js'
import { uniqueBaseName } from './iso-name.js'
import { reencodeImage } from './image-import.js'
import { reencodeAudioFile } from './audio-import.js'

async function reencodeOne(file) {
  try {
    return await reencodeImage(file)
  } catch {
    // Not a decodable image — fall through and try it as audio/MIDI instead.
  }
  try {
    return await reencodeAudioFile(file)
  } catch {
    throw new Error(`"${file.name}" is not a decodable image or audio file`)
  }
}

// Re-encode a list of File objects and pack them into an ISO9660 image ready for
// emulator.set_cdrom({ buffer: ... }). Throws if any file is neither.
export async function buildMediaCdrom(files) {
  const used = new Set()
  const entries = []
  for (const file of files) {
    const { ext, data } = await reencodeOne(file)
    entries.push({ name: `${uniqueBaseName(file.name, used)}.${ext}`, data })
  }
  return buildIso9660({ volumeLabel: 'IMPORTED', files: entries })
}

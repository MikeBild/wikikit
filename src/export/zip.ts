// Minimal, dependency-free ZIP writer/reader for export bundles.
//
// WHY hand-rolled instead of a zip dependency: WikiKit ships as a single
// self-contained Bun binary with a deliberately small pure-JS dependency set
// (plan §1), and the export contract demands BYTE-STABLE output — the same
// space snapshot must zip to the same bytes on every export (plan §9:
// export → import → export byte-stable). Off-the-shelf zippers embed wall
// clock mtimes, OS attribute bits and version fields that vary between
// releases; owning the ~200 lines pins every byte.
//
// Writer: STORE only (method 0), fixed DOS timestamp, no extra fields, no
// comments — compression would make output depend on the deflate
// implementation's version, and knowledge bundles are text that transports
// fine uncompressed (HTTP layers can content-encode if they care).
//
// Reader: accepts STORE and DEFLATE (method 8, via node:zlib inflateRawSync,
// available natively in Bun) because FOREIGN bundles — the whole point of OKF
// as an exchange format — are almost always deflated by standard tooling.
import { inflateRawSync } from 'node:zlib'
import { ValidationError } from '../domain/errors.ts'

export interface ZipEntry {
  /** Forward-slash relative path inside the archive, e.g. 'concepts/okf.md'. */
  path: string
  data: Uint8Array
}

// ---------------------------------------------------------------------------
// CRC-32 (IEEE 802.3, the zip polynomial). Table-driven, computed once.
const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// Fixed DOS date/time: 1980-01-01 00:00:00 — the earliest representable DOS
// timestamp. A constant, not now(): timestamps in the archive would break
// byte-stability between two exports of identical knowledge.
const DOS_TIME = 0x0000
const DOS_DATE = 0x0021 // year 0 (=1980), month 1, day 1

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: false })

class ByteWriter {
  private chunks: Uint8Array[] = []
  private length = 0

  u16(value: number): void {
    const b = new Uint8Array(2)
    new DataView(b.buffer).setUint16(0, value, true)
    this.raw(b)
  }

  u32(value: number): void {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, value >>> 0, true)
    this.raw(b)
  }

  raw(bytes: Uint8Array): void {
    this.chunks.push(bytes)
    this.length += bytes.length
  }

  get offset(): number {
    return this.length
  }

  concat(): Uint8Array {
    const out = new Uint8Array(this.length)
    let at = 0
    for (const chunk of this.chunks) {
      out.set(chunk, at)
      at += chunk.length
    }
    return out
  }
}

function assertSafePath(path: string): void {
  // Traversal guard applied on BOTH write and read: an entry name is attacker
  // input on import (foreign bundles), and refusing to ever produce one keeps
  // the writer honest too.
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new ValidationError(`unsafe zip entry path: ${JSON.stringify(path)}`)
  }
}

/**
 * Build a deterministic STORE-only zip. Entry order is preserved exactly as
 * given — callers (the bundle serializers) sort entries themselves, so the
 * archive bytes are a pure function of the entry list.
 */
export function createZip(entries: ZipEntry[]): Uint8Array {
  const writer = new ByteWriter()
  const central: { path: Uint8Array; crc: number; size: number; offset: number }[] = []
  const seen = new Set<string>()

  for (const entry of entries) {
    assertSafePath(entry.path)
    if (seen.has(entry.path)) throw new ValidationError(`duplicate zip entry path: ${entry.path}`)
    seen.add(entry.path)

    const name = encoder.encode(entry.path)
    const crc = crc32(entry.data)
    const offset = writer.offset

    // Local file header
    writer.u32(0x04034b50)
    writer.u16(20) // version needed: 2.0 (plain store)
    writer.u16(0x0800) // flags: UTF-8 filenames only
    writer.u16(0) // method: STORE
    writer.u16(DOS_TIME)
    writer.u16(DOS_DATE)
    writer.u32(crc)
    writer.u32(entry.data.length) // compressed size (= raw for STORE)
    writer.u32(entry.data.length) // uncompressed size
    writer.u16(name.length)
    writer.u16(0) // extra length
    writer.raw(name)
    writer.raw(entry.data)

    central.push({ path: name, crc, size: entry.data.length, offset })
  }

  const centralStart = writer.offset
  for (const record of central) {
    writer.u32(0x02014b50)
    writer.u16(20) // version made by (pinned constant — never the host OS)
    writer.u16(20) // version needed
    writer.u16(0x0800)
    writer.u16(0) // method STORE
    writer.u16(DOS_TIME)
    writer.u16(DOS_DATE)
    writer.u32(record.crc)
    writer.u32(record.size)
    writer.u32(record.size)
    writer.u16(record.path.length)
    writer.u16(0) // extra
    writer.u16(0) // comment
    writer.u16(0) // disk number
    writer.u16(0) // internal attrs
    writer.u32(0) // external attrs (pinned 0 — no OS mode bits)
    writer.u32(record.offset)
    writer.raw(record.path)
  }
  const centralSize = writer.offset - centralStart

  // End of central directory
  writer.u32(0x06054b50)
  writer.u16(0) // disk
  writer.u16(0) // central dir disk
  writer.u16(central.length)
  writer.u16(central.length)
  writer.u32(centralSize)
  writer.u32(centralStart)
  writer.u16(0) // comment length

  return writer.concat()
}

// Import limits — an uploaded bundle is untrusted input, so both the entry
// count and the inflated size are capped BEFORE any parsing happens
// (zip-bomb guard). Generous for real knowledge bundles.
const MAX_ENTRIES = 10_000
const MAX_TOTAL_UNCOMPRESSED = 256 * 1024 * 1024 // 256 MiB

/**
 * Read a zip archive from memory. Supports STORE and DEFLATE entries;
 * directory entries (trailing '/') are skipped. Reads via the central
 * directory — the only authoritative index per the zip spec.
 */
export function readZip(data: Uint8Array): ZipEntry[] {
  if (data.length < 22) throw new ValidationError('not a zip archive (too small)')
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  // Find the End Of Central Directory record by scanning backwards over the
  // (max 65535-byte) trailing comment space.
  let eocd = -1
  const scanFloor = Math.max(0, data.length - 22 - 0xffff)
  for (let i = data.length - 22; i >= scanFloor; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ValidationError('not a zip archive (missing end-of-central-directory)')

  const count = view.getUint16(eocd + 10, true)
  const centralOffset = view.getUint32(eocd + 16, true)
  if (count > MAX_ENTRIES) throw new ValidationError(`zip has too many entries (${count} > ${MAX_ENTRIES})`)
  if (count === 0xffff || centralOffset === 0xffffffff) {
    throw new ValidationError('zip64 archives are not supported')
  }

  const entries: ZipEntry[] = []
  let cursor = centralOffset
  let totalUncompressed = 0

  for (let i = 0; i < count; i++) {
    if (cursor + 46 > data.length || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new ValidationError('corrupt zip central directory')
    }
    const method = view.getUint16(cursor + 10, true)
    const expectedCrc = view.getUint32(cursor + 16, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const uncompressedSize = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const path = decoder.decode(data.subarray(cursor + 46, cursor + 46 + nameLength))
    cursor += 46 + nameLength + extraLength + commentLength

    if (path.endsWith('/')) continue // directory marker
    assertSafePath(path)

    totalUncompressed += uncompressedSize
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) {
      throw new ValidationError('zip inflates beyond the import size limit')
    }

    // The local header repeats name/extra lengths — and its extra field may
    // DIFFER from the central one, so the data offset must be computed from
    // the local record, never assumed from the central sizes.
    if (localOffset + 30 > data.length || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new ValidationError(`corrupt zip local header for ${path}`)
    }
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    if (dataStart + compressedSize > data.length) {
      throw new ValidationError(`zip entry ${path} is truncated`)
    }
    const raw = data.subarray(dataStart, dataStart + compressedSize)

    let content: Uint8Array
    if (method === 0) {
      content = new Uint8Array(raw) // copy: detach from the archive buffer
    } else if (method === 8) {
      try {
        // maxOutputLength makes the DECLARED size a hard bound during
        // inflation itself: without it a hostile entry declaring
        // uncompressedSize=100 whose deflate stream expands to gigabytes is
        // fully inflated in one sync call BEFORE the mismatch check below —
        // a memory-exhaustion zip bomb inside the 10 MiB upload cap. Bound of
        // max(size, 1) because 0 means "unlimited" to zlib; a declared-empty
        // entry that inflates to 1 byte still fails the mismatch check.
        content = new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.max(uncompressedSize, 1) }))
      } catch {
        // ERR_BUFFER_TOO_LARGE (stream exceeds the declared size) and corrupt
        // deflate data alike: the entry lies about itself.
        throw new ValidationError(`zip entry ${path} size mismatch`)
      }
    } else {
      throw new ValidationError(`unsupported zip compression method ${method} for ${path}`)
    }
    if (content.length !== uncompressedSize) {
      throw new ValidationError(`zip entry ${path} size mismatch`)
    }
    if (crc32(content) !== expectedCrc) {
      throw new ValidationError(`zip entry ${path} failed CRC check`)
    }

    entries.push({ path, data: content })
  }

  return entries
}

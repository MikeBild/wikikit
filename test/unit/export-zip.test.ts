// Deterministic zip writer/reader — the byte-stability foundation of the
// export contract (plan §9). The writer is asserted byte-identical across
// calls; the reader is asserted against foreign-shaped input (DEFLATE
// entries, corrupt bytes, hostile paths).
import { describe, expect, test } from 'bun:test'
import { deflateRawSync } from 'node:zlib'
import { createZip, crc32, readZip, type ZipEntry } from '../../src/export/zip.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const entry = (path: string, text: string): ZipEntry => ({ path, data: encoder.encode(text) })

describe('createZip / readZip round trip', () => {
  test('entries round-trip with paths, bytes and order preserved', () => {
    const entries = [entry('index.md', '# hi\n'), entry('concepts/a.md', 'alpha'), entry('sources/h.md', 'raw')]
    const out = readZip(createZip(entries))
    expect(out.map((e) => e.path)).toEqual(['index.md', 'concepts/a.md', 'sources/h.md'])
    expect(decoder.decode(out[1]!.data)).toBe('alpha')
  })

  test('identical entry lists produce byte-identical archives (determinism)', () => {
    const entries = [entry('a.md', 'A'), entry('b/c.md', 'C')]
    expect(Buffer.from(createZip(entries)).equals(Buffer.from(createZip(entries)))).toBe(true)
  })

  test('empty archive round-trips', () => {
    expect(readZip(createZip([]))).toEqual([])
  })

  test('utf-8 content and paths survive', () => {
    const out = readZip(createZip([entry('concepts/ümlaut.md', 'köln — ✓')]))
    expect(out[0]!.path).toBe('concepts/ümlaut.md')
    expect(decoder.decode(out[0]!.data)).toBe('köln — ✓')
  })
})

describe('createZip guards', () => {
  test.each([['/abs.md'], ['../up.md'], ['a/../b.md'], ['a//b.md'], ['back\\slash.md'], ['']])(
    'rejects unsafe path %j',
    (path) => {
      expect(() => createZip([{ path, data: new Uint8Array() }])).toThrow(/unsafe zip entry path/)
    },
  )

  test('rejects duplicate entry paths', () => {
    expect(() => createZip([entry('a.md', '1'), entry('a.md', '2')])).toThrow(/duplicate zip entry/)
  })
})

// Hand-build a single-entry zip with method 8 (DEFLATE) — foreign bundles are
// almost always deflated by standard tooling, so the reader must accept it
// even though our writer never produces it.
function buildDeflatedZip(path: string, content: Uint8Array, declaredSize = content.length): Uint8Array {
  const name = encoder.encode(path)
  const compressed = new Uint8Array(deflateRawSync(content))
  const crc = crc32(content)
  const chunks: number[] = []
  const u16 = (v: number) => chunks.push(v & 0xff, (v >>> 8) & 0xff)
  const u32 = (v: number) => chunks.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff)
  // local header
  u32(0x04034b50)
  u16(20)
  u16(0x0800)
  u16(8)
  u16(0)
  u16(0)
  u32(crc)
  u32(compressed.length)
  u32(declaredSize)
  u16(name.length)
  u16(0)
  chunks.push(...name, ...compressed)
  const centralStart = chunks.length
  // central directory
  u32(0x02014b50)
  u16(20)
  u16(20)
  u16(0x0800)
  u16(8)
  u16(0)
  u16(0)
  u32(crc)
  u32(compressed.length)
  u32(declaredSize)
  u16(name.length)
  u16(0)
  u16(0)
  u16(0)
  u16(0)
  u32(0)
  u32(0)
  chunks.push(...name)
  const centralSize = chunks.length - centralStart
  // end of central directory
  u32(0x06054b50)
  u16(0)
  u16(0)
  u16(1)
  u16(1)
  u32(centralSize)
  u32(centralStart)
  u16(0)
  return new Uint8Array(chunks)
}

describe('readZip on foreign input', () => {
  test('reads DEFLATE entries (standard tooling output)', () => {
    const zip = buildDeflatedZip('concepts/okf.md', encoder.encode('---\ntype: Concept\n---\nbody body body body'))
    const out = readZip(zip)
    expect(out).toHaveLength(1)
    expect(decoder.decode(out[0]!.data)).toContain('type: Concept')
  })

  test('rejects a flipped content byte via CRC', () => {
    const zip = createZip([entry('a.md', 'stable content')])
    // Flip a byte inside the stored file data (local header is 30 bytes + name).
    const corrupted = new Uint8Array(zip)
    corrupted[30 + 'a.md'.length + 3]! ^= 0xff
    expect(() => readZip(corrupted)).toThrow(/CRC/)
  })

  test('rejects non-zip garbage', () => {
    expect(() => readZip(encoder.encode('not a zip at all, but long enough to scan'))).toThrow(/not a zip archive/)
    expect(() => readZip(new Uint8Array(3))).toThrow(/too small/)
  })

  test('skips directory marker entries', () => {
    // Our writer never emits them, so synthesize via readZip on a crafted list:
    // simplest is to check a trailing-slash path is refused by the writer and
    // accepted (skipped) by the reader through the deflate builder.
    const dirZip = buildDeflatedZip('concepts/', new Uint8Array())
    expect(readZip(dirZip)).toEqual([])
  })

  test('rejects hostile entry paths on read', () => {
    const zip = buildDeflatedZip('../escape.md', encoder.encode('x'))
    expect(() => readZip(zip)).toThrow(/unsafe zip entry path/)
  })

  test('a zip bomb lying about its uncompressed size is stopped DURING inflation', () => {
    // 8 MiB of zeros deflates to a few KiB. The entry DECLARES 100 bytes, so
    // the declared-size accounting alone would admit it — the reader must
    // bound the inflate call itself (maxOutputLength) instead of inflating
    // everything and checking afterwards.
    const bomb = buildDeflatedZip('concepts/bomb.md', new Uint8Array(8 * 1024 * 1024), 100)
    expect(() => readZip(bomb)).toThrow(/size mismatch/)
  })

  test('an honest declared size that mismatches the stream still fails', () => {
    const zip = buildDeflatedZip('a.md', encoder.encode('twelve bytes'), 5)
    expect(() => readZip(zip)).toThrow(/size mismatch/)
  })
})

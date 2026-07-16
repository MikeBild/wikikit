// Document extraction — turn an uploaded binary (PDF/DOCX/XLSX) or a text file
// into Markdown that the normal ingest pipeline can classify + synthesize. The
// heavy parsers are pure-JS and bundle into the single binary (verified):
//   pdf  → unpdf (pdfjs text layer)
//   docx → mammoth (→ Markdown)
//   xlsx → exceljs (→ Markdown tables)
//   md/markdown/txt/csv → decoded as UTF-8 text
//
// WHY extraction lives BEFORE the pipeline (in the upload handler) rather than
// in the worker: it is deterministic CPU work bounded by WIKIKIT_MAX_BODY_BYTES,
// and doing it up front lets the extracted Markdown flow through the EXACT same
// path as a pasted markdown source — dedup, classify, synthesize, the verbatim
// -quote grounding guard — with zero changes downstream. The parsers are lazy
// -imported so an install that never uploads a document never initializes them.
import { DomainError } from '../domain/errors.ts'

/** 415 — the file extension is not one we can extract. */
export class UnsupportedDocumentError extends DomainError {
  constructor(ext: string) {
    super('unsupported_document', `unsupported document type: ${ext || '(no extension)'}`, 415, {
      nextBestActions: ['upload one of: pdf, docx, xlsx, md, markdown, txt, csv', 'or POST extracted text to /ingest'],
    })
  }
}

/** 422 — the file parsed but yielded no usable text (e.g. a scanned image PDF). */
export class DocumentExtractionError extends DomainError {
  constructor(message: string) {
    super('document_extraction_failed', message, 422, {
      nextBestActions: ['ensure the document has a text layer (not a scanned image)'],
    })
  }
}

export type DocumentFormat = 'pdf' | 'docx' | 'xlsx' | 'markdown' | 'text' | 'csv'

export interface ExtractedDocument {
  markdown: string
  /** Human title derived from the filename (extension stripped). */
  title: string
  format: DocumentFormat
}

const EXT_FORMAT: Record<string, DocumentFormat> = {
  pdf: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx',
  md: 'markdown',
  markdown: 'markdown',
  txt: 'text',
  csv: 'csv',
}

function extOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

function titleOf(filename: string): string {
  const base = (filename.split(/[\\/]/).pop() ?? filename).trim()
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  return stem.trim() || 'document'
}

async function extractPdf(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const doc = await getDocumentProxy(bytes)
  // mergePages:true resolves `text` to a single string.
  const { text } = await extractText(doc, { mergePages: true })
  return String(text ?? '')
}

async function extractDocx(bytes: Uint8Array): Promise<string> {
  const mammoth = (await import('mammoth')).default as unknown as {
    convertToMarkdown(input: { buffer: Buffer }): Promise<{ value: string }>
  }
  const { value } = await mammoth.convertToMarkdown({ buffer: Buffer.from(bytes) })
  return value
}

async function extractXlsx(bytes: Uint8Array): Promise<string> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer)
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return ''
    if (typeof v === 'object') {
      const o = v as { text?: string; result?: unknown; hyperlink?: string }
      if (typeof o.text === 'string') return o.text
      if (o.result !== undefined) return String(o.result)
      if (typeof o.hyperlink === 'string') return o.hyperlink
      return ''
    }
    return String(v)
  }
  const parts: string[] = []
  wb.eachSheet((ws) => {
    const rows: string[][] = []
    ws.eachRow((row) => {
      // exceljs row.values is 1-indexed (values[0] is empty).
      const vals = (row.values as unknown[]).slice(1).map(cell)
      rows.push(vals)
    })
    if (!rows.length) return
    parts.push(`## ${ws.name}`)
    const width = Math.max(...rows.map((r) => r.length))
    const pad = (r: string[]) => Array.from({ length: width }, (_, i) => (r[i] ?? '').replace(/\|/g, '\\|'))
    const [header, ...body] = rows
    parts.push(`| ${pad(header ?? []).join(' | ')} |`)
    parts.push(`| ${Array.from({ length: width }, () => '---').join(' | ')} |`)
    for (const r of body) parts.push(`| ${pad(r).join(' | ')} |`)
  })
  return parts.join('\n')
}

/**
 * Extract an uploaded document to Markdown. Dispatch is by the filename
 * extension (the caller supplies it). Throws UnsupportedDocumentError (415) for
 * unknown types and DocumentExtractionError (422) when parsing yields no text.
 */
export async function extractDocument(bytes: Uint8Array, filename: string): Promise<ExtractedDocument> {
  const ext = extOf(filename)
  const format = EXT_FORMAT[ext]
  if (!format) throw new UnsupportedDocumentError(ext)

  let markdown: string
  try {
    switch (format) {
      case 'pdf':
        markdown = await extractPdf(bytes)
        break
      case 'docx':
        markdown = await extractDocx(bytes)
        break
      case 'xlsx':
        markdown = await extractXlsx(bytes)
        break
      default:
        // markdown / text / csv — decode verbatim.
        markdown = Buffer.from(bytes).toString('utf8')
    }
  } catch (error) {
    if (error instanceof DomainError) throw error
    throw new DocumentExtractionError(
      `failed to extract ${format} document: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  markdown = markdown.trim()
  if (!markdown) throw new DocumentExtractionError(`the ${format} document contained no extractable text`)
  return { markdown, title: titleOf(filename), format }
}

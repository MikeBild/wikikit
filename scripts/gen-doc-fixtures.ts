// Generate the binary document fixtures used by the extraction tests/benchmark.
// One-off, reproducible: `bun scripts/gen-doc-fixtures.ts`. The writer libs
// (docx, pdf-lib) are devDependencies — they never ship in the binary.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx'
import ExcelJS from 'exceljs'

const DIR = join(import.meta.dir, '../test/fixtures/documents')
mkdirSync(DIR, { recursive: true })

// Shared, checkable content (the tests assert these strings survive extraction).
const LINE1 = 'The Open Knowledge Format is a draft v0.1.'
const LINE2 = 'The file path is the concept identity.'

async function pdf() {
  const doc = await PDFDocument.create()
  const page = doc.addPage([420, 300])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText(LINE1, { x: 40, y: 240, size: 13, font })
  page.drawText(LINE2, { x: 40, y: 210, size: 13, font })
  writeFileSync(join(DIR, 'sample.pdf'), await doc.save())
}

async function docx() {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: 'Open Knowledge Format', heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ children: [new TextRun(LINE1)] }),
          new Paragraph({ children: [new TextRun(LINE2)] }),
        ],
      },
    ],
  })
  writeFileSync(join(DIR, 'sample.docx'), await Packer.toBuffer(doc))
}

async function xlsx() {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Prices')
  ws.addRow(['Product', 'Price'])
  ws.addRow(['Reifen A', 120])
  ws.addRow(['Reifen B', 95])
  writeFileSync(join(DIR, 'sample.xlsx'), Buffer.from(await wb.xlsx.writeBuffer()))
}

await Promise.all([pdf(), docx(), xlsx()])
console.log('wrote fixtures to', DIR)

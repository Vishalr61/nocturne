import { PDFDocument } from 'pdf-lib'

/**
 * Copy an inclusive 1-based page range out of the original PDF, untouched —
 * original colours, original text layer, tiny file. "Send chapter 3" without
 * sending the whole book. Runs entirely locally.
 */
export async function extractPages(src: ArrayBuffer, from: number, to: number): Promise<Blob> {
  const source = await PDFDocument.load(src)
  const out = await PDFDocument.create()
  const indices: number[] = []
  for (let p = from; p <= to; p++) indices.push(p - 1)
  const pages = await out.copyPages(source, indices)
  for (const pg of pages) out.addPage(pg)

  const saved = await out.save()
  // ArrayBuffer-backed copy so the Blob part type is unambiguous (pdf-lib's
  // return type widens to ArrayBufferLike under strict TS).
  const buf = new Uint8Array(saved.length)
  buf.set(saved)
  return new Blob([buf], { type: 'application/pdf' })
}

import { openPdf } from '../engine/pdf'
import { generateThumbnail } from '../engine/pipeline'
import { DEFAULT_THEME } from '../engine/theme'
import { addBook, hashBytes } from '../storage/db'

// Importing a book = copying it into the app's own storage. On iOS the file
// picker is the Files app (including iCloud Drive), so this is the whole
// "iCloud library -> read offline in Nocturne" bridge: pick once, keep forever.
// The id is a content hash, so re-adding the same file resumes the same book.

export async function importBook(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const id = await hashBytes(buf)
  const doc = await openPdf(buf)

  let thumb: string | undefined
  try {
    thumb = await generateThumbnail(await doc.getPage(1), DEFAULT_THEME)
  } catch {
    // Thumbnail is cosmetic; never let it block adding a book.
  }

  await addBook({
    id,
    title: file.name.replace(/\.pdf$/i, ''),
    addedAt: Date.now(),
    pageCount: doc.numPages,
    size: buf.byteLength,
    data: buf,
    thumb,
    lastOpenedAt: Date.now(),
  })
  await doc.destroy()
  return id
}

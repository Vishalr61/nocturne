import { openPdf, type PDFDocumentProxy } from '../engine/pdf'
import { generateThumbnail } from '../engine/pipeline'
import { DEFAULT_THEME } from '../engine/theme'
import { addBook, hashBytes, takePendingTitle } from '../storage/db'

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

  // A restored backup may already know this book's name (matched by content
  // hash) — that beats anything we could derive from the file.
  const restored = await takePendingTitle(id)

  await addBook({
    id,
    title: restored ?? (await deriveTitle(doc, file.name)),
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

/**
 * A title worth showing on the shelf. The PDF's own metadata is right when it
 * exists, but plenty of files carry junk there (a LaTeX job name, "Microsoft
 * Word - final2.doc", an empty string), so it's only trusted when it looks
 * like prose. Otherwise the filename is cleaned up: separators to spaces,
 * ALLCAPS/lowercase to Title Case. Renameable in the shelf either way.
 */
async function deriveTitle(doc: PDFDocumentProxy, filename: string): Promise<string> {
  try {
    const meta = await doc.getMetadata()
    const raw = (meta.info as { Title?: unknown } | undefined)?.Title
    if (typeof raw === 'string') {
      const t = raw.trim()
      const junk = /^(untitled|document\d*|microsoft word|print|book\d*)\b/i.test(t) || /\.(pdf|docx?|tex|indd)$/i.test(t)
      if (t.length > 2 && t.length < 120 && !junk) return t
    }
  } catch {
    // No metadata; fall through to the filename.
  }
  return prettifyFilename(filename)
}

export function prettifyFilename(filename: string): string {
  const base = filename.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!base) return 'Untitled'
  // Leave mixed-case names alone (already typed by a human); fix shouty or
  // all-lowercase ones, minus the small words a title case wouldn't capitalise.
  if (/[a-z]/.test(base) && /[A-Z]/.test(base)) return base
  const small = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'to', 'in', 'on', 'for'])
  return base
    .toLowerCase()
    .split(' ')
    .map((w, i) => (i > 0 && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}

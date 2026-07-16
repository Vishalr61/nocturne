import { openPdf, type PDFDocumentProxy } from '../engine/pdf'
import { openEpub, looksLikeEpub } from '../engine/epub'
import { generateThumbnail } from '../engine/pipeline'
import { DEFAULT_THEME } from '../engine/theme'
import { addBook, getKnownBook, hashBytes, takePendingTitle } from '../storage/db'

// Importing a book = copying it into the app's own storage. On iOS the file
// picker is the Files app (including iCloud Drive), so this is the whole
// "iCloud library -> read offline in Nocturne" bridge: pick once, keep forever.
// The id is a content hash, so re-adding the same file resumes the same book.

export async function importBook(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const id = await hashBytes(buf)
  if (looksLikeEpub(new Uint8Array(buf), file.name)) return importEpub(id, buf, file)
  const doc = await openPdf(buf)

  let thumb: string | undefined
  try {
    thumb = await generateThumbnail(await doc.getPage(1), DEFAULT_THEME)
  } catch {
    // Thumbnail is cosmetic; never let it block adding a book.
  }

  // A synced device (ghost) or a restored backup may already know this book's
  // name (matched by content hash) — that beats anything we could derive from
  // the file. When it comes from sync, keep its updatedAt so re-adding the file
  // doesn't look like a newer edit and clobber the synced title.
  const known = await getKnownBook(id)
  const restored = known ? undefined : await takePendingTitle(id)
  const title = known?.title ?? restored ?? (await deriveTitle(doc, file.name))

  await addBook({
    id,
    title,
    addedAt: known?.addedAt ?? Date.now(),
    pageCount: doc.numPages,
    size: buf.byteLength,
    data: buf,
    thumb,
    lastOpenedAt: Date.now(),
    updatedAt: known?.updatedAt, // undefined for a brand-new book → addBook stamps now
  })
  await doc.destroy()
  return id
}

/** EPUB import: same content-hash identity and shelf shape as PDFs; the
 *  "pageCount" slot carries the chapter count (page N = chapter N for EPUBs),
 *  and the thumbnail comes from the declared cover image. */
async function importEpub(id: string, buf: ArrayBuffer, file: File): Promise<string> {
  const epub = await openEpub(new Uint8Array(buf))
  let thumb: string | undefined
  try {
    if (epub.cover) thumb = await coverThumb(epub.cover.data, epub.cover.mime)
  } catch {
    // cosmetic only
  }
  const known = await getKnownBook(id)
  const restored = known ? undefined : await takePendingTitle(id)
  const title = known?.title ?? restored ?? epub.title ?? prettifyFilename(file.name)
  await addBook({
    id,
    title,
    addedAt: known?.addedAt ?? Date.now(),
    pageCount: epub.chapterCount,
    size: buf.byteLength,
    data: buf,
    thumb,
    format: 'epub',
    lastOpenedAt: Date.now(),
    updatedAt: known?.updatedAt,
  })
  epub.dispose()
  return id
}

/** Rasterize a cover image to the shelf thumbnail size (JPEG data URL). */
async function coverThumb(data: Uint8Array, mime: string): Promise<string> {
  const blob = new Blob([data.slice().buffer as ArrayBuffer], { type: mime })
  const bmp = await createImageBitmap(blob)
  const targetW = 220
  const scale = targetW / bmp.width
  const canvas = document.createElement('canvas')
  canvas.width = targetW
  canvas.height = Math.round(bmp.height * scale)
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
  bmp.close()
  return canvas.toDataURL('image/jpeg', 0.8)
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

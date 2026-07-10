import Dexie, { type EntityTable } from 'dexie'

// Local-only persistence. No accounts, no server: your library, your per-book look,
// and your reading position all live in the browser's IndexedDB. The data layer is
// deliberately behind this small module so cloud sync can be added later without
// the rest of the app knowing (swap the impl, keep the shape).

export interface Book {
  id: string // stable hash of the file bytes
  title: string
  addedAt: number
  pageCount: number
  size: number
  data: ArrayBuffer // the original PDF, untouched
  /** Small recolored render of page 1 (JPEG data URL) for the shelf. */
  thumb?: string
  lastOpenedAt?: number
}

export interface Profile {
  bookId: string
  themeId: string
  satCut: number // colour-image preservation threshold
  strength: number // recolor intensity 0..1
  zoom: number
  /** Brightness of preserved images against the dark page, 0.4..1. */
  imageDim?: number
  /** Crop the document's shared page margins so content fills the screen. */
  cropMargins?: boolean
  /** 'paged' (tap to turn, zoom, highlight) or 'scroll' (continuous flow). */
  viewMode?: 'paged' | 'scroll'
  /** Show two pages side by side when the screen is landscape (paged mode). */
  spread?: boolean
}

export interface Progress {
  bookId: string
  page: number
  percent: number
  updatedAt: number
}

/**
 * A title waiting for its book. Restoring a backup brings back what you knew
 * about books whose bytes aren't on this device yet; when you later re-add the
 * PDF from iCloud, its content hash matches and the name comes back with it.
 */
export interface PendingTitle {
  bookId: string
  title: string
}

/** A page you marked. `note` is optional; the id is bookId:page (one per page). */
export interface Bookmark {
  id: string
  bookId: string
  page: number
  note?: string
  createdAt: number
}

export const bookmarkId = (bookId: string, page: number) => `${bookId}:${page}`

/**
 * A highlighted passage. Stored as a character RANGE into the page's flattened
 * text, never as pixel rects: ranges survive zoom, margin-crop, and a different
 * screen, because the boxes are recomputed from the PDF's own geometry.
 */
export interface Highlight {
  id: string
  bookId: string
  page: number
  start: number
  end: number
  text: string
  createdAt: number
}

const db = new Dexie('nocturne') as Dexie & {
  books: EntityTable<Book, 'id'>
  profiles: EntityTable<Profile, 'bookId'>
  progress: EntityTable<Progress, 'bookId'>
  pendingTitles: EntityTable<PendingTitle, 'bookId'>
  bookmarks: EntityTable<Bookmark, 'id'>
  highlights: EntityTable<Highlight, 'id'>
}

db.version(1).stores({
  books: 'id, addedAt, title',
  profiles: 'bookId',
  progress: 'bookId, updatedAt',
})

db.version(2).stores({
  books: 'id, addedAt, title',
  profiles: 'bookId',
  progress: 'bookId, updatedAt',
  pendingTitles: 'bookId',
})

db.version(3).stores({
  books: 'id, addedAt, title',
  profiles: 'bookId',
  progress: 'bookId, updatedAt',
  pendingTitles: 'bookId',
  bookmarks: 'id, bookId, page',
})

db.version(4).stores({
  books: 'id, addedAt, title',
  profiles: 'bookId',
  progress: 'bookId, updatedAt',
  pendingTitles: 'bookId',
  bookmarks: 'id, bookId, page',
  highlights: 'id, bookId, [bookId+page]',
})

export async function addBook(book: Book): Promise<void> {
  await db.books.put(book)
}

export async function listBooks(): Promise<Book[]> {
  return db.books.orderBy('addedAt').reverse().toArray()
}

export async function getBook(id: string): Promise<Book | undefined> {
  return db.books.get(id)
}

/** Remove a book and everything known about it (bytes, look, position, marks). */
export async function deleteBook(id: string): Promise<void> {
  await Promise.all([
    db.books.delete(id),
    db.profiles.delete(id),
    db.progress.delete(id),
    db.bookmarks.where('bookId').equals(id).delete(),
    db.highlights.where('bookId').equals(id).delete(),
  ])
}

// --- highlights ---------------------------------------------------------------

export async function listHighlights(bookId: string): Promise<Highlight[]> {
  const rows = await db.highlights.where('bookId').equals(bookId).toArray()
  return rows.sort((a, b) => a.page - b.page || a.start - b.start)
}

export async function highlightsOnPage(bookId: string, page: number): Promise<Highlight[]> {
  return db.highlights.where('[bookId+page]').equals([bookId, page]).toArray()
}

export async function addHighlight(
  h: Omit<Highlight, 'id' | 'createdAt'>,
): Promise<Highlight> {
  const row: Highlight = { ...h, id: crypto.randomUUID(), createdAt: Date.now() }
  await db.highlights.put(row)
  return row
}

export async function removeHighlight(id: string): Promise<void> {
  await db.highlights.delete(id)
}

/** How many highlights each book has, for the shelf. */
export async function highlightCounts(): Promise<Record<string, number>> {
  const rows = await db.highlights.toArray()
  const out: Record<string, number> = {}
  for (const r of rows) out[r.bookId] = (out[r.bookId] ?? 0) + 1
  return out
}

// --- bookmarks ----------------------------------------------------------------

export async function listBookmarks(bookId: string): Promise<Bookmark[]> {
  const rows = await db.bookmarks.where('bookId').equals(bookId).toArray()
  return rows.sort((a, b) => a.page - b.page)
}

export async function addBookmark(bookId: string, page: number, note?: string): Promise<void> {
  await db.bookmarks.put({ id: bookmarkId(bookId, page), bookId, page, note, createdAt: Date.now() })
}

/** Label a bookmark. An empty note clears it, and the row falls back to "Page N". */
export async function setBookmarkNote(bookId: string, page: number, note: string): Promise<void> {
  const t = note.trim()
  await db.bookmarks.update(bookmarkId(bookId, page), { note: t || undefined })
}

/** How many bookmarks each book has, for the shelf. */
export async function bookmarkCounts(): Promise<Record<string, number>> {
  const rows = await db.bookmarks.toArray()
  const out: Record<string, number> = {}
  for (const r of rows) out[r.bookId] = (out[r.bookId] ?? 0) + 1
  return out
}

export async function removeBookmark(bookId: string, page: number): Promise<void> {
  await db.bookmarks.delete(bookmarkId(bookId, page))
}

export async function touchBook(id: string): Promise<void> {
  await db.books.update(id, { lastOpenedAt: Date.now() })
}

export async function saveThumb(id: string, thumb: string): Promise<void> {
  await db.books.update(id, { thumb })
}

/** Rename a book on the shelf. The id is the content hash, so it never changes. */
export async function renameBook(id: string, title: string): Promise<void> {
  const t = title.trim()
  if (t) await db.books.update(id, { title: t })
}

/** The book to resume on launch: the one most recently opened or read. */
export async function latestBookId(): Promise<string | undefined> {
  const books = await db.books.toArray()
  if (!books.length) return undefined
  const latestProgress = await db.progress.orderBy('updatedAt').last()
  if (latestProgress && books.some((b) => b.id === latestProgress.bookId)) {
    return latestProgress.bookId
  }
  return books.sort((a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt))[0].id
}

export async function saveProfile(p: Profile): Promise<void> {
  await db.profiles.put(p)
}

export async function getProfile(bookId: string): Promise<Profile | undefined> {
  return db.profiles.get(bookId)
}

export async function saveProgress(p: Progress): Promise<void> {
  await db.progress.put(p)
}

export async function getProgress(bookId: string): Promise<Progress | undefined> {
  return db.progress.get(bookId)
}

export interface ProgressByBook {
  [bookId: string]: Progress
}

export async function allProgress(): Promise<ProgressByBook> {
  const rows = await db.progress.toArray()
  return Object.fromEntries(rows.map((r) => [r.bookId, r]))
}

/** Stable content id so re-adding the same file resumes the same book. */
export async function hashBytes(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Ask the browser to treat our storage as durable (books are big; losing them
 * means re-adding from iCloud). Best-effort: browsers may grant silently for
 * installed PWAs, and we never block on the answer.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false
  } catch {
    return false
  }
}

export async function storageEstimate(): Promise<{ used: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.()
    if (!e) return null
    return { used: e.usage ?? 0, quota: e.quota ?? 0 }
  } catch {
    return null
  }
}

/**
 * Has the browser promised not to evict our books? Safari grants this to
 * installed (home-screen) PWAs and clears storage for ordinary sites after ~7
 * idle days, so this is the difference between "your library is safe" and
 * "your library may vanish and need re-adding".
 */
export async function isPersisted(): Promise<boolean> {
  try {
    return (await navigator.storage?.persisted?.()) ?? false
  } catch {
    return false
  }
}

// --- backup / restore ---------------------------------------------------------
//
// Everything Nocturne knows about your reading EXCEPT the PDF bytes: titles,
// positions, per-book looks. It's kilobytes, so it fits anywhere (iCloud Drive,
// email to yourself). The bytes deliberately stay out: your PDFs already live in
// iCloud, and re-adding one matches by content hash, which re-attaches the name
// and the position stored here. Restore, re-add, resume.

export interface LibraryBackup {
  version: 1
  exportedAt: number
  books: { id: string; title: string; pageCount: number; size: number; addedAt: number }[]
  profiles: Profile[]
  progress: Progress[]
  /** Optional so backups written before these existed still restore, and so an
   *  older build can still read a newer backup (additive, no version bump). */
  bookmarks?: Bookmark[]
  highlights?: Highlight[]
}

export async function exportLibrary(): Promise<LibraryBackup> {
  const [books, profiles, progress, bookmarks, highlights] = await Promise.all([
    db.books.toArray(),
    db.profiles.toArray(),
    db.progress.toArray(),
    db.bookmarks.toArray(),
    db.highlights.toArray(),
  ])
  return {
    version: 1,
    exportedAt: Date.now(),
    books: books.map((b) => ({
      id: b.id,
      title: b.title,
      pageCount: b.pageCount,
      size: b.size,
      addedAt: b.addedAt,
    })),
    profiles,
    progress,
    bookmarks,
    highlights,
  }
}

export interface RestoreResult {
  /** Books in the backup whose bytes are already on this device (renamed now). */
  matched: number
  /** Books whose bytes aren't here yet; their names/positions wait for a re-add. */
  pending: number
}

export async function importLibrary(backup: LibraryBackup): Promise<RestoreResult> {
  if (backup?.version !== 1 || !Array.isArray(backup.books)) {
    throw new Error('not-a-nocturne-backup')
  }
  // Positions and looks are keyed by book id (a content hash), so they can be
  // restored whether or not the bytes are present — a later re-add finds them.
  await db.profiles.bulkPut(backup.profiles ?? [])
  await db.progress.bulkPut(backup.progress ?? [])
  await db.bookmarks.bulkPut(backup.bookmarks ?? [])
  await db.highlights.bulkPut(backup.highlights ?? [])

  const here = new Set((await db.books.toArray()).map((b) => b.id))
  let matched = 0
  const pending: PendingTitle[] = []
  for (const b of backup.books) {
    if (here.has(b.id)) {
      await db.books.update(b.id, { title: b.title })
      matched++
    } else {
      pending.push({ bookId: b.id, title: b.title })
    }
  }
  await db.pendingTitles.bulkPut(pending)
  return { matched, pending: pending.length }
}

/** A title restored from a backup, waiting for this book's bytes. Consumed once. */
export async function takePendingTitle(id: string): Promise<string | undefined> {
  const row = await db.pendingTitles.get(id)
  if (!row) return undefined
  await db.pendingTitles.delete(id)
  return row.title
}

export { db }

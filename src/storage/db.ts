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
}

export interface Progress {
  bookId: string
  page: number
  percent: number
  updatedAt: number
}

const db = new Dexie('nocturne') as Dexie & {
  books: EntityTable<Book, 'id'>
  profiles: EntityTable<Profile, 'bookId'>
  progress: EntityTable<Progress, 'bookId'>
}

db.version(1).stores({
  books: 'id, addedAt, title',
  profiles: 'bookId',
  progress: 'bookId, updatedAt',
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

/** Remove a book and everything known about it (bytes, look, position). */
export async function deleteBook(id: string): Promise<void> {
  await Promise.all([db.books.delete(id), db.profiles.delete(id), db.progress.delete(id)])
}

export async function touchBook(id: string): Promise<void> {
  await db.books.update(id, { lastOpenedAt: Date.now() })
}

export async function saveThumb(id: string, thumb: string): Promise<void> {
  await db.books.update(id, { thumb })
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

export { db }

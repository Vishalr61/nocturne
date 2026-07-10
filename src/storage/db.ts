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
}

export interface Profile {
  bookId: string
  themeId: string
  satCut: number // colour-image preservation threshold
  strength: number // recolor intensity 0..1
  zoom: number
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

/** Stable content id so re-adding the same file resumes the same book. */
export async function hashBytes(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export { db }

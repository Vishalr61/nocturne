import Dexie, { type EntityTable } from 'dexie'

// Local-first persistence: your library, your per-book look, and your reading
// position live in the browser's IndexedDB and work fully offline. An opt-in
// state sync (see syncClient.ts) can mirror the small stuff — positions, looks,
// bookmarks, highlights, titles — across your devices via an end-to-end
// encrypted store; the PDF bytes never leave the device. `updatedAt` on the
// synced records is the last-write-wins key; deletions are recorded as
// tombstones so they propagate instead of resurrecting.

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
  /** Last change to synced metadata (title); the LWW key. */
  updatedAt?: number
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
  /** 'paged' (tap to turn), 'scroll' (continuous), or 'text' (reflow). */
  viewMode?: 'paged' | 'scroll' | 'text'
  /** Show two pages side by side when the screen is landscape (paged mode). */
  spread?: boolean
  /** Last edit; the LWW key for sync. */
  updatedAt?: number
}

export interface Progress {
  bookId: string
  page: number
  percent: number
  /** Scroll mode's exact strip position, in page units (scrollTop/slotHeight).
   *  Restores the very line you left, not just the page top. */
  offset?: number
  /** Marked done by the reader — independent of percent (a book is finished
   *  when they say so, not when a scrollbar does). Rides along with sync. */
  finished?: boolean
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
  updatedAt?: number
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
  /** Pen colour ('amber' when absent — every highlight before colours existed). */
  color?: 'amber' | 'sage'
  createdAt: number
  updatedAt?: number
}

/** Highlight tints, as painted over the page. Amber is the classic marker;
 *  sage is the second pen for a different kind of note. */
export const HIGHLIGHT_TINTS: Record<'amber' | 'sage', string> = {
  amber: 'rgba(201, 165, 106, 0.24)',
  sage: 'rgba(143, 174, 139, 0.28)',
}
export const tintOf = (c?: string) =>
  HIGHLIGHT_TINTS[(c === 'sage' ? 'sage' : 'amber') as 'amber' | 'sage']

/** A recorded deletion, kept so it propagates through sync (no resurrection).
 *  naturalKey is the plaintext logical key (e.g. "bookmark:<id>:<page>"), which
 *  stays local; sync turns it into an opaque record id. */
export interface Tombstone {
  naturalKey: string
  deletedAt: number
  /** Enough to rebuild the sync payload for the delete. */
  body: Record<string, unknown>
}

/** Book metadata learned from sync for a book whose bytes aren't on this device
 *  yet — shown as a "ghost" on the shelf until you re-add the file. */
export interface KnownBook {
  bookId: string
  title: string
  pageCount: number
  addedAt: number
  updatedAt: number
}

/** Singleton sync configuration (id is always "state"). */
export interface SyncState {
  id: 'state'
  enabled: boolean
  secret?: string
  /** Server cursor: highest `seq` pulled. */
  cursor: number
  /** High-water mark of local `updatedAt` already pushed. */
  pushedHigh: number
  lastSyncAt?: number
}

/** One day of reading, accumulated locally. Never synced — stats are a
 *  private mirror, not a leaderboard. */
export interface ReadingDay {
  /** Local calendar day, 'YYYY-MM-DD'. */
  day: string
  ms: number
  pages: number
}

const db = new Dexie('nocturne') as Dexie & {
  books: EntityTable<Book, 'id'>
  profiles: EntityTable<Profile, 'bookId'>
  progress: EntityTable<Progress, 'bookId'>
  pendingTitles: EntityTable<PendingTitle, 'bookId'>
  bookmarks: EntityTable<Bookmark, 'id'>
  highlights: EntityTable<Highlight, 'id'>
  tombstones: EntityTable<Tombstone, 'naturalKey'>
  knownBooks: EntityTable<KnownBook, 'bookId'>
  syncState: EntityTable<SyncState, 'id'>
  readingLog: EntityTable<ReadingDay, 'day'>
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

db.version(5).stores({
  books: 'id, addedAt, title',
  profiles: 'bookId',
  progress: 'bookId, updatedAt',
  pendingTitles: 'bookId',
  bookmarks: 'id, bookId, page',
  highlights: 'id, bookId, [bookId+page]',
  tombstones: 'naturalKey, deletedAt',
  knownBooks: 'bookId',
  syncState: 'id',
})

db.version(6).stores({
  books: 'id, addedAt, title',
  profiles: 'bookId',
  progress: 'bookId, updatedAt',
  pendingTitles: 'bookId',
  bookmarks: 'id, bookId, page',
  highlights: 'id, bookId, [bookId+page]',
  tombstones: 'naturalKey, deletedAt',
  knownBooks: 'bookId',
  syncState: 'id',
  readingLog: 'day',
})

// --- reading stats --------------------------------------------------------

const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Credit reading time/pages to today's log (called by the reader, throttled). */
export async function logReading(ms: number, pages: number): Promise<void> {
  if (ms <= 0 && pages <= 0) return
  const day = localDay()
  await db.transaction('rw', db.readingLog, async () => {
    const row = await db.readingLog.get(day)
    await db.readingLog.put({ day, ms: (row?.ms ?? 0) + ms, pages: (row?.pages ?? 0) + pages })
  })
}

export interface ReadingStats {
  todayMin: number
  todayPages: number
  weekMin: number
  /** Consecutive days ending today (or yesterday) with 5+ minutes read. */
  streak: number
}

export async function readingStats(): Promise<ReadingStats> {
  const rows = await db.readingLog.toArray()
  const byDay = new Map(rows.map((r) => [r.day, r]))
  const today = new Date()
  const dayAt = (back: number) => {
    const d = new Date(today)
    d.setDate(d.getDate() - back)
    return localDay(d)
  }
  const todayRow = byDay.get(dayAt(0))
  let weekMs = 0
  for (let i = 0; i < 7; i++) weekMs += byDay.get(dayAt(i))?.ms ?? 0
  const counts = (back: number) => (byDay.get(dayAt(back))?.ms ?? 0) >= 5 * 60 * 1000
  // The streak survives "today hasn't hit 5 minutes YET" — start from
  // yesterday if today doesn't count on its own.
  let streak = 0
  let back = counts(0) ? 0 : 1
  while (counts(back)) {
    streak++
    back++
  }
  return {
    todayMin: Math.round((todayRow?.ms ?? 0) / 60000),
    todayPages: todayRow?.pages ?? 0,
    weekMin: Math.round(weekMs / 60000),
    streak,
  }
}

export async function addBook(book: Book): Promise<void> {
  await db.books.put({ ...book, updatedAt: book.updatedAt ?? Date.now() })
  await db.knownBooks.delete(book.id) // it's local now; no longer a ghost
}

export async function listBooks(): Promise<Book[]> {
  return db.books.orderBy('addedAt').reverse().toArray()
}

export async function getBook(id: string): Promise<Book | undefined> {
  return db.books.get(id)
}

// Natural (plaintext) keys for syncable records. These never leave the device;
// sync turns each into an opaque id. Shared with syncModel.ts so both sides agree.
export const natBook = (id: string) => `book:${id}`
export const natProfile = (id: string) => `profile:${id}`
export const natProgress = (id: string) => `progress:${id}`
export const natBookmark = (id: string, page: number) => `bookmark:${id}:${page}`
export const natHighlight = (hid: string) => `highlight:${hid}`

async function recordTombstone(naturalKey: string, body: Record<string, unknown>): Promise<void> {
  await db.tombstones.put({ naturalKey, deletedAt: Date.now(), body: { ...body, deleted: true } })
}

/** Remove a book and everything known about it (bytes, look, position, marks).
 *  Records a single book tombstone; applying it elsewhere cascades the same way. */
export async function deleteBook(id: string): Promise<void> {
  await applyDeleteBook(id)
  await recordTombstone(natBook(id), { t: 'book', bookId: id })
}

/** Delete a book and its children WITHOUT tombstoning — used when applying a
 *  remote deletion (a tombstone here would echo back out). */
export async function applyDeleteBook(id: string): Promise<void> {
  await Promise.all([
    db.books.delete(id),
    db.knownBooks.delete(id),
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
  const now = Date.now()
  const row: Highlight = { ...h, id: crypto.randomUUID(), createdAt: now, updatedAt: now }
  await db.highlights.put(row)
  return row
}

export async function removeHighlight(id: string): Promise<void> {
  const h = await db.highlights.get(id)
  await db.highlights.delete(id)
  if (h) await recordTombstone(natHighlight(id), { t: 'highlight', id, bookId: h.bookId, page: h.page })
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
  const now = Date.now()
  await db.bookmarks.put({ id: bookmarkId(bookId, page), bookId, page, note, createdAt: now, updatedAt: now })
}

/** Label a bookmark. An empty note clears it, and the row falls back to "Page N". */
export async function setBookmarkNote(bookId: string, page: number, note: string): Promise<void> {
  const t = note.trim()
  await db.bookmarks.update(bookmarkId(bookId, page), { note: t || undefined, updatedAt: Date.now() })
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
  await recordTombstone(natBookmark(bookId, page), { t: 'bookmark', bookId, page })
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
  if (t) await db.books.update(id, { title: t, updatedAt: Date.now() })
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
  await db.profiles.put({ ...p, updatedAt: Date.now() })
}

export async function getProfile(bookId: string): Promise<Profile | undefined> {
  return db.profiles.get(bookId)
}

export async function saveProgress(p: Progress): Promise<void> {
  // `finished` is owned by the shelf action, not the reading loop — a put
  // would silently drop it on the next page turn, so carry it forward.
  if (p.finished === undefined) {
    const cur = await db.progress.get(p.bookId)
    if (cur?.finished) p = { ...p, finished: true }
  }
  await db.progress.put(p)
}

export async function getProgress(bookId: string): Promise<Progress | undefined> {
  return db.progress.get(bookId)
}

/** Mark a book finished (or un-finish it). Creates a progress row if the book
 *  was never opened; bumps updatedAt so sync carries it. */
export async function setBookFinished(bookId: string, finished: boolean): Promise<void> {
  const cur = await db.progress.get(bookId)
  await db.progress.put({
    bookId,
    page: cur?.page ?? 1,
    percent: finished ? 1 : (cur?.percent ?? 0),
    offset: cur?.offset,
    finished,
    updatedAt: Date.now(),
  })
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

// --- sync state ---------------------------------------------------------------

const DEFAULT_SYNC: SyncState = { id: 'state', enabled: false, cursor: 0, pushedHigh: 0 }

export async function getSyncState(): Promise<SyncState> {
  return (await db.syncState.get('state')) ?? DEFAULT_SYNC
}

export async function setSyncState(patch: Partial<SyncState>): Promise<SyncState> {
  const next = { ...(await getSyncState()), ...patch, id: 'state' as const }
  await db.syncState.put(next)
  return next
}

// --- raw reads for the sync engine (it builds/*applies* records itself) -------

export function allProfiles() {
  return db.profiles.toArray()
}
export function allBookmarks() {
  return db.bookmarks.toArray()
}
export function allHighlights() {
  return db.highlights.toArray()
}
export function allProgressRows() {
  return db.progress.toArray()
}
export function allBooks() {
  return db.books.toArray()
}
export function allTombstones() {
  return db.tombstones.toArray()
}

/** Books learned from sync whose bytes aren't on this device yet (ghost shelf). */
export async function listGhostBooks(): Promise<KnownBook[]> {
  const [known, local] = await Promise.all([db.knownBooks.toArray(), db.books.toArray()])
  const here = new Set(local.map((b) => b.id))
  return known.filter((k) => !here.has(k.bookId)).sort((a, b) => b.addedAt - a.addedAt)
}

export async function upsertKnownBook(k: KnownBook): Promise<void> {
  await db.knownBooks.put(k)
}

export async function getKnownBook(bookId: string): Promise<KnownBook | undefined> {
  return db.knownBooks.get(bookId)
}

// Direct table access for the sync engine's LWW apply (writes preserve the
// remote updatedAt and never record tombstones — see syncModel.ts).
export { db }

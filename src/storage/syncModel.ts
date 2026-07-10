import {
  allBookmarks,
  allBooks,
  allHighlights,
  allProfiles,
  allProgressRows,
  allTombstones,
  applyDeleteBook,
  bookmarkId,
  db,
  natBook,
  natBookmark,
  natHighlight,
  natProfile,
  natProgress,
  upsertKnownBook,
} from './db'

// Translates between local Dexie rows and the flat, syncable "records" the
// client encrypts and ships. One direction collects local changes to push; the
// other applies a decrypted remote record with last-write-wins. The plaintext
// `body` carries a type tag and its own `updatedAt`, so applying never has to
// trust the (unencrypted) server metadata.

/** A syncable change in plaintext, before encryption. */
export interface LocalRecord {
  naturalKey: string
  updatedAt: number
  deleted: boolean
  body: Record<string, unknown>
}

/** Everything changed since `sinceHigh` (updatedAt high-water mark), for push. */
export async function collectLocal(sinceHigh: number): Promise<LocalRecord[]> {
  const [books, profiles, progress, bookmarks, highlights, tombstones] = await Promise.all([
    allBooks(),
    allProfiles(),
    allProgressRows(),
    allBookmarks(),
    allHighlights(),
    allTombstones(),
  ])
  const out: LocalRecord[] = []

  for (const b of books) {
    const u = b.updatedAt ?? b.addedAt
    if (u > sinceHigh) {
      out.push({
        naturalKey: natBook(b.id),
        updatedAt: u,
        deleted: false,
        body: { t: 'book', bookId: b.id, title: b.title, pageCount: b.pageCount, addedAt: b.addedAt },
      })
    }
  }
  for (const p of profiles) {
    const u = p.updatedAt ?? 0
    if (u > sinceHigh) {
      out.push({ naturalKey: natProfile(p.bookId), updatedAt: u, deleted: false, body: { t: 'profile', ...p } })
    }
  }
  for (const p of progress) {
    if (p.updatedAt > sinceHigh) {
      out.push({
        naturalKey: natProgress(p.bookId),
        updatedAt: p.updatedAt,
        deleted: false,
        body: { t: 'progress', bookId: p.bookId, page: p.page, percent: p.percent },
      })
    }
  }
  for (const m of bookmarks) {
    const u = m.updatedAt ?? m.createdAt
    if (u > sinceHigh) {
      out.push({
        naturalKey: natBookmark(m.bookId, m.page),
        updatedAt: u,
        deleted: false,
        body: { t: 'bookmark', bookId: m.bookId, page: m.page, note: m.note ?? null, createdAt: m.createdAt },
      })
    }
  }
  for (const h of highlights) {
    const u = h.updatedAt ?? h.createdAt
    if (u > sinceHigh) {
      out.push({
        naturalKey: natHighlight(h.id),
        updatedAt: u,
        deleted: false,
        body: {
          t: 'highlight',
          id: h.id,
          bookId: h.bookId,
          page: h.page,
          start: h.start,
          end: h.end,
          text: h.text,
          createdAt: h.createdAt,
        },
      })
    }
  }
  for (const tomb of tombstones) {
    if (tomb.deletedAt > sinceHigh) {
      out.push({ naturalKey: tomb.naturalKey, updatedAt: tomb.deletedAt, deleted: true, body: tomb.body })
    }
  }
  return out
}

/** True if `remoteUpdatedAt` should win over a local row's timestamp. */
function wins(remoteUpdatedAt: number, localUpdatedAt: number | undefined): boolean {
  return remoteUpdatedAt > (localUpdatedAt ?? 0)
}

/**
 * Apply one decrypted remote record, last-write-wins. Writes preserve the
 * remote `updatedAt` and never record tombstones (that would echo back out).
 * `body.updatedAt` is authoritative (it's inside the authenticated ciphertext).
 */
export async function applyRemote(body: Record<string, unknown>): Promise<number> {
  const t = body.t as string
  const updatedAt = Number(body.updatedAt) || 0
  const deleted = body.deleted === true

  switch (t) {
    case 'book': {
      const bookId = String(body.bookId)
      if (deleted) {
        const local = await db.books.get(bookId)
        // Delete wins unless the local book was re-added/renamed more recently.
        if (!local || wins(updatedAt, local.updatedAt ?? local.addedAt)) await applyDeleteBook(bookId)
        return updatedAt
      }
      const local = await db.books.get(bookId)
      if (local) {
        if (wins(updatedAt, local.updatedAt ?? local.addedAt)) {
          await db.books.update(bookId, { title: String(body.title), updatedAt })
        }
      } else {
        // Bytes not here — remember it for the ghost shelf (LWW).
        const known = await db.knownBooks.get(bookId)
        if (wins(updatedAt, known?.updatedAt)) {
          await upsertKnownBook({
            bookId,
            title: String(body.title),
            pageCount: Number(body.pageCount) || 0,
            addedAt: Number(body.addedAt) || updatedAt,
            updatedAt,
          })
        }
      }
      return updatedAt
    }
    case 'profile': {
      const bookId = String(body.bookId)
      const local = await db.profiles.get(bookId)
      if (deleted) {
        if (local && wins(updatedAt, local.updatedAt)) await db.profiles.delete(bookId)
      } else if (wins(updatedAt, local?.updatedAt)) {
        const { t: _t, deleted: _d, ...fields } = body
        void _t
        void _d
        await db.profiles.put({ ...(fields as object), bookId, updatedAt } as never)
      }
      return updatedAt
    }
    case 'progress': {
      const bookId = String(body.bookId)
      const local = await db.progress.get(bookId)
      if (wins(updatedAt, local?.updatedAt)) {
        await db.progress.put({
          bookId,
          page: Number(body.page) || 1,
          percent: Number(body.percent) || 0,
          updatedAt,
        })
      }
      return updatedAt
    }
    case 'bookmark': {
      const bookId = String(body.bookId)
      const page = Number(body.page)
      const id = bookmarkId(bookId, page)
      const local = await db.bookmarks.get(id)
      if (deleted) {
        if (local && wins(updatedAt, local.updatedAt ?? local.createdAt)) await db.bookmarks.delete(id)
      } else if (wins(updatedAt, local?.updatedAt ?? local?.createdAt)) {
        await db.bookmarks.put({
          id,
          bookId,
          page,
          note: (body.note as string) ?? undefined,
          createdAt: Number(body.createdAt) || updatedAt,
          updatedAt,
        })
      }
      return updatedAt
    }
    case 'highlight': {
      const id = String(body.id)
      const local = await db.highlights.get(id)
      if (deleted) {
        if (local && wins(updatedAt, local.updatedAt ?? local.createdAt)) await db.highlights.delete(id)
      } else if (wins(updatedAt, local?.updatedAt ?? local?.createdAt)) {
        await db.highlights.put({
          id,
          bookId: String(body.bookId),
          page: Number(body.page),
          start: Number(body.start),
          end: Number(body.end),
          text: String(body.text),
          createdAt: Number(body.createdAt) || updatedAt,
          updatedAt,
        })
      }
      return updatedAt
    }
    default:
      return updatedAt
  }
}

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  allProgress,
  deleteBook,
  exportLibrary,
  importLibrary,
  isPersisted,
  listBooks,
  renameBook,
  requestPersistentStorage,
  storageEstimate,
  type Book,
  type ProgressByBook,
} from '../storage/db'
import { importBook } from './import'

// The library: a place to resume, not a file manager. A "Reading now" hero
// leads with the last book and one-tap Resume — the whole product exists for
// download → keep reading — with a quiet cover grid below. Books live in this
// device's browser storage; iCloud (via the Files picker) stays the master
// library.

interface ShelfProps {
  onOpen: (bookId: string) => void
}

/** Typographic cover fallback for books whose thumbnail hasn't rendered yet. */
const COVER_GRADIENTS = [
  'linear-gradient(160deg,#2a1c30,#1a1120)',
  'linear-gradient(160deg,#2a2013,#170f08)',
  'linear-gradient(160deg,#182a26,#0f1a17)',
  'linear-gradient(160deg,#2b1a10,#180f08)',
  'linear-gradient(160deg,#16281e,#0e1913)',
  'linear-gradient(160deg,#20202a,#131319)',
]
const coverGradient = (id: string) =>
  COVER_GRADIENTS[(id.charCodeAt(0) + id.charCodeAt(1)) % COVER_GRADIENTS.length]

export function Shelf({ onOpen }: ShelfProps) {
  const [books, setBooks] = useState<Book[] | null>(null)
  const [progress, setProgress] = useState<ProgressByBook>({})
  const [storage, setStorage] = useState<string>('')
  const [durable, setDurable] = useState<boolean | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  /** Book id being renamed inline, and the draft text. */
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [filter, setFilter] = useState('')
  const editRef = useRef<HTMLInputElement | null>(null)

  const refresh = useCallback(async () => {
    const [bs, ps, est, persisted] = await Promise.all([
      listBooks(),
      allProgress(),
      storageEstimate(),
      isPersisted(),
    ])
    setBooks(bs)
    setProgress(ps)
    setDurable(persisted)
    if (est && est.quota > 0) {
      setStorage(`${fmtBytes(est.used)} of ${fmtBytes(est.quota)} used`)
    }
  }, [])

  useEffect(() => {
    // Books are big and re-adding is a chore; ask the browser to keep them.
    void requestPersistentStorage().then(() => refresh())
  }, [refresh])

  const onBackup = useCallback(async () => {
    const backup = await exportLibrary()
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `nocturne-library-${new Date(backup.exportedAt).toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setNote(`Backed up ${backup.books.length} books · keep it in iCloud`)
  }, [])

  const onRestore = useCallback(
    async (file: File) => {
      try {
        const res = await importLibrary(JSON.parse(await file.text()))
        await refresh()
        setNote(
          res.pending
            ? `Restored ${res.matched} here · ${res.pending} waiting — re-add those PDFs and they resume`
            : `Restored ${res.matched} books`,
        )
      } catch {
        setNote("That doesn't look like a Nocturne backup")
      }
    },
    [refresh],
  )

  const onAdd = useCallback(
    async (file: File) => {
      setBusy(true)
      try {
        const id = await importBook(file)
        onOpen(id)
      } finally {
        setBusy(false)
      }
    },
    [onOpen],
  )

  const onDelete = useCallback(
    async (book: Book) => {
      if (!window.confirm(`Remove “${book.title}” from Nocturne? Your reading position is deleted too.`)) return
      await deleteBook(book.id)
      void refresh()
    },
    [refresh],
  )

  const startRename = useCallback((book: Book) => {
    setEditing(book.id)
    setDraft(book.title)
    // Select the whole title so typing replaces it (the common case).
    requestAnimationFrame(() => editRef.current?.select())
  }, [])

  const commitRename = useCallback(async () => {
    if (!editing) return
    const id = editing
    setEditing(null)
    await renameBook(id, draft)
    void refresh()
  }, [editing, draft, refresh])

  // "Reading now" = the book you touched most recently.
  const hero =
    books && books.length
      ? [...books].sort((a, b) => lastTouched(b, progress) - lastTouched(a, progress))[0]
      : null

  const needle = filter.trim().toLowerCase()
  const shown = !books ? [] : needle ? books.filter((b) => b.title.toLowerCase().includes(needle)) : books

  const meta = (b: Book) => {
    const p = progress[b.id]
    if (!p) return 'Not started'
    return `${Math.round(p.percent * 100)}% · p. ${p.page} of ${b.pageCount}`
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-night-950 font-sans text-ink-body">
      <header className="sticky top-0 z-20 border-b border-night-800 bg-night-950/80 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-[1180px] items-center gap-4 px-5 py-4 sm:px-8">
          <div
            className="h-[30px] w-[30px] flex-none rounded-[9px]"
            style={{ background: 'radial-gradient(120% 120% at 30% 20%,#e0c088,#a97f3f)' }}
          />
          <h1 className="font-serif text-xl font-semibold tracking-tight text-ink-bright">
            Nocturne
          </h1>
          <span className="-ml-1 text-[13px] text-ink-soft">Library</span>
          <div className="flex-1" />
          {storage && <span className="hidden text-xs text-ink-faint sm:block">{storage}</span>}
          <label className="cursor-pointer rounded-[11px] bg-accent px-4 py-2 text-[13px] font-semibold text-accent-on transition-colors hover:bg-accent-hi">
            {busy ? 'Adding…' : 'Add PDF'}
            <input
              type="file"
              accept="application/pdf"
              className="hidden"
              disabled={busy}
              onChange={(e) => e.target.files?.[0] && void onAdd(e.target.files[0])}
            />
          </label>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1180px] flex-1 px-5 pb-16 pt-8 sm:px-8 sm:pt-10">
        {books === null ? null : books.length === 0 ? (
          <div className="anim-rise mt-24 text-center text-ink-dim">
            <p className="text-4xl">🌙</p>
            <p className="mt-5 font-serif text-xl text-ink-mid">No books yet.</p>
            <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed">
              Add a PDF — on iPhone the picker opens Files, so your iCloud Drive books are right
              there.
            </p>
          </div>
        ) : (
          <>
            {hero && (
              <section className="anim-rise">
                <div className="mb-4 text-[11px] uppercase tracking-[0.18em] text-ink-kicker">
                  Reading now
                </div>
                <button
                  className="flex w-full flex-wrap items-center rounded-[22px] border border-line text-left"
                  style={{
                    gap: 'clamp(22px,3vw,40px)',
                    padding: 'clamp(20px,2.6vw,34px)',
                    background: 'radial-gradient(130% 150% at 0% 0%,#241a0f,#160f08 70%)',
                    boxShadow: '0 30px 60px -30px rgba(0,0,0,.8)',
                  }}
                  onClick={() => onOpen(hero.id)}
                >
                  <div
                    className="aspect-[3/4] flex-none overflow-hidden rounded-xl"
                    style={{
                      width: 'clamp(110px,14vw,168px)',
                      boxShadow: '0 22px 44px -16px rgba(0,0,0,.85)',
                    }}
                  >
                    {hero.thumb ? (
                      <img src={hero.thumb} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <div
                        className="flex h-full w-full flex-col justify-end p-4"
                        style={{ background: coverGradient(hero.id) }}
                      >
                        <div className="font-serif text-lg font-medium leading-tight text-ink-shelf">
                          {hero.title}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="min-w-[min(260px,100%)] flex-1">
                    <div
                      className="font-serif leading-[1.08] tracking-tight text-ink-head"
                      style={{ fontSize: 'clamp(26px,3.4vw,40px)' }}
                    >
                      {hero.title}
                    </div>
                    <div className="mt-2 text-[15px] text-ink-mid">
                      {hero.pageCount} pages · added {relTime(hero.addedAt)}
                    </div>
                    <div className="mt-6 flex max-w-[440px] items-center gap-4">
                      <div className="h-1 flex-1 overflow-hidden rounded bg-line">
                        <div
                          className="h-full"
                          style={{
                            width: `${Math.round((progress[hero.id]?.percent ?? 0) * 100)}%`,
                            background: 'linear-gradient(90deg,#c9a56a,#e6c68c)',
                          }}
                        />
                      </div>
                      <span className="whitespace-nowrap text-[13px] tabular-nums text-ink-mid">
                        {meta(hero)}
                      </span>
                    </div>
                    <div className="mt-6">
                      <span className="inline-block rounded-xl bg-accent px-6 py-2.5 text-sm font-semibold text-accent-on">
                        Resume reading
                      </span>
                    </div>
                  </div>
                </button>
              </section>
            )}

            <div className="mb-5 mt-12 flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="font-serif text-[22px] text-ink-head">Your shelf</h2>
              <div className="flex items-baseline gap-3">
                {books.length > 3 && (
                  <input
                    aria-label="Filter books"
                    placeholder="Filter…"
                    className="w-36 rounded-lg border border-line bg-inset px-2.5 py-1 text-[13px] outline-none placeholder:text-ink-faint focus:border-accent/60"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                )}
                <span className="text-[13px] text-ink-dim">
                  {shown.length === books.length
                    ? `${books.length} ${books.length === 1 ? 'book' : 'books'}`
                    : `${shown.length} of ${books.length}`}
                </span>
              </div>
            </div>
            <div
              className="grid gap-x-[26px] gap-y-[34px]"
              style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))' }}
            >
              {shown.map((b) => {
                const p = progress[b.id]
                const pct = p ? Math.round(p.percent * 100) : 0
                const isEditing = editing === b.id
                return (
                  <div key={b.id} className="anim-rise group relative">
                    <button className="block w-full text-left" onClick={() => onOpen(b.id)}>
                      <div
                        className="relative aspect-[3/4] overflow-hidden rounded-[13px] bg-night-800 ring-1 ring-white/5"
                        style={{ boxShadow: '0 18px 36px -16px rgba(0,0,0,.8)' }}
                      >
                        {b.thumb ? (
                          <img src={b.thumb} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <div
                            className="flex h-full w-full flex-col justify-end p-4"
                            style={{ background: coverGradient(b.id) }}
                          >
                            <div className="font-serif text-[17px] font-medium leading-tight text-ink-shelf">
                              {b.title}
                            </div>
                          </div>
                        )}
                        {/* progress strip along the cover's bottom edge */}
                        <div className="absolute inset-x-0 bottom-0 h-[3px] bg-black/30">
                          <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    </button>

                    {isEditing ? (
                      <input
                        ref={editRef}
                        aria-label="Book title"
                        className="mt-3 w-full rounded-md border border-accent/50 bg-inset px-2 py-1 font-serif text-[15px] text-ink-shelf outline-none"
                        value={draft}
                        autoFocus
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => void commitRename()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitRename()
                          else if (e.key === 'Escape') setEditing(null)
                        }}
                      />
                    ) : (
                      <button
                        className="mt-3 block w-full truncate text-left font-serif text-[15px] leading-tight text-ink-shelf"
                        onClick={() => onOpen(b.id)}
                      >
                        {b.title}
                      </button>
                    )}

                    <div className="mt-1 flex items-baseline justify-between text-xs tabular-nums text-ink-dim">
                      <span className="truncate">{p ? `${pct}% · p. ${p.page}` : 'Not started'}</span>
                      <span className="ml-2 flex-none">{p ? relTime(p.updatedAt) : ''}</span>
                    </div>

                    <div className="absolute right-2 top-2 flex gap-1.5">
                      <button
                        aria-label={`Rename ${b.title}`}
                        className="rounded-full bg-black/60 px-2 py-0.5 text-xs text-ink-body opacity-60 transition-opacity hover:opacity-100"
                        onClick={() => startRename(b)}
                      >
                        ✎
                      </button>
                      <button
                        aria-label={`Remove ${b.title}`}
                        className="rounded-full bg-black/60 px-2 py-0.5 text-xs text-ink-body opacity-60 transition-opacity hover:opacity-100"
                        onClick={() => void onDelete(b)}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </main>

      {/* Durability: say plainly whether these books are safe here, and give
          the two escape hatches (backup file, restore) that make them so. */}
      <footer className="mx-auto flex w-full max-w-[1180px] flex-wrap items-center justify-center gap-x-4 gap-y-1 px-5 pb-5 text-xs text-ink-faint sm:justify-between sm:px-8">
        <span className="flex items-center gap-1.5">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: durable ? '#c9a56a' : '#6f6041' }}
          />
          {durable === null
            ? ''
            : durable
              ? 'Saved on this device'
              : 'Not persisted — add to Home Screen to keep books safe'}
          {storage && <span className="ml-2 opacity-70">· {storage}</span>}
        </span>
        <span className="flex items-center gap-4">
          {note && <span className="text-ink-dim">{note}</span>}
          <button className="underline-offset-2 hover:text-ink-soft hover:underline" onClick={() => void onBackup()}>
            Back up
          </button>
          <label className="cursor-pointer underline-offset-2 hover:text-ink-soft hover:underline">
            Restore
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && void onRestore(e.target.files[0])}
            />
          </label>
        </span>
      </footer>
    </div>
  )
}

function lastTouched(b: Book, progress: ProgressByBook): number {
  return Math.max(progress[b.id]?.updatedAt ?? 0, b.lastOpenedAt ?? 0, b.addedAt)
}

function fmtBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(0)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}

function relTime(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days}d ago`
}

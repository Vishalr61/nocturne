import { useCallback, useEffect, useRef, useState } from 'react'
import {
  allProgress,
  bookmarkCounts,
  deleteBook,
  exportLibrary,
  getSyncState,
  highlightCounts,
  importLibrary,
  isPersisted,
  listBooks,
  listGhostBooks,
  deleteVocabWord,
  listVocab,
  readingStats,
  renameBook,
  requestPersistentStorage,
  restoreVocabWord,
  setBookFinished,
  updateVocabWord,
  storageEstimate,
  type Book,
  type KnownBook,
  type ProgressByBook,
  type ReadingStats,
  type VocabWord,
} from '../storage/db'
import {
  adoptSecret,
  disableSync,
  enableSync,
  syncConfigured,
  syncNow,
} from '../storage/syncClient'
import { importBook } from './import'

/** Chromium's beforeinstallprompt event (not in the TS DOM lib). */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
}

/** iPadOS reports itself as MacIntel; the touch-points check catches it. */
const isIOS = () =>
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

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
  const [marks, setMarks] = useState<Record<string, number>>({})
  const [storage, setStorage] = useState<string>('')
  const [durable, setDurable] = useState<boolean | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  /** Book id being renamed inline, and the draft text. */
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<'recent' | 'title' | 'progress'>(() => {
    const v = localStorage.getItem('nocturne-shelf-sort')
    return v === 'title' || v === 'progress' ? v : 'recent'
  })
  const [stats, setStats] = useState<ReadingStats | null>(null)
  // Vocabulary notebook: words saved from the dictionary card while reading.
  const [vocab, setVocab] = useState<VocabWord[]>([])
  const [showVocab, setShowVocab] = useState(false)
  const [vocabQuery, setVocabQuery] = useState('')
  const [vocabOpen, setVocabOpen] = useState<string | null>(null) // expanded word id
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({})
  const [lastDeleted, setLastDeleted] = useState<VocabWord | null>(null)
  // Install: Chromium hands us a deferred prompt; iOS has no API, only steps.
  const [installEvt, setInstallEvt] = useState<InstallPromptEvent | null>(null)
  const [showInstallHelp, setShowInstallHelp] = useState(false)
  const installed =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault()
      setInstallEvt(e as InstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    return () => window.removeEventListener('beforeinstallprompt', onPrompt)
  }, [])
  const editRef = useRef<HTMLInputElement | null>(null)
  // Sync (opt-in, state-only). Books that live elsewhere show as "ghosts".
  const [ghosts, setGhosts] = useState<KnownBook[]>([])
  const [syncOn, setSyncOn] = useState(false)
  const [secret, setSecret] = useState('')
  const [syncMsg, setSyncMsg] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [showSyncPanel, setShowSyncPanel] = useState(false)
  const [adoptDraft, setAdoptDraft] = useState('')

  const refresh = useCallback(async () => {
    const [bs, ps, est, persisted, bm, hl, gh, ss] = await Promise.all([
      listBooks(),
      allProgress(),
      storageEstimate(),
      isPersisted(),
      bookmarkCounts(),
      highlightCounts(),
      listGhostBooks(),
      getSyncState(),
    ])
    setBooks(bs)
    setProgress(ps)
    void readingStats().then(setStats)
    void listVocab().then(setVocab)
    // One badge for "you've marked this book up", bookmarks + highlights.
    const total: Record<string, number> = { ...bm }
    for (const [id, n] of Object.entries(hl)) total[id] = (total[id] ?? 0) + n
    setMarks(total)
    setDurable(persisted)
    setGhosts(gh)
    setSyncOn(ss.enabled)
    setSecret(ss.secret ?? '')
    if (est && est.quota > 0) {
      setStorage(`${fmtBytes(est.used)} of ${fmtBytes(est.quota)} used`)
    }
  }, [])

  // A push+pull, then refresh so new ghosts / synced progress appear.
  const runSync = useCallback(
    async (label = 'Syncing…') => {
      setSyncing(true)
      setSyncMsg(label)
      const r = await syncNow()
      setSyncing(false)
      setSyncMsg(
        r.ok ? `Synced · ${r.pushed ?? 0} sent, ${r.pulled ?? 0} received` : `Sync: ${r.reason}`,
      )
      await refresh()
    },
    [refresh],
  )

  useEffect(() => {
    // Books are big and re-adding is a chore; ask the browser to keep them.
    void requestPersistentStorage().then(async () => {
      await refresh()
      // Pull anything new from other devices on open.
      const ss = await getSyncState()
      if (ss.enabled && syncConfigured()) void runSync('Checking for updates…')
    })
  }, [refresh, runSync])

  const onToggleSync = useCallback(async () => {
    if (syncOn) {
      await disableSync()
      setSyncOn(false)
      setSyncMsg('')
    } else {
      const s = await enableSync()
      setSyncOn(true)
      setSecret(s)
      await runSync('First sync…')
    }
  }, [syncOn, runSync])

  // Close the sync panel on Escape, like the reader's overlays.
  useEffect(() => {
    if (!showSyncPanel) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowSyncPanel(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showSyncPanel])

  const onAdopt = useCallback(async () => {
    if (await adoptSecret(adoptDraft)) {
      setAdoptDraft('')
      setSecret(adoptDraft.trim())
      setSyncOn(true)
      await runSync('Pulling your library…')
    } else {
      setSyncMsg('That secret doesn’t look right')
    }
  }, [adoptDraft, runSync])

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
      if (syncOn && syncConfigured()) void syncNow() // propagate the deletion
    },
    [refresh, syncOn],
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
    if (syncOn && syncConfigured()) void syncNow()
  }, [editing, draft, refresh, syncOn])

  // "Reading now" = the book you touched most recently.
  const hero =
    books && books.length
      ? [...books].sort((a, b) => lastTouched(b, progress) - lastTouched(a, progress))[0]
      : null

  const needle = filter.trim().toLowerCase()
  const filtered = !books
    ? []
    : needle
      ? books.filter((b) => b.title.toLowerCase().includes(needle))
      : books
  // listBooks() is already newest-first; the other orders sort a copy.
  const shown =
    sort === 'title'
      ? [...filtered].sort((a, b) => a.title.localeCompare(b.title))
      : sort === 'progress'
        ? [...filtered].sort(
            (a, b) => (progress[b.id]?.percent ?? 0) - (progress[a.id]?.percent ?? 0),
          )
        : filtered

  const meta = (b: Book) => {
    const p = progress[b.id]
    if (p?.finished) return 'Finished'
    if (!p) return 'Not started'
    return `${Math.round(p.percent * 100)}% · p. ${p.page} of ${b.pageCount}`
  }

  const toggleFinished = useCallback(
    async (b: Book) => {
      await setBookFinished(b.id, !progress[b.id]?.finished)
      await refresh()
    },
    [progress, refresh],
  )

  return (
    <div
      className="relative flex h-full flex-col overflow-y-auto overflow-x-hidden font-sans text-ink-body"
      style={{ background: 'linear-gradient(180deg, #231b12 0%, #1a140c 420px, #171208 100%)' }}
    >
      {/* The current book's own art, blurred, lights the room (design B).
          Falls back to the warm gradient alone when there's no thumbnail. */}
      {hero?.thumb && (
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[430px] overflow-hidden">
          <img
            src={hero.thumb}
            alt=""
            className="h-full w-full scale-125 object-cover"
            style={{ filter: 'blur(56px) saturate(1.1)', opacity: 0.38 }}
          />
          <div
            className="absolute inset-0"
            style={{
              background:
                'linear-gradient(180deg, rgba(23,18,8,0.25) 0%, rgba(23,18,8,0.82) 66%, #1a140c 100%)',
            }}
          />
        </div>
      )}
      <header className="safe-top sticky top-0 z-20 border-b border-white/[0.06] bg-[#1c1610]/70 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-[1180px] items-center gap-4 px-5 py-4 sm:px-8">
          {/* The crescent — the mark (the original favicon's slim moon, in gold). */}
          <svg viewBox="0 0 64 64" className="h-[30px] w-[30px] flex-none" aria-hidden>
            <path d="M40 20a16 16 0 1 0 8 22 13 13 0 0 1-8-22z" fill="url(#moongrad)" />
            <defs>
              <linearGradient id="moongrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#e8cc96" />
                <stop offset="1" stopColor="#c9a56a" />
              </linearGradient>
            </defs>
          </svg>
          <h1 className="font-serif text-xl font-semibold tracking-tight text-ink-bright">
            Nocturne
          </h1>
          <span className="-ml-1 text-[13px] text-ink-soft">Library</span>
          <div className="flex-1" />
          {stats && stats.todayMin > 0 && (
            <span className="hidden whitespace-nowrap rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-1.5 text-xs text-ink-mid backdrop-blur-md sm:inline-block">
              {stats.todayMin} min today
            </span>
          )}
          {storage && <span className="hidden text-xs text-ink-faint lg:block">{storage}</span>}
          <label className="cursor-pointer rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-accent-on transition-colors hover:bg-accent-hi">
            {busy ? 'Adding…' : 'Add PDF'}
            <input
              type="file"
              accept=".pdf,.epub,application/pdf,application/epub+zip"
              className="hidden"
              disabled={busy}
              onChange={(e) => e.target.files?.[0] && void onAdd(e.target.files[0])}
            />
          </label>
        </div>
      </header>

      <main className="relative mx-auto w-full max-w-[1180px] flex-1 px-5 pb-16 pt-8 sm:px-8 sm:pt-10">
        {books === null ? null : books.length === 0 && ghosts.length === 0 ? (
          <div className="anim-rise mt-24 text-center text-ink-dim">
            <p className="text-4xl">🌙</p>
            <p className="mt-5 font-serif text-xl text-ink-mid">No books yet.</p>
            <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed">
              Add a PDF — on iPhone the picker opens Files, so your iCloud Drive books are right
              there.
            </p>
            <p className="mx-auto mt-3 max-w-xs text-xs leading-relaxed text-ink-faint">
              Moving in from the browser version? Restore your backup file below, then re-add the
              same PDFs — your positions and highlights re-attach automatically.
            </p>
          </div>
        ) : (
          <>
            {hero && (
              <section className="anim-rise">
                {/* Design B hero: the book stands centered in its own light. */}
                <button
                  className="mx-auto flex w-full max-w-md flex-col items-center pt-2 text-center"
                  onClick={() => onOpen(hero.id)}
                >
                  <div
                    className="aspect-[3/4] flex-none overflow-hidden rounded-2xl"
                    style={{
                      width: 'clamp(140px,17vw,190px)',
                      boxShadow:
                        '0 34px 60px -20px rgba(0,0,0,.9), 0 0 0 1px rgba(255,255,255,0.07)',
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
                  <div
                    className="mt-5 font-serif leading-[1.15] tracking-tight text-ink-head"
                    style={{ fontSize: 'clamp(22px,2.6vw,30px)' }}
                  >
                    {hero.title}
                  </div>
                  <div className="mt-1.5 text-[13px] text-ink-mid">{meta(hero)}</div>
                  <div className="mt-2 flex w-full max-w-[280px] items-center">
                    <div className="h-[3px] flex-1 overflow-hidden rounded bg-white/10">
                      <div
                        className="h-full bg-gradient-to-r from-accent to-accent-hi"
                        style={{ width: `${Math.round((progress[hero.id]?.percent ?? 0) * 100)}%` }}
                      />
                    </div>
                  </div>
                  <span className="mt-5 inline-block rounded-full bg-accent px-8 py-2.5 text-sm font-semibold text-accent-on shadow-lg">
                    Resume reading
                  </span>
                </button>
              </section>
            )}

            {stats && stats.weekMin > 0 && (
              <div className="mx-auto mt-9 grid max-w-lg grid-cols-4 gap-2">
                {[
                  { n: String(stats.todayMin), u: 'min', k: 'today' },
                  {
                    n:
                      stats.weekMin >= 90
                        ? `${Math.floor(stats.weekMin / 60)}h ${stats.weekMin % 60}`
                        : String(stats.weekMin),
                    u: stats.weekMin >= 90 ? 'min' : 'min',
                    k: 'this week',
                  },
                  { n: String(stats.streak), u: stats.streak === 1 ? 'day' : 'days', k: 'streak' },
                  {
                    n: String(Object.values(progress).filter((p) => p.finished).length),
                    u: '',
                    k: 'finished',
                  },
                ].map((t) => (
                  <div
                    key={t.k}
                    className="rounded-xl border border-white/[0.06] bg-white/[0.04] px-2 py-3 text-center backdrop-blur-sm"
                  >
                    <div className="font-serif text-[19px] leading-none text-ink-head">
                      {t.n}
                      {t.u && <span className="ml-1 text-[11px] text-ink-dim">{t.u}</span>}
                    </div>
                    <div className="mt-1.5 text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                      {t.k}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {vocab.length > 0 && (
              <button
                className="mx-auto mt-4 flex w-full max-w-lg items-baseline gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.04] px-4 py-3 text-left backdrop-blur-sm transition-colors hover:border-accent/40"
                onClick={() => setShowVocab(true)}
              >
                <span className="font-serif text-[15px] text-ink-head">Vocabulary</span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-dim">
                  {vocab.slice(0, 3).map((v) => v.word).join(' · ')}
                </span>
                <span className="flex-none text-[12px] tabular-nums text-accent">{vocab.length} ›</span>
              </button>
            )}

            <div className="mb-5 mt-12 flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="font-serif text-[22px] text-ink-head">Your shelf</h2>
              <div className="flex items-baseline gap-3">
                {books.length > 1 && (
                  <select
                    aria-label="Sort books"
                    className="rounded-lg border border-line bg-inset px-2 py-1 text-[13px] text-ink-body outline-none focus:border-accent/60"
                    value={sort}
                    onChange={(e) => {
                      const v = e.target.value as 'recent' | 'title' | 'progress'
                      setSort(v)
                      try {
                        localStorage.setItem('nocturne-shelf-sort', v)
                      } catch {
                        /* private mode */
                      }
                    }}
                  >
                    <option value="recent">Recent</option>
                    <option value="title">Title</option>
                    <option value="progress">Progress</option>
                  </select>
                )}
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
                  {shown.length !== books.length
                    ? `${shown.length} of ${books.length}`
                    : `${books.length} here${ghosts.length ? ` · ${ghosts.length} to add` : ''}`}
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
                        {marks[b.id] > 0 && (
                          <span className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] tabular-nums text-accent">
                            ★ {marks[b.id]}
                          </span>
                        )}
                        {/* progress strip along the cover's bottom edge */}
                        <div className="absolute inset-x-0 bottom-0 h-[3px] bg-black/30">
                          <div
                            className="h-full bg-accent"
                            style={{ width: `${p?.finished ? 100 : pct}%` }}
                          />
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
                      <span className={`truncate ${p?.finished ? 'text-accent' : ''}`}>
                        {p?.finished ? '✓ Finished' : p ? `${pct}% · p. ${p.page}` : 'Not started'}
                      </span>
                      <span className="ml-2 flex-none">
                        {fmtBytes(b.size)}
                        {p ? ` · ${relTime(p.updatedAt)}` : ''}
                      </span>
                    </div>

                    <div className="absolute right-2 top-2 flex gap-1.5">
                      <button
                        aria-label={p?.finished ? `Mark ${b.title} unfinished` : `Mark ${b.title} finished`}
                        className={`rounded-full bg-black/60 px-2 py-0.5 text-xs transition-opacity hover:opacity-100 ${
                          p?.finished ? 'text-accent opacity-100' : 'text-ink-body opacity-60'
                        }`}
                        onClick={() => void toggleFinished(b)}
                      >
                        ✓
                      </button>
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

              {/* Ghosts: books you have on another device but not here. Your
                  place/marks are already synced; add the file to start reading. */}
              {!needle && ghosts.length > 0 && (
                <div
                  className="rounded-xl border border-line bg-night-900/40 px-4 py-3"
                  style={{ gridColumn: '1 / -1' }}
                >
                  <div className="text-[13px] font-medium text-ink-shelf">
                    {ghosts.length} {ghosts.length === 1 ? 'book' : 'books'} from your other device
                  </div>
                  <div className="mt-1 text-xs leading-relaxed text-ink-faint">
                    Sync brings your place, bookmarks and highlights — not the PDF itself. Tap a book
                    below and pick its file from Files/iCloud; it opens right where you left off.
                  </div>
                </div>
              )}
              {!needle &&
                ghosts.map((g) => (
                  <div key={`ghost-${g.bookId}`} className="anim-rise relative">
                    <label className="block cursor-pointer text-left">
                      <div
                        className="grid aspect-[3/4] w-full place-items-center rounded-[13px] border border-dashed border-accent/30 bg-night-900/50 p-4 text-center transition-colors hover:border-accent/60"
                        title="Pick this book's PDF from Files to read it here"
                      >
                        <div>
                          <div className="text-2xl text-accent/70">＋</div>
                          <div className="mt-2 text-[11px] uppercase tracking-[0.12em] text-accent/80">
                            {busy ? 'Adding…' : 'Add its file'}
                          </div>
                          <div className="mt-1 text-[10px] text-ink-faint">from Files / iCloud</div>
                        </div>
                      </div>
                      <input
                        type="file"
                        accept=".pdf,.epub,application/pdf,application/epub+zip"
                        className="hidden"
                        disabled={busy}
                        onChange={(e) => e.target.files?.[0] && void onAdd(e.target.files[0])}
                      />
                    </label>
                    <div className="mt-3 truncate font-serif text-[15px] leading-tight text-ink-mid">
                      {g.title}
                    </div>
                    <div className="mt-1 text-xs text-ink-faint">Tap to add · synced</div>
                  </div>
                ))}
            </div>
          </>
        )}
      </main>

      {/* Vocabulary notebook: every word saved from the dictionary card —
          searchable, annotatable, deletable (with undo). */}
      {showVocab && (
        <div
          className="anim-fade fixed inset-0 z-40 flex items-end justify-center bg-black/50 sm:items-center"
          onClick={() => setShowVocab(false)}
        >
          <div
            className="anim-rise flex max-h-[85dvh] w-full max-w-md flex-col rounded-t-2xl border border-line bg-panel p-5 sm:max-h-[80vh] sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-serif text-lg text-ink-bright">
                Vocabulary <span className="ml-1 text-[12px] text-ink-faint">{vocab.length}</span>
              </h3>
              <button
                aria-label="Close vocabulary"
                className="h-8 w-8 rounded-lg border border-line bg-inset text-ink-soft hover:text-ink-body"
                onClick={() => setShowVocab(false)}
              >
                ✕
              </button>
            </div>
            {vocab.length > 6 && (
              <input
                aria-label="Search words"
                placeholder="Search…"
                className="mb-3 rounded-lg border border-line bg-inset px-2.5 py-2 text-[13px] text-ink-body outline-none placeholder:text-ink-faint focus:border-accent/60"
                value={vocabQuery}
                onChange={(e) => setVocabQuery(e.target.value)}
              />
            )}
            {lastDeleted && (
              <div className="mb-2 flex items-center justify-between rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-mid">
                <span>“{lastDeleted.word}” deleted</span>
                <button
                  className="font-semibold text-accent"
                  onClick={() => {
                    void restoreVocabWord(lastDeleted).then(async () => {
                      setLastDeleted(null)
                      setVocab(await listVocab())
                    })
                  }}
                >
                  Undo
                </button>
              </div>
            )}
            <div className="-mx-1 flex-1 overflow-y-auto px-1">
              {vocab
                .filter(
                  (v) =>
                    !vocabQuery ||
                    v.word.toLowerCase().includes(vocabQuery.toLowerCase()) ||
                    v.def.toLowerCase().includes(vocabQuery.toLowerCase()),
                )
                .map((v) => (
                  <div key={v.id} className="border-b border-line/50 py-2.5 last:border-b-0">
                    <button
                      className="flex w-full items-baseline gap-2 text-left"
                      onClick={() => setVocabOpen((o) => (o === v.id ? null : v.id))}
                    >
                      <span className="font-serif text-[15px] text-ink-bright">{v.word}</span>
                      <span className="rounded bg-inset px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-accent">
                        {v.pos}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-ink-mid">
                        {v.note || v.def}
                      </span>
                    </button>
                    {vocabOpen === v.id && (
                      <div className="anim-fade mt-2 space-y-2 pl-1">
                        <p className="text-[12.5px] leading-snug text-ink-mid">{v.def}</p>
                        {v.context && (
                          <p className="border-l-2 border-line/70 pl-2.5 text-[12px] italic text-ink-soft">
                            {v.context}
                          </p>
                        )}
                        {v.bookTitle && (
                          <p className="text-[11px] text-ink-faint">from {v.bookTitle}</p>
                        )}
                        <div className="flex items-center gap-2">
                          <input
                            aria-label={`Note for ${v.word}`}
                            placeholder="Your note…"
                            className="min-w-0 flex-1 rounded-lg border border-line bg-inset px-2.5 py-1.5 text-[12.5px] text-ink-body outline-none placeholder:text-ink-faint focus:border-accent/60"
                            value={noteDrafts[v.id] ?? v.note ?? ''}
                            onChange={(e) =>
                              setNoteDrafts((d) => ({ ...d, [v.id]: e.target.value }))
                            }
                            onBlur={() => {
                              const draft = noteDrafts[v.id]
                              if (draft !== undefined && draft !== (v.note ?? ''))
                                void updateVocabWord(v.id, { note: draft || undefined }).then(
                                  async () => setVocab(await listVocab()),
                                )
                            }}
                          />
                          <button
                            aria-label={`Delete ${v.word}`}
                            className="flex-none rounded-lg border border-line px-2.5 py-1.5 text-[12px] text-ink-soft hover:text-ink-body"
                            onClick={() => {
                              void deleteVocabWord(v.id).then(async (row) => {
                                setLastDeleted(row ?? null)
                                setVocab(await listVocab())
                              })
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              {vocab.length === 0 && (
                <p className="py-8 text-center text-[13px] text-ink-faint">
                  Double-tap any word while reading, then ＋ Save.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Install: the one action that makes the library durable on iOS — an
          installed app is exempt from Safari's storage cleanup. Chromium gets
          the real prompt; iOS gets the two steps Apple allows us to describe. */}
      {!installed && (
        <div className="mx-auto w-full max-w-[1180px] px-5 pb-3 sm:px-8">
          <button
            className="w-full rounded-2xl border border-line bg-inset px-5 py-3.5 text-left transition-colors hover:border-accent/50"
            onClick={() => {
              if (installEvt) void installEvt.prompt()
              else setShowInstallHelp((s) => !s)
            }}
          >
            <span className="text-[14px] font-semibold text-accent">Install Nocturne</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-ink-dim">
              Keeps your library safe from browser cleanup.
            </span>
          </button>
          {showInstallHelp && (
            <p className="anim-fade mt-2 rounded-xl bg-inset px-4 py-3 text-xs leading-relaxed text-ink-mid">
              {isIOS()
                ? 'In Safari: tap the Share button, then “Add to Home Screen”. Nocturne appears as an app icon and opens full-screen. Heads-up: the installed app keeps its own separate library — tap Backup here first, then Restore inside the installed app, and re-add the PDFs from Files (positions and highlights re-attach automatically).'
                : 'In your browser menu, look for “Install Nocturne” or “Add to Home Screen”.'}
            </p>
          )}
        </div>
      )}

      {/* Durability: say plainly whether these books are safe here, and give
          the two escape hatches (backup file, restore) that make them so. */}
      <footer className="safe-bottom mx-auto flex w-full max-w-[1180px] flex-wrap items-center justify-center gap-x-4 gap-y-1 px-5 pb-5 text-xs text-ink-faint sm:justify-between sm:px-8">
        <span className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${durable ? 'bg-accent' : 'bg-ink-faint'}`} />
          {durable === null
            ? ''
            : durable
              ? 'Saved on this device'
              : 'Not persisted — add to Home Screen to keep books safe'}
          {storage && <span className="ml-2 opacity-70">· {storage}</span>}
        </span>
        <span className="flex items-center gap-4">
          {note && <span className="text-ink-dim">{note}</span>}
          {syncConfigured() && (
            <button
              className="underline-offset-2 hover:text-ink-soft hover:underline"
              onClick={() => setShowSyncPanel((s) => !s)}
            >
              {syncOn ? (syncing ? 'Syncing…' : 'Sync ✓') : 'Sync'}
            </button>
          )}
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

      {/* Sync panel: device secret + controls. Opt-in, state-only. */}
      {showSyncPanel && (
        <div
          className="anim-fade fixed inset-0 z-40 flex items-end justify-center bg-black/50 sm:items-center"
          onClick={() => setShowSyncPanel(false)}
        >
          <div
            className="anim-rise w-full max-w-md rounded-t-2xl border border-line bg-panel p-6 sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-serif text-lg text-ink-bright">Sync across devices</h3>
              <button
                aria-label="Close sync"
                className="h-8 w-8 rounded-lg border border-line bg-inset text-ink-soft hover:text-ink-body"
                onClick={() => setShowSyncPanel(false)}
              >
                ✕
              </button>
            </div>
            <p className="mb-5 text-xs leading-relaxed text-ink-faint">
              Your reading position, look, bookmarks and highlights sync end-to-end encrypted. Your
              PDFs never leave this device — on another device you re-add the file and it resumes.
            </p>

            <label className="mb-5 flex items-center justify-between">
              <span className="text-[13px] text-ink-body">Sync this device</span>
              <input
                type="checkbox"
                aria-label="Enable sync"
                className="h-4 w-4 accent-accent"
                checked={syncOn}
                onChange={() => void onToggleSync()}
              />
            </label>

            {syncOn && (
              <>
                <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-ink-kicker">
                  Your device secret
                </div>
                <div className="mb-2 flex gap-2">
                  <input
                    aria-label="Device secret"
                    readOnly
                    className="flex-1 truncate rounded-lg border border-line bg-inset px-2.5 py-2 font-mono text-xs text-ink-mid"
                    value={secret}
                  />
                  <button
                    className="rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-accent-on"
                    onClick={() => void navigator.clipboard?.writeText(secret)}
                  >
                    Copy
                  </button>
                </div>
                <p className="mb-5 text-xs leading-relaxed text-ink-faint">
                  Paste this into Nocturne on your other device to join the same library. Anyone with
                  it can read your sync data — keep it private.
                </p>
                <button
                  className="mb-4 w-full rounded-xl border border-accent/40 py-2.5 text-sm font-medium text-accent hover:border-accent disabled:opacity-50"
                  disabled={syncing}
                  onClick={() => void runSync('Syncing…')}
                >
                  {syncing ? 'Syncing…' : 'Sync now'}
                </button>
              </>
            )}

            <details className="text-xs text-ink-faint">
              <summary className="cursor-pointer">Use a secret from another device</summary>
              <div className="mt-2 flex gap-2">
                <input
                  aria-label="Paste secret"
                  placeholder="Paste device secret"
                  className="flex-1 rounded-lg border border-line bg-inset px-2.5 py-2 font-mono text-xs text-ink-body outline-none focus:border-accent/60"
                  value={adoptDraft}
                  onChange={(e) => setAdoptDraft(e.target.value)}
                />
                <button
                  className="rounded-lg bg-night-700 px-3 py-2 text-[13px] text-ink-body"
                  onClick={() => void onAdopt()}
                >
                  Use
                </button>
              </div>
            </details>

            {syncMsg && <div className="mt-4 text-center text-xs text-ink-dim">{syncMsg}</div>}
          </div>
        </div>
      )}
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

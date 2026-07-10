import { useCallback, useEffect, useState } from 'react'
import {
  allProgress,
  deleteBook,
  listBooks,
  requestPersistentStorage,
  storageEstimate,
  type Book,
  type ProgressByBook,
} from '../storage/db'
import { importBook } from './import'

// The shelf: every book you've added, with a recolored cover, how far you are,
// and when you last read it. Tap to resume. Books live in this device's browser
// storage; iCloud (via the Files picker) stays the master library.

interface ShelfProps {
  onOpen: (bookId: string) => void
}

export function Shelf({ onOpen }: ShelfProps) {
  const [books, setBooks] = useState<Book[] | null>(null)
  const [progress, setProgress] = useState<ProgressByBook>({})
  const [storage, setStorage] = useState<string>('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const [bs, ps, est] = await Promise.all([listBooks(), allProgress(), storageEstimate()])
    setBooks(bs)
    setProgress(ps)
    if (est && est.quota > 0) {
      setStorage(`${fmtBytes(est.used)} of ${fmtBytes(est.quota)} used`)
    }
  }, [])

  useEffect(() => {
    // Books are big and re-adding is a chore; ask the browser to keep them.
    void requestPersistentStorage()
    void refresh()
  }, [refresh])

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

  return (
    <div className="flex h-full flex-col bg-night-950 text-neutral-200">
      <header className="flex items-baseline gap-3 px-4 py-4">
        <h1 className="text-lg font-semibold tracking-tight">Nocturne</h1>
        <span className="text-sm text-neutral-500">Library</span>
        <label className="ml-auto cursor-pointer rounded-md bg-night-700 px-3 py-1.5 text-sm hover:bg-night-800">
          {busy ? 'Adding…' : 'Add book'}
          <input
            type="file"
            accept="application/pdf"
            className="hidden"
            disabled={busy}
            onChange={(e) => e.target.files?.[0] && void onAdd(e.target.files[0])}
          />
        </label>
      </header>

      <div className="flex-1 overflow-auto px-4 pb-8">
        {books === null ? null : books.length === 0 ? (
          <div className="mt-24 text-center text-neutral-500">
            <p className="text-4xl">🌙</p>
            <p className="mt-4">No books yet.</p>
            <p className="mt-1 text-sm">
              Add a PDF — on iPhone the picker opens Files, so your iCloud Drive books are right there.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {books.map((b) => {
              const p = progress[b.id]
              const pct = p ? Math.round(p.percent * 100) : 0
              return (
                <div key={b.id} className="group relative">
                  <button
                    className="block w-full overflow-hidden rounded-lg bg-night-800 text-left shadow-lg"
                    onClick={() => onOpen(b.id)}
                  >
                    {b.thumb ? (
                      <img src={b.thumb} alt="" className="aspect-[3/4] w-full object-cover" />
                    ) : (
                      <div className="grid aspect-[3/4] w-full place-items-center text-3xl text-neutral-600">
                        🌙
                      </div>
                    )}
                    <div className="p-2.5">
                      <div className="truncate text-sm font-medium">{b.title}</div>
                      <div className="mt-1 flex items-baseline justify-between text-xs text-neutral-500">
                        <span>{p ? `${pct}% · p.${p.page}` : 'Not started'}</span>
                        <span>{p ? relTime(p.updatedAt) : ''}</span>
                      </div>
                      {/* progress bar */}
                      <div className="mt-2 h-0.5 w-full rounded bg-night-700">
                        <div className="h-0.5 rounded bg-neutral-400" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  </button>
                  <button
                    aria-label={`Remove ${b.title}`}
                    className="absolute right-1.5 top-1.5 rounded-full bg-black/60 px-2 py-0.5 text-xs text-neutral-300 opacity-70 hover:opacity-100"
                    onClick={() => void onDelete(b)}
                  >
                    ✕
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {storage && (
        <footer className="px-4 pb-3 text-center text-xs text-neutral-600">{storage}</footer>
      )}
    </div>
  )
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

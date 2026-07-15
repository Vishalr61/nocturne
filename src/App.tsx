import { useState } from 'react'
import { Reader } from './reader/Reader'
import { Shelf } from './library/Shelf'

// Two surfaces: the shelf (your saved books) and the reader. Launch always
// opens the shelf — the library is the home screen — and the current book
// resumes with one tap from there.
export default function App() {
  const [bookId, setBookId] = useState<string | null>(null)
  const [route, setRoute] = useState<'shelf' | 'reader'>('shelf')

  return (
    <div className="h-[100dvh] w-full bg-night-950">
      {route === 'shelf' && (
        <Shelf
          onOpen={(id) => {
            setBookId(id)
            setRoute('reader')
          }}
        />
      )}
      {route === 'reader' && bookId && (
        <Reader bookId={bookId} onShelf={() => setRoute('shelf')} />
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { Reader } from './reader/Reader'
import { Shelf } from './library/Shelf'
import { latestBookId } from './storage/db'

// Two surfaces: the shelf (your saved books) and the reader. Launch goes
// straight into the book you were last reading — pick up the phone, keep
// reading — with the shelf one tap away in the reader header.
export default function App() {
  const [bookId, setBookId] = useState<string | null>(null)
  const [route, setRoute] = useState<'boot' | 'shelf' | 'reader'>('boot')

  useEffect(() => {
    void latestBookId().then((id) => {
      if (id) {
        setBookId(id)
        setRoute('reader')
      } else {
        setRoute('shelf')
      }
    })
  }, [])

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

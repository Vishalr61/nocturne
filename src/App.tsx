import { Reader } from './reader/Reader'

// v1 is a single-surface app: the reader. The library screen (your shelf of saved
// books with resume) lands next, then the export-to-dark-PDF flow that fits the
// "download → open in Books" habit. Kept intentionally minimal here.
export default function App() {
  return (
    <div className="h-[100dvh] w-full">
      <Reader />
    </div>
  )
}

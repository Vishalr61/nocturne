import type { Bookmark, Highlight } from '../storage/db'

// Notes leave the app as plain Markdown — the least lock-in format there is.
// Highlights are stored as character ranges (see storage/db.ts), but for the
// export the captured passage text is what matters.

const day = (ts: number) =>
  new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

export function notesMarkdown(
  title: string,
  bookmarks: Bookmark[],
  highlights: Highlight[],
): string {
  const lines: string[] = [`# ${title || 'Untitled'} — notes`, '']
  lines.push(`Exported from Nocturne on ${day(Date.now())}.`, '')

  if (bookmarks.length) {
    lines.push('## Bookmarks', '')
    for (const b of [...bookmarks].sort((a, z) => a.page - z.page)) {
      lines.push(`- p. ${b.page}${b.note ? ` — ${b.note}` : ''}`)
    }
    lines.push('')
  }

  if (highlights.length) {
    lines.push('## Highlights', '')
    for (const h of [...highlights].sort((a, z) => a.page - z.page || a.start - z.start)) {
      lines.push(`> ${h.text.trim()}`, `> — p. ${h.page}, ${day(h.createdAt)}`, '')
    }
  }

  return lines.join('\n')
}

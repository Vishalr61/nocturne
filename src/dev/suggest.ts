// Dev-only "suggest mode": tap the ✎ chip, then tap any element in the running
// app, type what you want changed, and the note (plus a description of the
// element you tapped) is appended to design-notes.jsonl at the repo root via
// the /__suggest middleware in vite.config.ts. A coding agent watches that
// file and edits the real source; HMR shows the change live.
//
// Loaded exclusively behind `import.meta.env.DEV` in main.tsx — never part of
// a production build. Everything here is plain DOM on purpose: it must sit on
// top of the React tree without participating in it.

type Descriptor = {
  url: string
  viewport: { w: number; h: number }
  tag: string
  id: string | null
  classes: string[]
  text: string
  attrs: Record<string, string>
  domPath: string
  rect: { x: number; y: number; w: number; h: number }
  html: string
}

const Z = 2147483000

const root = document.createElement('div')
root.id = 'nocturne-suggest-root'
document.body.appendChild(root)

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: Partial<CSSStyleDeclaration>,
  parent: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  Object.assign(node.style, style)
  parent.appendChild(node)
  return node
}

// ---- element description --------------------------------------------------

function pathOf(target: Element): string {
  const parts: string[] = []
  let cur: Element | null = target
  while (cur && cur !== document.body && parts.length < 8) {
    let part = cur.tagName.toLowerCase()
    if (cur.id) {
      part += `#${cur.id}`
    } else {
      const cls = Array.from(cur.classList).slice(0, 3).join('.')
      if (cls) part += `.${cls}`
      const parent = cur.parentElement
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName)
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`
      }
    }
    parts.unshift(part)
    cur = cur.parentElement
  }
  return parts.join(' > ')
}

function describe(target: Element): Descriptor {
  const r = target.getBoundingClientRect()
  const attrs: Record<string, string> = {}
  for (const a of Array.from(target.attributes)) {
    if (a.name === 'class' || a.name === 'style') continue
    if (a.value.length <= 80) attrs[a.name] = a.value
  }
  return {
    url: location.href,
    viewport: { w: innerWidth, h: innerHeight },
    tag: target.tagName.toLowerCase(),
    id: target.id || null,
    classes: Array.from(target.classList),
    text: (target.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 120),
    attrs,
    domPath: pathOf(target),
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    html: target.outerHTML.slice(0, 500),
  }
}

function shortLabel(d: Descriptor): string {
  const cls = d.classes.slice(0, 2).join('.')
  const name = `<${d.tag}${d.id ? '#' + d.id : cls ? '.' + cls : ''}>`
  return d.text ? `${name} “${d.text.slice(0, 40)}”` : name
}

// ---- UI: chip, overlay, highlight, panel ----------------------------------

const chip = make(
  'button',
  {
    position: 'fixed',
    left: '10px',
    bottom: '10px',
    width: '38px',
    height: '38px',
    borderRadius: '19px',
    border: '1px solid rgba(201,165,106,.5)',
    background: 'rgba(21,17,11,.85)',
    color: '#c9a56a',
    font: '16px/36px Inter, sans-serif',
    zIndex: String(Z + 2),
    cursor: 'pointer',
  },
  root,
)
chip.id = 'suggest-chip'
chip.textContent = '✎'
chip.title = 'Suggest a change (dev only)'

const overlay = make(
  'div',
  {
    position: 'fixed',
    inset: '0',
    zIndex: String(Z),
    cursor: 'crosshair',
    display: 'none',
    touchAction: 'none',
  },
  root,
)

const highlight = make(
  'div',
  {
    position: 'fixed',
    border: '2px solid #7aa2ff',
    background: 'rgba(122,162,255,.14)',
    borderRadius: '3px',
    pointerEvents: 'none',
    zIndex: String(Z + 1),
    display: 'none',
  },
  root,
)

const panel = make(
  'div',
  {
    position: 'fixed',
    left: '10px',
    right: '10px',
    bottom: '10px',
    zIndex: String(Z + 2),
    background: '#1c1712',
    border: '1px solid #3a2f22',
    borderRadius: '12px',
    padding: '12px',
    font: '13px Inter, sans-serif',
    color: '#e8ddca',
    display: 'none',
    boxShadow: '0 8px 32px rgba(0,0,0,.5)',
  },
  root,
)

const panelLabel = make(
  'div',
  { font: '12px ui-monospace, monospace', color: '#c9a56a', marginBottom: '8px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  panel,
)

const noteBox = make(
  'textarea',
  {
    width: '100%',
    minHeight: '64px',
    background: '#15110b',
    color: '#e8ddca',
    border: '1px solid #3a2f22',
    borderRadius: '8px',
    padding: '8px',
    font: '14px Inter, sans-serif',
    resize: 'vertical',
    boxSizing: 'border-box',
  },
  panel,
)
noteBox.id = 'suggest-note'
noteBox.placeholder = 'What should change here?'

const buttonRow = make('div', { display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center' }, panel)

const sendBtn = make(
  'button',
  {
    background: '#c9a56a',
    color: '#15110b',
    border: 'none',
    borderRadius: '8px',
    padding: '8px 16px',
    font: '600 13px Inter, sans-serif',
    cursor: 'pointer',
  },
  buttonRow,
)
sendBtn.id = 'suggest-send'
sendBtn.textContent = 'Send'

const cancelBtn = make(
  'button',
  {
    background: 'transparent',
    color: '#a08d6e',
    border: '1px solid #3a2f22',
    borderRadius: '8px',
    padding: '8px 16px',
    font: '13px Inter, sans-serif',
    cursor: 'pointer',
  },
  buttonRow,
)
cancelBtn.textContent = 'Cancel'

const status = make('span', { color: '#a08d6e', font: '12px Inter, sans-serif' }, buttonRow)

// ---- state machine ---------------------------------------------------------

let picking = false
let selected: Descriptor | null = null

function setPicking(on: boolean) {
  picking = on
  overlay.style.display = on ? 'block' : 'none'
  chip.style.background = on ? '#c9a56a' : 'rgba(21,17,11,.85)'
  chip.style.color = on ? '#15110b' : '#c9a56a'
  if (!on) {
    highlight.style.display = 'none'
    panel.style.display = 'none'
    selected = null
  }
}

function targetAt(x: number, y: number): Element | null {
  for (const cand of document.elementsFromPoint(x, y)) {
    if (!root.contains(cand)) return cand
  }
  return null
}

function moveHighlight(target: Element) {
  const r = target.getBoundingClientRect()
  highlight.style.display = 'block'
  highlight.style.left = `${r.x - 2}px`
  highlight.style.top = `${r.y - 2}px`
  highlight.style.width = `${r.width}px`
  highlight.style.height = `${r.height}px`
}

chip.addEventListener('click', () => setPicking(!picking))

overlay.addEventListener('pointermove', (e) => {
  if (panel.style.display !== 'none') return
  const target = targetAt(e.clientX, e.clientY)
  if (target) moveHighlight(target)
})

overlay.addEventListener('click', (e) => {
  e.preventDefault()
  e.stopPropagation()
  if (panel.style.display !== 'none') return
  const target = targetAt(e.clientX, e.clientY)
  if (!target) return
  moveHighlight(target)
  selected = describe(target)
  panelLabel.textContent = shortLabel(selected)
  status.textContent = ''
  noteBox.value = ''
  panel.style.display = 'block'
  noteBox.focus()
})

async function send() {
  if (!selected || !noteBox.value.trim()) return
  sendBtn.disabled = true
  status.textContent = 'sending…'
  try {
    const res = await fetch('/__suggest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: noteBox.value.trim(), target: selected }),
    })
    if (!res.ok) throw new Error(String(res.status))
    status.textContent = '✓ sent'
    setTimeout(() => setPicking(false), 600)
  } catch {
    status.textContent = 'failed — is this the vite dev server?'
  } finally {
    sendBtn.disabled = false
  }
}

sendBtn.addEventListener('click', () => void send())
cancelBtn.addEventListener('click', () => {
  panel.style.display = 'none'
  selected = null
})
noteBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send()
  e.stopPropagation() // keep reader shortcuts (T, arrows…) from firing while typing
})
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && picking) {
    if (panel.style.display !== 'none') {
      panel.style.display = 'none'
      selected = null
    } else {
      setPicking(false)
    }
  }
})

export {}

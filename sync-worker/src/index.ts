// Nocturne state-sync Worker. A tiny last-write-wins sync over a D1 table.
//
// It is deliberately dumb about content: every record is an opaque id + an
// encrypted payload the Worker never decrypts. Its only jobs are (1) resolve
// per-record conflicts by `updatedAt` (last write wins) and (2) hand each
// device the records it hasn't seen (those with `seq` past its cursor). PDF
// bytes never come near this — see the project guardrail.

export interface Env {
  DB: D1Database
}

interface Change {
  id: string
  updatedAt: number
  deleted?: boolean
  payload?: string | null
}

const MAX_CHANGES = 2000
const MAX_PAYLOAD = 64 * 1024 // 64 KB ciphertext per record is ample for state
const PULL_LIMIT = 2000
const USER_KEY_RE = /^[A-Za-z0-9_-]{16,64}$/ // base64url-ish hash, bounded

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS })

    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/v1/sync') {
      return sync(request, env)
    }
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'nocturne-sync' })
    }
    return json({ error: 'not-found' }, 404)
  },
}

async function sync(request: Request, env: Env): Promise<Response> {
  let body: { userKey?: unknown; since?: unknown; changes?: unknown }
  try {
    body = await request.json()
  } catch {
    return json({ error: 'bad-json' }, 400)
  }

  const userKey = body.userKey
  if (typeof userKey !== 'string' || !USER_KEY_RE.test(userKey)) {
    return json({ error: 'bad-user-key' }, 400)
  }
  const since = typeof body.since === 'number' && body.since >= 0 ? Math.floor(body.since) : 0
  const changes = Array.isArray(body.changes) ? body.changes : []
  if (changes.length > MAX_CHANGES) return json({ error: 'too-many-changes' }, 413)

  // Validate every change before touching the DB.
  const clean: Change[] = []
  for (const c of changes) {
    if (
      !c ||
      typeof c.id !== 'string' ||
      c.id.length === 0 ||
      c.id.length > 128 ||
      typeof c.updatedAt !== 'number' ||
      !Number.isFinite(c.updatedAt)
    ) {
      return json({ error: 'bad-change' }, 400)
    }
    const payload = c.payload == null ? null : String(c.payload)
    if (payload !== null && payload.length > MAX_PAYLOAD) return json({ error: 'payload-too-large' }, 413)
    clean.push({ id: c.id, updatedAt: Math.floor(c.updatedAt), deleted: !!c.deleted, payload })
  }

  // Push: reserve a contiguous block of seq numbers for this batch, then upsert
  // each change last-write-wins. Reserving up front (RETURNING) keeps seq unique
  // even if two devices push at once; rejected (older) writes just leave a gap.
  if (clean.length > 0) {
    const [, reserved] = await env.DB.batch([
      env.DB.prepare('INSERT INTO counters (userKey, seq) VALUES (?, 0) ON CONFLICT(userKey) DO NOTHING').bind(
        userKey,
      ),
      env.DB.prepare('UPDATE counters SET seq = seq + ? WHERE userKey = ? RETURNING seq').bind(
        clean.length,
        userKey,
      ),
    ])
    const top = (reserved.results?.[0] as { seq: number } | undefined)?.seq ?? clean.length
    const base = top - clean.length

    const upsert = env.DB.prepare(
      `INSERT INTO records (userKey, id, updatedAt, deleted, payload, seq)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(userKey, id) DO UPDATE SET
         updatedAt = excluded.updatedAt,
         deleted   = excluded.deleted,
         payload   = excluded.payload,
         seq       = excluded.seq
       WHERE excluded.updatedAt > records.updatedAt`,
    )
    await env.DB.batch(
      clean.map((c, i) =>
        upsert.bind(userKey, c.id, c.updatedAt, c.deleted ? 1 : 0, c.payload, base + i + 1),
      ),
    )
  }

  // Pull: everything this device hasn't seen, in seq order.
  const rows = await env.DB.prepare(
    'SELECT id, updatedAt, deleted, payload, seq FROM records WHERE userKey = ? AND seq > ? ORDER BY seq LIMIT ?',
  )
    .bind(userKey, since, PULL_LIMIT)
    .all<{ id: string; updatedAt: number; deleted: number; payload: string | null; seq: number }>()

  const out = (rows.results ?? []).map((r) => ({
    id: r.id,
    updatedAt: r.updatedAt,
    deleted: !!r.deleted,
    payload: r.payload,
    seq: r.seq,
  }))
  const cursor = out.length ? out[out.length - 1].seq : since
  return json({ changes: out, cursor, more: out.length === PULL_LIMIT })
}

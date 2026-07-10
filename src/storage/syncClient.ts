import { getSyncState, setSyncState } from './db'
import { collectLocal, applyRemote } from './syncModel'
import {
  decryptJson,
  deriveKeys,
  encryptJson,
  generateSecret,
  isValidSecret,
  recordId,
  type SyncKeys,
} from './syncCrypto'

// The sync loop: derive keys from the device secret, push everything changed
// since our high-water mark, pull everything past our cursor, and merge it in
// last-write-wins. No PDF bytes, no plaintext, no account — see syncCrypto.ts.

// The deployed Worker. Overridable via localStorage for local testing.
const DEFAULT_SYNC_URL = 'https://nocturne-sync.PENDING.workers.dev/v1/sync'
export function syncUrl(): string {
  try {
    return localStorage.getItem('nocturne-sync-url') || DEFAULT_SYNC_URL
  } catch {
    return DEFAULT_SYNC_URL
  }
}
export function syncConfigured(): boolean {
  return !syncUrl().includes('PENDING')
}

interface WireChange {
  id: string
  updatedAt: number
  deleted: boolean
  payload: string | null
}

interface SyncResult {
  ok: boolean
  reason?: string
  pushed?: number
  pulled?: number
}

let inFlight: Promise<SyncResult> | null = null

/** Run a full push+pull. Concurrent calls share the one in-flight run. */
export function syncNow(): Promise<SyncResult> {
  if (inFlight) return inFlight
  inFlight = runSync().finally(() => {
    inFlight = null
  })
  return inFlight
}

async function runSync(): Promise<SyncResult> {
  const state = await getSyncState()
  if (!state.enabled || !state.secret || !isValidSecret(state.secret)) {
    return { ok: false, reason: 'disabled' }
  }
  if (!syncConfigured()) return { ok: false, reason: 'no-endpoint' }

  const keys = await deriveKeys(state.secret)

  // --- push: everything changed since our high-water mark --------------------
  const local = await collectLocal(state.pushedHigh)
  const changes: WireChange[] = await Promise.all(
    local.map(async (r) => ({
      id: await recordId(keys, r.naturalKey),
      updatedAt: r.updatedAt,
      deleted: r.deleted,
      // updatedAt lives inside the authenticated ciphertext too, so apply trusts it.
      payload: await encryptJson(keys, { ...r.body, updatedAt: r.updatedAt, deleted: r.deleted }),
    })),
  )
  let maxLocal = state.pushedHigh
  for (const r of local) maxLocal = Math.max(maxLocal, r.updatedAt)

  // First round carries the push; later rounds (if `more`) are pull-only.
  let cursor = state.cursor
  let maxApplied = 0
  let pulled = 0
  let pushedThisRun = changes
  for (let round = 0; round < 50; round++) {
    let resp: { changes: WireChange[]; cursor: number; more: boolean }
    try {
      resp = await post(keys, cursor, pushedThisRun)
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : 'network' }
    }
    pushedThisRun = [] // only the first round pushes
    for (const c of resp.changes) {
      if (c.payload == null) continue
      const body = await decryptJson<Record<string, unknown>>(keys, c.payload)
      if (!body) continue // not ours / wrong secret — leave it alone
      maxApplied = Math.max(maxApplied, await applyRemote(body))
      pulled++
    }
    cursor = resp.cursor
    if (!resp.more) break
  }

  await setSyncState({
    cursor,
    // Everything pushed is on the server; everything applied came from it — so
    // neither should be re-pushed next time.
    pushedHigh: Math.max(state.pushedHigh, maxLocal, maxApplied),
    lastSyncAt: Date.now(),
  })
  return { ok: true, pushed: changes.length, pulled }
}

async function post(
  keys: SyncKeys,
  since: number,
  changes: WireChange[],
): Promise<{ changes: WireChange[]; cursor: number; more: boolean }> {
  const res = await fetch(syncUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userKey: keys.userKey, since, changes }),
  })
  if (!res.ok) throw new Error(`sync-${res.status}`)
  return res.json()
}

// --- enabling / device secret -------------------------------------------------

/** Turn sync on, generating a device secret if this device doesn't have one. */
export async function enableSync(): Promise<string> {
  const state = await getSyncState()
  const secret = state.secret && isValidSecret(state.secret) ? state.secret : generateSecret()
  await setSyncState({ enabled: true, secret })
  return secret
}

export async function disableSync(): Promise<void> {
  await setSyncState({ enabled: false })
}

/** Adopt a secret copied from another device. Resets cursors so we pull its
 *  whole history. Rejects anything that isn't a valid Nocturne secret. */
export async function adoptSecret(secret: string): Promise<boolean> {
  if (!isValidSecret(secret)) return false
  await setSyncState({ enabled: true, secret: secret.trim(), cursor: 0, pushedHigh: 0 })
  return true
}

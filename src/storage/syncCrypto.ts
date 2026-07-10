// End-to-end crypto for state sync. The server stores only ciphertext and
// opaque ids; it can never read your reading state or tell which book a record
// is about. Everything derives from one locally-generated "device secret" that
// you copy to your other devices — there is no account and no password on a
// server, and the secret never leaves your devices except when you copy it.
//
//   userKey    = base64url(SHA-256(secret))            — groups your rows; opaque
//   recordId   = base64url(HMAC-SHA256(secret, natKey)) — stable per record; opaque
//   payload    = AES-GCM( HKDF(secret), json )          — the only place data lives

const enc = new TextEncoder()
const dec = new TextDecoder()

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(pad + '==='.slice((pad.length + 3) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** A fresh 32-byte device secret as a base64url string (what the user copies). */
export function generateSecret(): string {
  const raw = new Uint8Array(32)
  crypto.getRandomValues(raw)
  return b64url(raw)
}

/** A secret is only accepted if it looks like our own 32-byte base64url token. */
export function isValidSecret(s: string): boolean {
  try {
    return fromB64url(s.trim()).length === 32
  } catch {
    return false
  }
}

export interface SyncKeys {
  userKey: string
  hmacKey: CryptoKey
  aesKey: CryptoKey
}

export async function deriveKeys(secret: string): Promise<SyncKeys> {
  const raw = fromB64url(secret.trim())
  const userKey = b64url(await crypto.subtle.digest('SHA-256', raw))

  const hmacKey = await crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  // HKDF the secret into a distinct AES key (never reuse the raw secret as a key).
  const ikm = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey'])
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('nocturne-sync-v1'), info: enc.encode('aes') },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  return { userKey, hmacKey, aesKey }
}

/** Opaque, stable id for a logical record — same natural key → same id everywhere. */
export async function recordId(keys: SyncKeys, naturalKey: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', keys.hmacKey, enc.encode(naturalKey))
  return b64url(sig)
}

/** Encrypt a JSON-able value; the IV is prepended to the ciphertext. */
export async function encryptJson(keys: SyncKeys, value: unknown): Promise<string> {
  const iv = new Uint8Array(12)
  crypto.getRandomValues(iv)
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    keys.aesKey,
    enc.encode(JSON.stringify(value)),
  )
  const packed = new Uint8Array(iv.length + ct.byteLength)
  packed.set(iv, 0)
  packed.set(new Uint8Array(ct), iv.length)
  return b64url(packed)
}

/** Decrypt a payload back to its value, or null if it can't be read (wrong key). */
export async function decryptJson<T = unknown>(keys: SyncKeys, payload: string): Promise<T | null> {
  try {
    const packed = fromB64url(payload)
    const iv = packed.slice(0, 12)
    const ct = packed.slice(12)
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, keys.aesKey, ct)
    return JSON.parse(dec.decode(pt)) as T
  } catch {
    return null
  }
}

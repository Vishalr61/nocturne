-- Nocturne state-sync store. Holds ONLY opaque, encrypted reading state — never
-- PDF bytes, never plaintext. A row's `userKey` groups one user's data (it's a
-- hash of their device secret, so it can't be reversed to the secret); `id` is
-- an HMAC of the record's natural key (so the server can't tell which book);
-- `payload` is AES-GCM ciphertext the server can't read. `seq` is a per-user
-- monotonic counter used as the pull cursor (clock-independent).

CREATE TABLE IF NOT EXISTS records (
  userKey   TEXT    NOT NULL,
  id        TEXT    NOT NULL,
  updatedAt INTEGER NOT NULL,          -- client ms; the last-write-wins key
  deleted   INTEGER NOT NULL DEFAULT 0,
  payload   TEXT,                      -- base64 AES-GCM ciphertext (null when deleted)
  seq       INTEGER NOT NULL,          -- per-user monotonic; the pull cursor
  PRIMARY KEY (userKey, id)
);

CREATE INDEX IF NOT EXISTS idx_records_seq ON records (userKey, seq);

CREATE TABLE IF NOT EXISTS counters (
  userKey TEXT PRIMARY KEY,
  seq     INTEGER NOT NULL DEFAULT 0
);

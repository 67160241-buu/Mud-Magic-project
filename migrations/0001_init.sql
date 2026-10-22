-- Mud Magic accounts, login sessions and saved designs (Cloudflare D1 / SQLite).
-- Times are ISO-8601 UTC strings, e.g. 2026-10-22T09:52:50.000Z.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,                     -- random UUID (Firebase uid for migrated users)
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,                                 -- pbkdf2$iter$salt$hash; NULL for Google-only accounts
  google_sub    TEXT UNIQUE,                          -- Google account id, NULL until linked
  display_name  TEXT NOT NULL DEFAULT '',
  photo_url     TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,                        -- SHA-256 (hex) of the mm_session cookie value
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Same fields the Firestore `designs` collection held:
--   ownerId → user_id, name, description (the design config as JSON) → config,
--   createdAt → created_at, updatedAt → updated_at
CREATE TABLE designs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  config     TEXT NOT NULL,                           -- JSON text
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_designs_user_created ON designs(user_id, created_at DESC);

-- Crayon Kid D1 schema (database: crayonkid_db).
-- Applied via Cloudflare D1 API. All writes in the worker are best-effort
-- (try/catch) so a missing table never breaks page generation.

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT,
  kid_name TEXT,
  theme TEXT,           -- preset theme, 'custom', or 'photo'
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Dedupe + bookkeeping for transactional emails.
-- UNIQUE(event_type, event_key) + INSERT ... ON CONFLICT DO NOTHING
-- makes the send claim atomic: retries never double-send.
CREATE TABLE IF NOT EXISTS email_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,   -- 'free_page' | 'free_page_photo' | 'unlock_receipt'
  event_key TEXT NOT NULL,    -- sha256 of (email|kid|creation-descriptor)
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  message_id TEXT,
  error TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(event_type, event_key)
);

-- The buyer's creative context, captured at free-page time and keyed by
-- email. The centralized /api/pay/status only exposes kid_name/theme, so
-- this table is how complexity, custom prompts, and photo descriptions
-- reach the paid PDF builder (/api/pdf). Upserted on every free generation.
CREATE TABLE IF NOT EXISTS purchase_context (
  email TEXT PRIMARY KEY,
  kid_name TEXT NOT NULL,
  theme TEXT NOT NULL DEFAULT 'dinosaurs',  -- preset theme, 'custom', or 'photo'
  complexity TEXT NOT NULL DEFAULT 'simple', -- 'simple' (3-5) | 'detailed' (6+)
  custom_prompt TEXT,        -- raw "describe anything" text (<=200 chars)
  photo_desc_id TEXT,        -- KV key suffix for the photo's TEXT description
                             -- (the original photo is NEVER stored)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

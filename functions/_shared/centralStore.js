// functions/_shared/centralStore.js
//
// Bridge to the CENTRAL signup store: mehyar.jobs' production D1, bound to
// this worker as a second D1 binding `CENTRAL_DB` (see wrangler.toml).
// Conventions mirrored from mehyar-jobs (functions/_shared/landing.js,
// functions/_shared/userAuth.js, functions/api/newsletter/unsubscribe.js):
//   - email_contact rows are keyed UNIQUE(email, brand); brand 'crayonkid' is
//     registered in the central `brand` table.
//   - New captures are INSERT-only (INSERT OR IGNORE) with status 'pending'.
//   - Unsubscribe flips the row to status 'opted_out' (hard bounce /
//     complaint use 'suppressed') for OUR brand's rows only.
//   - Unsubscribe tokens are HMAC-SHA256, payload b64url(JSON{em, br}),
//     domain-separated with `unsub:` — the same shape mehyar.jobs uses,
//     but signed with THIS worker's UNSUB_SECRET (secret_text dashboard var).
//
// Writes from this worker never touch other brands' rows.

export const CENTRAL_BRAND = "crayonkid";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function centralDb(env) {
  return env?.CENTRAL_DB || null;
}

// ── write path: every capture also lands in the central store ──────────
// INSERT-only on UNIQUE(email, brand) — never updates existing rows,
// never touches other brands.
export async function upsertCentralContact(env, email, source = "web") {
  const db = centralDb(env);
  const em = String(email || "").trim().toLowerCase();
  if (!db || !EMAIL_RE.test(em)) return { ok: false, reason: "no_db_or_bad_email" };
  try {
    await db
      .prepare(
        "INSERT OR IGNORE INTO email_contact (email, brand, status, source) " +
        "VALUES (?, ?, 'pending', ?)"
      )
      .bind(em, CENTRAL_BRAND, String(source || "web").slice(0, 32))
      .run();
    return { ok: true };
  } catch (e) {
    console.error("central contact upsert failed", e && e.message);
    return { ok: false, reason: "db_error" };
  }
}

// ── suppression check: before NON-ESSENTIAL sends ──────────────────────
// True when the address opted out (or was suppressed) for our brand.
// Fail-OPEN by design: if the binding isn't attached yet (or the lookup
// errors), the send proceeds — the core product never breaks on this
// best-effort check. The paid receipt email never consults this check
// (transactional fulfillment always sends).
export async function isCentrallySuppressed(env, email) {
  const db = centralDb(env);
  const em = String(email || "").trim().toLowerCase();
  if (!db || !EMAIL_RE.test(em)) return false;
  try {
    const row = await db
      .prepare("SELECT status FROM email_contact WHERE email = ? AND brand = ?")
      .bind(em, CENTRAL_BRAND)
      .first();
    return !!row && (row.status === "opted_out" || row.status === "suppressed");
  } catch (e) {
    console.error("central suppression check failed", e && e.message);
    return false;
  }
}

// ── unsubscribe: flip OUR brand's row to opted_out + log the event ─────
// Mirrors mehyar-jobs' recordEmailEvent 'unsubscribe' action. Scoped to
// (email, brand='crayonkid') — other brands' rows are untouched.
export async function optOutCentralContact(env, email) {
  const db = centralDb(env);
  const em = String(email || "").trim().toLowerCase();
  if (!db || !EMAIL_RE.test(em)) return { ok: false, reason: "no_db_or_bad_email" };
  const now = new Date().toISOString();
  try {
    const row = await db
      .prepare("SELECT id FROM email_contact WHERE email = ? AND brand = ?")
      .bind(em, CENTRAL_BRAND)
      .first();
    if (!row) return { ok: true, changed: false, reason: "no_contact" };
    const r = await db
      .prepare(
        "UPDATE email_contact SET status = 'opted_out' WHERE id = ? AND status != 'opted_out'"
      )
      .bind(row.id)
      .run();
    const changed = Number(r?.meta?.changes || 0) > 0;
    if (changed) {
      // Funnel event log (same shape as mehyar-jobs' email_event writes).
      await db
        .prepare(
          "INSERT INTO email_event (contact_id, brand, kind, meta_json) VALUES (?, ?, 'unsubscribe', ?)"
        )
        .bind(row.id, CENTRAL_BRAND, JSON.stringify({ via: "one_click_token", ts: now }))
        .run()
        .catch(() => {});
      // Engagement bookkeeping — no-op if this contact has no engagement row.
      await db
        .prepare(
          "UPDATE contact_engagement SET suppressed_at = ?, suppress_reason = 'unsubscribed', " +
          "updated_at = ? WHERE contact_id = ?"
        )
        .bind(now, now, row.id)
        .run()
        .catch(() => {});
    }
    return { ok: true, changed };
  } catch (e) {
    console.error("central opt-out failed", e && e.message);
    return { ok: false, reason: "db_error" };
  }
}

// ── tokenized unsubscribe links ────────────────────────────────────────

function b64urlEncode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacSign(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return b64urlEncode(new Uint8Array(sig));
}

// Constant-time string compare (tokens must not leak via timing).
function safeEq(a, b) {
  const x = String(a), y = String(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

function unsubSecret(env) {
  return String(env?.UNSUB_SECRET || "").trim();
}

export async function signUnsubToken(env, email) {
  const secret = unsubSecret(env);
  if (!secret) throw new Error("unsub_not_configured");
  const payload = b64urlEncode(
    new TextEncoder().encode(JSON.stringify({ em: String(email).trim().toLowerCase(), br: CENTRAL_BRAND }))
  );
  const sig = await hmacSign(secret, "unsub:" + payload);
  return payload + "." + sig;
}

export async function verifyUnsubToken(env, token) {
  try {
    const secret = unsubSecret(env);
    if (!secret || !token || typeof token !== "string") return null;
    const [payload, sig] = token.split(".");
    if (!payload || !sig) return null;
    const expect = await hmacSign(secret, "unsub:" + payload);
    if (!safeEq(sig, expect)) return null;
    const data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    const em = String(data?.em || "").trim().toLowerCase();
    if (!EMAIL_RE.test(em)) return null;
    // Our tokens always mint brand='crayonkid'; brand-less legacy tokens
    // (none exist for us yet) are scoped to our brand too.
    const br = String(data?.br || "").trim().toLowerCase() || CENTRAL_BRAND;
    if (br !== CENTRAL_BRAND) return null;
    return { email: em, brand: br };
  } catch {
    return null;
  }
}

export function unsubUrlFor(env, email, siteBase) {
  return signUnsubToken(env, email)
    .then(
      (t) => siteBase + "/api/unsubscribe?token=" + encodeURIComponent(t),
      () => null
    );
}

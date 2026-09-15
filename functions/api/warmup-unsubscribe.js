// functions/api/warmup-unsubscribe.js
// One-click unsubscribe for warmup campaign emails (brand='crayonkid').
//
// Warmup sends are dispatched by an offline script (the morning cron job),
// which cannot mint the HMAC tokens used by /api/unsubscribe (those need
// the worker's UNSUB_SECRET). Instead the script mints opaque random tokens
// into the shared `warmup_unsub_tokens` table, and this endpoint redeems
// them: token -> central email_contact brand='crayonkid' flipped to
// opted_out (the same flip mehyar.jobs performs), token burned.
//
// Supports:
//   GET  /api/warmup-unsubscribe?token=…   — human click, confirmation page
//   POST /api/warmup-unsubscribe           — RFC 8058 one-click
//        (List-Unsubscribe-Post: List-Unsubscribe=One-Click)

import { centralDb, optOutCentralContact, CENTRAL_BRAND } from "../_shared/centralStore.js";

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function page({ heading, body }) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribe — Crayon Kid</title>
<style>body{font-family:Comic Sans MS,Chalkboard SE,Segoe UI,sans-serif;max-width:520px;margin:60px auto;padding:0 20px;color:#1f2937;text-align:center}
h1{font-size:28px}.muted{color:#6b7280}.box{background:#f9fafb;border:2px solid #e5e7eb;border-radius:16px;padding:24px;margin-top:24px}
a.btn{display:inline-block;background:#f97316;color:#fff;padding:12px 26px;border-radius:12px;text-decoration:none;font-weight:bold;margin-top:16px}</style>
</head><body><div class="box"><h1>${heading}</h1>${body}</div></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
}

async function redeem(env, token) {
  const db = centralDb(env);
  token = String(token || "").trim();
  if (!db || !token || token.length < 16) return { ok: false };
  const row = await db
    .prepare("SELECT email, brand FROM warmup_unsub_tokens WHERE token = ?")
    .bind(token)
    .first()
    .catch(() => null);
  if (!row || row.brand !== CENTRAL_BRAND) return { ok: false };
  // Burn the token first so it can't be replayed.
  await db.prepare("DELETE FROM warmup_unsub_tokens WHERE token = ?").bind(token).run().catch(() => {});
  const res = await optOutCentralContact(env, row.email).catch(() => ({ ok: false }));
  return { ok: !!res.ok, email: row.email };
}

export async function onRequestGet({ request, env }) {
  const token = new URL(request.url).searchParams.get("token") || "";
  const res = await redeem(env, token);
  if (!res.ok) {
    return page({
      heading: "🔗 Link expired",
      body: `<p class="muted">That unsubscribe link is invalid or already used. Reply to any Crayon Kid email and we'll take you off the list right away.</p><a class="btn" href="https://crayonkid.mehyar.us/">Back to Crayon Kid</a>`,
    });
  }
  return page({
    heading: "👋 You're unsubscribed",
    body: `<p class="muted"><b>${esc(res.email)}</b> won't get marketing emails from Crayon Kid anymore.</p><a class="btn" href="https://crayonkid.mehyar.us/">Back to Crayon Kid</a>`,
  });
}

export async function onRequestPost({ request, env }) {
  let token = "";
  try {
    const body = await request.text();
    const m = body.match(/token=([^&\s]+)/);
    token = m ? decodeURIComponent(m[1]) : new URL(request.url).searchParams.get("token") || "";
  } catch { /* fall through */ }
  const res = await redeem(env, token);
  return new Response(res.ok ? "unsubscribed" : "invalid", { status: res.ok ? 200 : 400 });
}

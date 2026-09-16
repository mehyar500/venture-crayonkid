// functions/api/unsubscribe.js
// GET /api/unsubscribe?token=… — one-click unsubscribe from Crayon Kid
// emails (following the mehyar.jobs one-click convention). The token is an
// HMAC-signed {email, brand} (see ../_shared/centralStore.js), so no login
// is required. Marks the address status='opted_out' in the CENTRAL store
// (email_contact, brand='crayonkid') — the same flip mehyar-jobs performs
// for unsubscribe events. Other brands' rows are never touched.

import { centralDb, verifyUnsubToken, optOutCentralContact, CENTRAL_BRAND } from "../_shared/centralStore.js";

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function page({ title, heading, body }) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>body{font-family:Comic Sans MS,Chalkboard SE,Segoe UI,sans-serif;max-width:520px;margin:60px auto;padding:0 20px;color:#1f2937;text-align:center}
h1{font-size:28px}.muted{color:#6b7280}.box{background:#f9fafb;border:2px solid #e5e7eb;border-radius:16px;padding:24px;margin-top:24px}
a.btn{display:inline-block;background:#f97316;color:#fff;padding:12px 26px;border-radius:12px;text-decoration:none;font-weight:bold;margin-top:16px}</style>
</head><body><div class="box"><h1>${heading}</h1>${body}</div></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
}

export async function onRequestGet({ request, env }) {
  const token = String(new URL(request.url).searchParams.get("token") || "").trim();

  if (!centralDb(env)) {
    return page({
      title: "Unsubscribe — Crayon Kid",
      heading: "😕 Service hiccup",
      body: `<p class="muted">We couldn't reach the mailing list right now. Reply to any Crayon Kid email and we'll remove you manually.</p>`,
    });
  }

  const verified = await verifyUnsubToken(env, token).catch(() => null);
  if (!verified) {
    return page({
      title: "Link expired — Crayon Kid",
      heading: "🔗 Link expired",
      body: `<p class="muted">That unsubscribe link is invalid or expired. Reply to any Crayon Kid email and we'll take you off the list right away.</p><a class="btn" href="https://crayonkid.mehyar.us/">Back to Crayon Kid</a>`,
    });
  }

  // One-click: no further confirmation needed.
  const res = await optOutCentralContact(env, verified.email).catch(() => ({ ok: false }));
  if (!res.ok) {
    return page({
      title: "Unsubscribe — Crayon Kid",
      heading: "😕 Service hiccup",
      body: `<p class="muted">We couldn't update your preference just now — please try again in a minute, or reply to any Crayon Kid email.</p>`,
    });
  }

  return page({
    title: "Unsubscribed — Crayon Kid",
    heading: "👋 You're unsubscribed",
    body: `<p class="muted"><b>${esc(verified.email)}</b> won't get marketing emails from Crayon Kid anymore.</p>
<p class="muted" style="font-size:13px">Order receipts and download links (if you've purchased) still arrive — that's your proof of purchase, not marketing.</p>
<a class="btn" href="https://crayonkid.mehyar.us/">Back to Crayon Kid</a>`,
  });
}

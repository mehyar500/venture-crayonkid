// functions/api/warmup-bwebhook.js
// Brevo webhook receiver for the Crayon Kid warmup campaign (brand='crayonkid').
// Register in Brevo (POST /v3/webhooks) with events:
//   delivered, opened, click, hardBounce, softBounce, blocked,
//   unsubscribed, complaint
// URL: https://crayonkid.mehyar.us/api/warmup-bwebhook
//
// Updates the SHARED unified tables (CENTRAL_DB = mehyar-jobs D1):
//   warmup_campaign_sends  — per-message status + event timestamps
//   warmup_campaign_daily  — rolled-up counts for the day row
// Unsubscribe/complaint also flips the central email_contact row to
// opted_out/suppressed (brand-scoped), so the address is excluded from
// every future draw.
//
// Abuse guard: events are only applied when the message-id matches a row
// in warmup_campaign_sends. Blind POSTs with unknown message-ids are
// ignored, so an attacker can't flip arbitrary rows.

import { centralDb, optOutCentralContact, CENTRAL_BRAND } from "../_shared/centralStore.js";

const nowIso = () => new Date().toISOString();
const todayDate = () => new Date().toISOString().slice(0, 10);

async function bumpDaily(db, brand, day, field, by = 1) {
  try {
    await db
      .prepare(
        `UPDATE warmup_campaign_daily SET ${field} = COALESCE(${field},0) + ? ` +
          `WHERE brand = ? AND campaign_day = ?`
      )
      .bind(by, brand, day)
      .run();
  } catch (e) {
    console.error("warmup daily bump failed", field, e && e.message);
  }
}

async function setCentralSuppressed(db, email) {
  try {
    const row = await db
      .prepare("SELECT id FROM email_contact WHERE email = ? AND brand = ?")
      .bind(email, CENTRAL_BRAND)
      .first();
    if (!row) return;
    await db
      .prepare("UPDATE email_contact SET status = 'suppressed' WHERE id = ?")
      .bind(row.id)
      .run()
      .catch(() => {});
  } catch (e) {
    console.error("warmup central suppress failed", e && e.message);
  }
}

export async function onRequestPost({ request, env }) {
  const db = centralDb(env);
  if (!db) return new Response("no db", { status: 503 });

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const event = String(body.event || "").toLowerCase();
  const email = String(body.email || "").trim().toLowerCase();
  const msgId = String(body["message-id"] || body.messageId || "").trim();
  if (!event || !msgId) return new Response("ok", { status: 200 }); // nothing to match

  // Only apply to sends we actually made.
  const send = await db
    .prepare(
      "SELECT id, brand, campaign_day, recipient_email FROM warmup_campaign_sends WHERE message_id = ?"
    )
    .bind(msgId)
    .first()
    .catch(() => null);
  if (!send) return new Response("ok", { status: 200 }); // unknown message — ignore

  const brand = send.brand;
  const day = send.campaign_day;
  const now = nowIso();

  try {
    if (event === "delivered") {
      await db.prepare("UPDATE warmup_campaign_sends SET status='delivered' WHERE id=?").bind(send.id).run();
      await bumpDaily(db, brand, day, "delivered_count");
    } else if (event === "opened") {
      await db.prepare("UPDATE warmup_campaign_sends SET status='opened', opened_at=COALESCE(opened_at,?) WHERE id=?").bind(now, send.id).run();
      await bumpDaily(db, brand, day, "open_count");
    } else if (event === "click") {
      await db.prepare("UPDATE warmup_campaign_sends SET status='clicked', clicked_at=COALESCE(clicked_at,?) WHERE id=?").bind(now, send.id).run();
      await bumpDaily(db, brand, day, "click_count");
    } else if (event === "hardbounce" || event === "softbounce" || event === "blocked") {
      await db.prepare("UPDATE warmup_campaign_sends SET status='bounced', bounced_at=COALESCE(bounced_at,?) WHERE id=?").bind(now, send.id).run();
      await bumpDaily(db, brand, day, "bounce_count");
      if (event === "hardbounce" || event === "blocked") await setCentralSuppressed(db, email || send.recipient_email);
    } else if (event === "unsubscribed") {
      await db.prepare("UPDATE warmup_campaign_sends SET status='unsubscribed' WHERE id=?").bind(send.id).run();
      await bumpDaily(db, brand, day, "unsub_count");
      await optOutCentralContact(env, email || send.recipient_email).catch(() => {});
    } else if (event === "complaint" || event === "spam") {
      await db.prepare("UPDATE warmup_campaign_sends SET status='complained' WHERE id=?").bind(send.id).run();
      await bumpDaily(db, brand, day, "complaint_count");
      await setCentralSuppressed(db, email || send.recipient_email);
    }
    // other events (sent, deferred, proxy_open, error) — no state change needed
  } catch (e) {
    console.error("warmup webhook apply failed", e && e.message);
  }
  return new Response("ok", { status: 200 });
}

// Brevo verifies webhooks with a GET on registration in some flows — answer 200.
export async function onRequestGet() {
  return new Response("ok", { status: 200 });
}

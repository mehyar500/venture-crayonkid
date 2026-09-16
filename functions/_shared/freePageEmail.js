// functions/_shared/freePageEmail.js
// Shared transactional "your free coloring page" email (reactivation loop).
// Used by /api/free (theme + custom-prompt modes) and /api/photo.
// Deduped in D1 via email_sends UNIQUE(event_type, event_key) — the atomic
// INSERT ... ON CONFLICT DO NOTHING claim means retries or repeat
// generations for the same (email, kid, creation) send exactly once.
//
// Fire-and-forget: call inside waitUntil() so the HTTP response never waits
// on the email. Transactional only — one email per creation, no marketing.

import { sendCloudflareEmail } from "./cloudflareEmail.js";
import { claimSend, markSend } from "./emailSends.js";
import { sha256hex } from "./ai.js";
import { isCentrallySuppressed, unsubUrlFor } from "./centralStore.js";

const SITE = "https://crayonkid.mehyar.us";
const FROM_EMAIL = "team@mehyar.us";
const FROM_NAME = "Crayon Kid";

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// opts: { env, to, kidName, imgUrl, deepLink, eventType, eventKey, waitUntil,
//         headline?, subCopy? }
export function sendFreePageEmail(opts) {
  const { env, to, kidName, imgUrl, deepLink, eventType, eventKey, waitUntil } = opts;
  if (typeof waitUntil !== "function") return;
  waitUntil(
    (async () => {
      try {
        const key = await sha256hex(eventType + ":" + eventKey);
        const claimed = await claimSend(env.DB, eventType, key, to);
        if (!claimed) return; // already sent for this email+kid+creation
        // SUPPRESSION: if the address opted out in the CENTRAL store
        // (email_contact, brand='crayonkid'), skip the send entirely.
        // The email_sends row stays 'pending' (unsent) — the claim above
        // keeps retries from re-entering. This check is NON-ESSENTIAL-mail
        // only; the paid unlock receipt in api/unlock.js still sends.
        if (await isCentrallySuppressed(env, to)) {
          console.error("free-page email suppressed: central opt-out", to);
          return;
        }
        // Per-recipient tokenized unsubscribe link for the footer. If the
        // secret isn't configured yet, the footer renders without the link.
        const unsubUrl = await unsubUrlFor(env, to, SITE);
        const subject = "\u{1F58D}\uFE0F " + kidName + "'s coloring page is ready!";
        const text =
          "Hi!\n\n" +
          "Here's the free coloring page we drew for " + kidName + ":\n" + imgUrl + "\n\n" +
          "Their name looks GREAT on it — and it looks even better on all 12 pages.\n\n" +
          "Come back and unlock the full personalized book ($6, one-time):\n" + deepLink + "\n\n" +
          "Your link above restores " + kidName + "'s setup, so one tap brings you right back.\n\n" +
          "Happy coloring!\n-- Crayon Kid" +
          (unsubUrl ? "\n\nUnsubscribe: " + unsubUrl : "");
        const html =
          '<div style="font-family:Comic Sans MS,Chalkboard SE,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#1f2937;">' +
          '<h1 style="text-align:center;">\u{1F58D}\uFE0F ' + esc(kidName) + "'s coloring page is ready!</h1>" +
          '<p style="text-align:center;color:#4b5563;">Here\'s the free page we drew — their name looks <b>great</b> on it.</p>' +
          '<p style="text-align:center;"><a href="' + deepLink + '"><img src="' + imgUrl + '" alt="' + esc(kidName) + '\'s coloring page" style="max-width:100%;border:3px solid #1f2937;border-radius:12px;"></a></p>' +
          '<p style="text-align:center;color:#4b5563;">Imagine their name on <b>twelve</b> pages like this…</p>' +
          '<p style="text-align:center;"><a href="' + deepLink + '" style="display:inline-block;background:#f97316;color:#fff;padding:14px 30px;border-radius:12px;text-decoration:none;font-weight:bold;font-size:18px;">\u{1F449} See ' + esc(kidName) + '\'s page &amp; unlock all 12 — $6</a></p>' +
          '<p style="text-align:center;color:#6b7280;font-size:13px;">Your link restores ' + esc(kidName) + '\'s setup — one tap brings you right back.<br>Print the free page any time: <a href="' + imgUrl + '">' + imgUrl + "</a></p>" +
          '<p style="text-align:center;color:#9ca3af;font-size:12px;margin-top:24px;">You\'re getting this because you created a free coloring page at Crayon Kid. No spam, ever — just your page.' +
          (unsubUrl ? '<br><a href="' + unsubUrl + '" style="color:#9ca3af;">Unsubscribe</a>' : "") + '</p>' +
          "</div>";
        const result = await sendCloudflareEmail(env, {
          from: FROM_EMAIL,
          fromName: FROM_NAME,
          to,
          replyTo: "info@mehyar.us",
          subject,
          text,
          html,
        });
        await markSend(env.DB, eventType, key, result.ok, result.ok ? result.messageId : result.error);
        if (!result.ok) console.error("free-page email failed", result.error);
      } catch (e) {
        console.error("free-page email threw", e && e.message);
      }
    })()
  );
}

export { SITE };

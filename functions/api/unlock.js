// functions/api/unlock.js
// GET /api/unlock?token=... — verify a Stripe access token and return the
// personalization for the paid book (kid name + theme). The unlock page calls
// this before fetching /api/pdf. Mirrors the RoastMe /api/unlock pattern.
//
// On the first verified paid unlock for a token, also sends the unlock
// receipt email (permanent download link) — deduped in D1 so repeat visits
// never re-send. All email logic lives here in the venture worker; the
// centralized mehyar-web webhook is untouched.

import { sendCloudflareEmail } from "../_shared/cloudflareEmail.js";
import { claimSend, markSend } from "../_shared/emailSends.js";

const SITE = "https://crayonkid.mehyar.us";
const FROM_EMAIL = "team@mehyar.us";
const FROM_NAME = "Crayon Kid";

const PRODUCT_ID = "crayonkid-coloring-book";
const STATUS_URL = "https://mehyar.us/api/pay/status?token=";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const THEMES = ["dinosaurs", "space", "ocean", "jungle animals", "unicorns", "vehicles", "farm animals", "princess castle"];

function cleanName(v) {
  return String(v || "")
    .replace(/[^\p{L} '\-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
}

export async function onRequestGet({ request, env, waitUntil }) {
  try {
    const token = (new URL(request.url).searchParams.get("token") || "").trim();
    if (!token || token.length < 16) {
      return Response.json({ ok: false, error: "invalid_token" }, { status: 403 });
    }
    const st = await fetch(STATUS_URL + encodeURIComponent(token), {
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(15000),
    });
    const sj = await st.json().catch(() => ({}));
    if (!st.ok || !sj.ok) {
      return Response.json({ ok: false, error: "verification_failed" }, { status: 502 });
    }
    if (sj.product_id !== PRODUCT_ID) {
      return Response.json({ ok: false, error: "wrong_product" }, { status: 403 });
    }
    if (!sj.paid) {
      return Response.json({ ok: false, paid: false, error: "not_paid" }, { status: 402 });
    }
    const theme = THEMES.includes(sj.theme) ? sj.theme : "dinosaurs";
    const kidName = cleanName(sj.kid_name) || "Superstar";

    // First verified paid unlock for this token → send the receipt email
    // (permanent download link) in the background. Deduped in D1.
    if (typeof waitUntil === "function" && env && env.DB && sj.email) {
      waitUntil(
        (async () => {
          try {
            const claimed = await claimSend(env.DB, "unlock_receipt", token, sj.email);
            if (!claimed) return; // receipt already sent for this purchase
            const dlUrl = SITE + "/api/pdf?token=" + encodeURIComponent(token);
            const unlockUrl = SITE + "/unlock?paid=1&access_token=" + encodeURIComponent(token);
            const subject = "Your Crayon Kid book is ready \u{1F389}";
            const text =
              "Thanks for your purchase!\n\n" +
              kidName + "'s personalized coloring book (12 pages) is ready:\n" + dlUrl + "\n\n" +
              "This is your permanent download link — save it somewhere safe. " +
              "You can re-download and print as many times as you like, forever.\n\n" +
              "The PDF is high-resolution print quality — crisp on US Letter or A4 paper.\n\n" +
              "Prefer the animated unlock page? It's here:\n" + unlockUrl + "\n\n" +
              "Print tip: US Letter paper works great; cardstock makes the pages extra sturdy.\n\n" +
              "Happy coloring!\n-- Crayon Kid";
            const esc = (s) =>
              String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
            const html =
              '<div style="font-family:Comic Sans MS,Chalkboard SE,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#1f2937;">' +
              '<h1 style="text-align:center;">\u{1F389} ' + esc(kidName) + "'s book is ready!</h1>" +
              '<p style="text-align:center;color:#4b5563;">Thanks for your purchase — all <b>12 personalized pages</b>, ready to print.</p>' +
              '<p style="text-align:center;color:#6b7280;font-size:13px;">High-resolution print PDF — crisp on US Letter or A4 paper.</p>' +
              '<p style="text-align:center;"><a href="' + dlUrl + '" style="display:inline-block;background:#22c55e;color:#fff;padding:14px 30px;border-radius:12px;text-decoration:none;font-weight:bold;font-size:18px;">\u2B07\uFE0F Download the coloring book (PDF)</a></p>' +
              '<p style="text-align:center;color:#6b7280;font-size:13px;">This is your <b>permanent</b> download link — save it somewhere safe.<br>Re-download and print as many times as you like, forever.<br><br>Prefer the animated unlock page? <a href="' + unlockUrl + '">Open it here</a>.<br>\u{1F5A8}\uFE0F Print tip: US Letter paper works great; cardstock makes pages extra sturdy.</p>' +
              '<p style="text-align:center;color:#9ca3af;font-size:12px;margin-top:24px;">Receipt for your $6 one-time purchase at Crayon Kid. Questions? Just reply to this email.</p>' +
              "</div>";
            const result = await sendCloudflareEmail(env, {
              from: FROM_EMAIL,
              fromName: FROM_NAME,
              to: sj.email,
              replyTo: "info@mehyar.us",
              subject,
              text,
              html,
            });
            await markSend(env.DB, "unlock_receipt", token, result.ok, result.ok ? result.messageId : result.error);
            if (!result.ok) console.error("unlock receipt email failed", result.error);
          } catch (e) {
            console.error("unlock receipt email threw", e && e.message);
          }
        })()
      );
    }

    return Response.json({
      ok: true,
      paid: true,
      kid_name: kidName,
      theme,
    });
  } catch (e) {
    console.error("api/unlock error", e && e.message);
    return Response.json({ ok: false, error: "verification_failed" }, { status: 502 });
  }
}

// functions/api/unlock.js
// GET /api/unlock?token=... — verify a Stripe access token and return the
// personalization for the paid book (kid name + theme). The unlock page calls
// this before fetching /api/pdf. Mirrors the RoastMe /api/unlock pattern.

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

export async function onRequestGet({ request }) {
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
    return Response.json({
      ok: true,
      paid: true,
      kid_name: cleanName(sj.kid_name) || "Superstar",
      theme,
    });
  } catch (e) {
    console.error("api/unlock error", e && e.message);
    return Response.json({ ok: false, error: "verification_failed" }, { status: 502 });
  }
}

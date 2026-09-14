// functions/api/photo.js
// POST /api/photo — turn an uploaded photo into a coloring page (FREE).
// Multipart form-data: photo (image file, client-downscaled to <=1024px JPEG),
// kid_name, email, complexity ("simple"|"detailed").
//
// Pipeline: vision-describe the photo (ONE image per vision call — two
// image_urls in one call errors with 3030) -> flux-1-schnell redraws the
// described subject as black-and-white line art. There is no true
// image-to-image model on Workers AI right now (only an SD1.5 inpainting
// model needing a mask), so this describe-then-draw pipeline is the honest
// approach: it captures the photo's SUBJECT faithfully, not a pixel trace.
// UI copy says "we redraw your photo", never "exact trace".
//
// PRIVACY: the uploaded photo is processed in-memory and NEVER persisted —
// no KV, no D1, no logs. What we keep: (1) the GENERATED line art in KV for
// 7 days so the free-page email can embed it, (2) a one-sentence TEXT
// description in KV for 30 days so the paid book can theme its 12 pages on
// it. The original photo is discarded with the request.
//
// Tighter rate limit than text prompts (photo gens cost more): 3/IP/hour.

import { cleanName, sha256hex, sniffMime, toDataUrl, aiImageBytes,
         lineArtPrompt, describePhoto } from "../_shared/ai.js";
import { sendFreePageEmail, SITE } from "../_shared/freePageEmail.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BYTES = 2.5 * 1024 * 1024; // client downscales to ~1024px JPEG first

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function onRequestPost({ request, env, waitUntil }) {
  try {
    if (!env.AI || !env.DB || !env.CACHE) {
      return json({ ok: false, error: "service_unavailable" }, 503);
    }
    const form = await request.formData().catch(() => null);
    if (!form) return json({ ok: false, error: "bad_upload" }, 400);
    const file = form.get("photo");
    const kidName = cleanName(form.get("kid_name"));
    const email = String(form.get("email") || "").trim().toLowerCase();
    const complexity = form.get("complexity") === "detailed" ? "detailed" : "simple";

    if (kidName.length < 2) return json({ ok: false, error: "bad_name" }, 400);
    if (!EMAIL_RE.test(email)) return json({ ok: false, error: "bad_email" }, 400);
    if (!file || typeof file.arrayBuffer !== "function") {
      return json({ ok: false, error: "bad_upload" }, 400);
    }
    const mime = String(file.type || "");
    if (!mime.startsWith("image/")) return json({ ok: false, error: "bad_upload" }, 400);
    const buf = await file.arrayBuffer();
    if (!buf || buf.byteLength < 5000) return json({ ok: false, error: "bad_upload" }, 400);
    if (buf.byteLength > MAX_BYTES) return json({ ok: false, error: "too_large" }, 413);
    const photoBytes = new Uint8Array(buf);

    // Tighter rate limit: 3 photo pages per IP per hour.
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const rlKey = "rlphoto:" + ip;
    const used = Number((await env.CACHE.get(rlKey)) || 0);
    if (used >= 3) return json({ ok: false, error: "rate_limited" }, 429);
    await env.CACHE.put(rlKey, String(used + 1), { expirationTtl: 3600 });

    // 1. Describe the photo (vision), 2. draw it as line art (flux).
    const description = await describePhoto(env, photoBytes);
    if (!description) return json({ ok: false, error: "generation_failed" }, 502);
    const bytes = await aiImageBytes(env, lineArtPrompt(description, complexity));
    if (!bytes || bytes.byteLength < 10000) {
      return json({ ok: false, error: "generation_failed" }, 502);
    }
    // The original photo is now out of scope — `photoBytes` is never stored.

    // Keep the GENERATED line art briefly so the email can embed it, and the
    // TEXT description so the paid book can theme its pages on it.
    const imageId = await sha256hex("pageimg:photo:" + email + ":" + Date.now() + ":" + description);
    await env.CACHE.put("pageimg:" + imageId, bytes, { expirationTtl: 60 * 60 * 24 * 7 }).catch(() => {});
    const descId = await sha256hex("photodesc:" + imageId);
    await env.CACHE.put("photodesc:" + descId, description, { expirationTtl: 60 * 60 * 24 * 30 }).catch(() => {});

    // Lead + purchase context (best effort).
    try {
      await env.DB.prepare(
        "INSERT INTO leads (email, kid_name, theme) VALUES (?, ?, 'photo')"
      ).bind(email, kidName).run();
    } catch (e) { console.error("photo lead insert failed", e && e.message); }
    try {
      await env.DB.prepare(
        "INSERT INTO purchase_context (email, kid_name, theme, complexity, custom_prompt, photo_desc_id) " +
        "VALUES (?, ?, 'photo', ?, NULL, ?) " +
        "ON CONFLICT(email) DO UPDATE SET kid_name=excluded.kid_name, theme='photo', " +
        "complexity=excluded.complexity, custom_prompt=NULL, photo_desc_id=excluded.photo_desc_id, " +
        "created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')"
      ).bind(email, kidName, complexity, descId).run();
    } catch (e) { console.error("photo purchase_context upsert failed", e && e.message); }

    const imgUrl = SITE + "/api/page-image?img=" + imageId;
    const deepLink = SITE + "/?mode=photo";
    const photoHash = await sha256hex("photo:" + description + ":" + complexity);
    sendFreePageEmail({
      env,
      to: email,
      kidName,
      imgUrl,
      deepLink,
      eventType: "free_page_photo",
      eventKey: email + "|" + kidName + "|" + photoHash,
      waitUntil,
    });

    return json({
      ok: true,
      image: toDataUrl(bytes, sniffMime(bytes)),
      kid_name: kidName,
      mode: "photo",
      complexity,
      description,
    });
  } catch (e) {
    console.error("api/photo error", e && e.message);
    return json({ ok: false, error: "generation_failed" }, 500);
  }
}

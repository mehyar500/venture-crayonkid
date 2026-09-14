// functions/api/free.js
// POST /api/free — generate ONE free personalized coloring page.
// Body: { kid_name, email, theme?, prompt?, complexity? }
//   - theme mode:  { theme: "space" }            (preset picker)
//   - custom mode: { prompt: "a dragon having a tea party" }  ("describe anything")
//   - complexity: "simple" (ages 3-5, default) | "detailed" (ages 6+)
// Stores the lead in D1, rate-limits per IP, returns the page as a data URL.
// The kid's name is overlaid client-side (image models mangle text).
// Also fires the free-page transactional email (reactivation) in the
// background — deduped in D1 so retries never double-send.
// Also upserts purchase_context so the paid PDF can honor the same
// complexity / custom prompt when this email later checks out.

import { THEMES, cleanName, sha256hex, sniffMime, toDataUrl, aiImageBytes,
         lineArtPrompt, sanitizePrompt, planSceneFromPrompt } from "../_shared/ai.js";
import { sendFreePageEmail, SITE } from "../_shared/freePageEmail.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function normComplexity(v) {
  return v === "detailed" ? "detailed" : "simple";
}

async function upsertPurchaseContext(env, row) {
  // Best effort — never block the free page on bookkeeping.
  try {
    await env.DB.prepare(
      "INSERT INTO purchase_context (email, kid_name, theme, complexity, custom_prompt, photo_desc_id) " +
      "VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(email) DO UPDATE SET kid_name=excluded.kid_name, theme=excluded.theme, " +
      "complexity=excluded.complexity, custom_prompt=excluded.custom_prompt, " +
      "photo_desc_id=excluded.photo_desc_id, " +
      "created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')"
    ).bind(row.email, row.kid_name, row.theme, row.complexity, row.custom_prompt, row.photo_desc_id).run();
  } catch (e) {
    console.error("purchase_context upsert failed", e && e.message);
  }
}

export async function onRequestPost({ request, env, waitUntil }) {
  try {
    const body = await request.json().catch(() => ({}));
    const kidName = cleanName(body.kid_name);
    const email = String(body.email || "").trim().toLowerCase();
    const complexity = normComplexity(body.complexity);
    const rawPrompt = String(body.prompt || "").trim();
    const theme = String(body.theme || "").toLowerCase().trim();

    if (kidName.length < 2) return json({ ok: false, error: "bad_name" }, 400);
    if (!EMAIL_RE.test(email)) return json({ ok: false, error: "bad_email" }, 400);
    if (!env.AI || !env.DB || !env.CACHE) {
      return json({ ok: false, error: "service_unavailable" }, 503);
    }

    // Mode: custom prompt wins over theme when present and valid.
    let mode = "theme", scene = "", descriptor = "", leadTheme = "";
    if (rawPrompt) {
      const clean = sanitizePrompt(rawPrompt);
      if (!clean) return json({ ok: false, error: "bad_prompt" }, 400);
      mode = "custom";
      scene = await planSceneFromPrompt(env, clean);
      if (!scene) return json({ ok: false, error: "generation_failed" }, 502);
      descriptor = "prompt:" + clean;
      leadTheme = "custom";
    } else {
      if (!THEMES[theme]) return json({ ok: false, error: "bad_theme" }, 400);
      scene = THEMES[theme];
      descriptor = "theme:" + theme;
      leadTheme = theme;
    }

    // Soft rate limit: 10 free pages per IP per hour (text modes share it).
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const rlKey = "rl:" + ip;
    const used = Number((await env.CACHE.get(rlKey)) || 0);
    if (used >= 10) return json({ ok: false, error: "rate_limited" }, 429);
    await env.CACHE.put(rlKey, String(used + 1), { expirationTtl: 3600 });

    // Store the lead (best effort).
    try {
      await env.DB.prepare(
        "INSERT INTO leads (email, kid_name, theme) VALUES (?, ?, ?)"
      ).bind(email, kidName, leadTheme).run();
    } catch (e) {
      console.error("lead insert failed", e && e.message);
    }

    // Shared image cache. Default path (simple theme scenes) keeps the legacy
    // key format so existing cached drawings are reused, not regenerated.
    const isLegacy = mode === "theme" && complexity === "simple";
    const cacheInput = isLegacy ? (theme + "::" + scene) : ("v2:" + complexity + ":" + descriptor + "::" + scene);
    const cacheKey = "img:" + (await sha256hex(cacheInput));
    let bytes = await env.CACHE.get(cacheKey, "arrayBuffer").catch(() => null);
    if (!bytes || bytes.byteLength < 10000) {
      bytes = await aiImageBytes(env, lineArtPrompt(scene, complexity));
      if (bytes && bytes.byteLength > 10000) {
        await env.CACHE.put(cacheKey, bytes, { expirationTtl: 60 * 60 * 24 * 30 }).catch(() => {});
      }
    }
    if (!bytes || bytes.byteLength < 10000) {
      return json({ ok: false, error: "generation_failed" }, 502);
    }
    bytes = new Uint8Array(bytes);

    // Remember this creation for the paid book (complexity/custom prompt).
    await upsertPurchaseContext(env, {
      email, kid_name: kidName, theme: mode === "theme" ? theme : "custom",
      complexity, custom_prompt: mode === "custom" ? rawPrompt.slice(0, 200) : null,
      photo_desc_id: null,
    });

    // The free-page email embeds the image via /api/page-image. Theme images
    // use the existing ?theme= path; custom-prompt images are stored under a
    // content id (?img=...) since they have no theme key.
    let imgUrl, deepLink, imageId = null;
    if (mode === "theme") {
      imgUrl = SITE + "/api/page-image?theme=" + encodeURIComponent(theme);
      deepLink = SITE + "/?kid=" + encodeURIComponent(kidName) +
        "&theme=" + encodeURIComponent(theme) + "&cx=" + complexity;
    } else {
      imageId = await sha256hex("pageimg:" + cacheKey);
      await env.CACHE.put("pageimg:" + imageId, bytes, { expirationTtl: 60 * 60 * 24 * 30 }).catch(() => {});
      imgUrl = SITE + "/api/page-image?img=" + imageId;
      deepLink = SITE + "/?kid=" + encodeURIComponent(kidName) +
        "&prompt=" + encodeURIComponent(rawPrompt.slice(0, 200)) + "&cx=" + complexity;
    }

    // Fire the free-page email in the background — never delay the response.
    // Deduped on (email, kid, creation): retries or repeat generations send once.
    sendFreePageEmail({
      env,
      to: email,
      kidName,
      imgUrl,
      deepLink,
      eventType: "free_page",
      eventKey: email + "|" + kidName + "|" + descriptor + "|" + complexity,
      waitUntil,
    });

    return json({
      ok: true,
      image: toDataUrl(bytes, sniffMime(bytes)),
      kid_name: kidName,
      theme: mode === "theme" ? theme : "custom",
      mode,
      complexity,
      image_id: imageId,
    });
  } catch (e) {
    console.error("api/free error", e && e.message);
    return json({ ok: false, error: "generation_failed" }, 500);
  }
}

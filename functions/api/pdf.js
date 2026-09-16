// functions/api/pdf.js
// GET /api/pdf?token=... — build + serve the personalized 12-page PDF.
// 1. Verifies the token against mehyar.us/api/pay/status (must be paid).
// 2. Looks up purchase_context (by buyer email) for the complexity level,
//    custom prompt, or photo description captured at free-page time. Falls
//    back to the plain theme when absent.
// 3. Generates 12 themed coloring pages via Workers AI (parallel, cached).
// 4. Assembles a US-Letter PDF with the kid's name drawn on every page.
// 5. Caches the PDF in KV for 30 days so re-downloads are instant.
//
// PRINT-QUALITY HONESTY (read before changing claims): the image model
// (flux-1-schnell) emits fixed-resolution RASTER output (~1024px, JPEG).
// There is no vector/upscaling knob in its schema. We embed those bytes at
// FULL native resolution — crisp at US Letter/A4 print size — but "infinite
// scaling" is never promised anywhere: not in code, not in email copy, not
// in the FAQ. Keep it that way.

import { PDFDocument, StandardFonts, rgb } from "../../lib/pdf-lib.bundle.js";
import { LLM_MODEL, cleanName, sha256hex, aiImageBytes, lineArtPrompt,
         scrubScene } from "../_shared/ai.js";

const PRODUCT_ID = "crayonkid-coloring-book";
const STATUS_URL = "https://mehyar.us/api/pay/status?token=";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const SIGNATURE_SCENE = {
  "dinosaurs": "a cute smiling T-Rex with baby dinosaurs",
  "space": "a cute smiling astronaut waving next to a rocket ship",
  "ocean": "a cute smiling octopus with happy fish friends",
  "jungle animals": "a cute smiling lion with a playful monkey",
  "unicorns": "a cute smiling unicorn under a rainbow",
  "vehicles": "a cute smiling race car next to a friendly truck",
  "farm animals": "a cute smiling cow with a happy piglet",
  "princess castle": "a cute smiling princess in front of a castle",
};

function fallbackScenes(theme) {
  const t = theme || "animals";
  return [
    "a cute smiling baby " + t + " playing with a colorful ball",
    "a happy " + t + " having a picnic with friends",
    "a cute " + t + " at a birthday party with balloons",
    "a smiling " + t + " riding in a fun parade",
    "a sleepy baby " + t + " under twinkling stars",
    "a playful " + t + " splashing in a puddle",
    "a cute " + t + " surrounded by flowers and butterflies",
    "a happy " + t + " playing a musical instrument",
    "a cute " + t + " on a treasure hunt adventure",
    "a smiling " + t + " building a sandcastle",
    "a cute " + t + " flying a kite in the park",
    "a happy " + t + " saying goodnight to the moon",
  ];
}

// The buyer's creative context, captured at free-page time in the worker's
// own D1 (purchase_context, keyed by email). The centralized /api/pay/status
// only exposes kid_name/theme, so this table is how complexity, custom
// prompts, and photo descriptions reach the paid book. Absent row = defaults.
async function loadPurchaseContext(env, email) {
  const ctx = { complexity: "simple", custom_prompt: null, photo_desc: null, theme: "dinosaurs" };
  if (!env.DB || !email) return ctx;
  try {
    const row = await env.DB.prepare(
      "SELECT theme, complexity, custom_prompt, photo_desc_id FROM purchase_context WHERE email = ?"
    ).bind(email).first();
    if (row) {
      ctx.complexity = row.complexity === "detailed" ? "detailed" : "simple";
      ctx.custom_prompt = typeof row.custom_prompt === "string" && row.custom_prompt ? row.custom_prompt.slice(0, 200) : null;
      ctx.theme = typeof row.theme === "string" ? row.theme : "dinosaurs";
      const descId = row.photo_desc_id;
      if (descId && env.CACHE) {
        const desc = await env.CACHE.get("photodesc:" + descId).catch(() => null);
        if (desc) ctx.photo_desc = String(desc).slice(0, 200);
      }
    }
  } catch (e) {
    console.error("purchase_context lookup failed", e && e.message);
  }
  return ctx;
}

async function sceneImage(env, theme, scene, complexity, descriptor) {
  // Legacy key for the default path (simple preset-theme scenes) so existing
  // cached drawings are reused instead of regenerated.
  const isLegacy = complexity === "simple" && descriptor === "theme:" + theme;
  const input = isLegacy ? (theme + "::" + scene) : ("v2:" + complexity + ":" + descriptor + "::" + scene);
  const cacheKey = "img:" + (await sha256hex(input));
  const cached = await env.CACHE.get(cacheKey, "arrayBuffer").catch(() => null);
  if (cached && cached.byteLength > 10000) return new Uint8Array(cached);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const bytes = await aiImageBytes(env, lineArtPrompt(scene, complexity));
      if (bytes && bytes.byteLength > 10000) {
        await env.CACHE.put(cacheKey, bytes, { expirationTtl: 60 * 60 * 24 * 30 }).catch(() => {});
        return bytes;
      }
    } catch (e) {
      console.error("scene gen failed (attempt " + attempt + ")", scene.slice(0, 40), e && e.message);
    }
  }
  return null;
}

async function planScenes(env, theme, ctx) {
  // Describe WHAT the 12 pages are about: custom prompt > photo subject > theme.
  let about = '"' + theme + '"';
  if (ctx.custom_prompt) about = 'the coloring-book idea "' + ctx.custom_prompt + '"';
  else if (ctx.photo_desc) about = 'photos of ' + ctx.photo_desc;
  const detailHint = ctx.complexity === "detailed"
    ? " Make them richly detailed with intricate patterns for ages 6+."
    : " Keep them simple with big bold shapes for ages 3-5.";
  try {
    const out = await env.AI.run(LLM_MODEL, {
      messages: [
        { role: "system", content: "You output only a JSON array of strings. No other text." },
        {
          role: "user",
          content:
            'List 12 short, distinct, kid-friendly coloring page scene ideas about ' + about +
            " for ages 3-8." + detailHint +
            ' Each under 12 words, cute and simple. ' +
            'Return ONLY a JSON array of 12 strings, e.g. ["a smiling ...", ...].',
        },
      ],
    });
    const text = (out && out.response ? String(out.response) : "").trim();
    const m = text.match(/\[[\s\S]*\]/);
    if (m) {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr)) {
        const scenes = arr
          .filter((s) => typeof s === "string" && s.length > 3)
          .map((s) => scrubScene(s))
          .slice(0, 12);
        if (scenes.length >= 10) return scenes;
      }
    }
  } catch (e) {
    console.error("scene planning failed", e && e.message);
  }
  return fallbackScenes(theme).map(scrubScene);
}

// flux-1-schnell returns JPEG bytes; sniff the magic and use the right embedder.
async function embedImage(doc, bytes) {
  if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return doc.embedJpg(bytes);
  }
  return doc.embedPng(bytes);
}

async function buildPdf(kidName, images) {
  const doc = await PDFDocument.create();
  doc.setTitle("Crayon Kid — " + kidName + "'s Coloring Book");
  doc.setAuthor("Crayon Kid");
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const small = await doc.embedFont(StandardFonts.Helvetica);
  const PW = 612, PH = 792;

  for (let i = 0; i < images.length; i++) {
    const page = doc.addPage([PW, PH]);
    // Kid's name, big and centered at the top.
    let size = 46;
    let w = font.widthOfTextAtSize(kidName, size);
    while (w > 540 && size > 20) { size -= 2; w = font.widthOfTextAtSize(kidName, size); }
    page.drawText(kidName, { x: (PW - w) / 2, y: PH - 78, size, font, color: rgb(0, 0, 0) });
    // Thin crayon-underline.
    page.drawRectangle({ x: (PW - w) / 2, y: PH - 88, width: w, height: 3, color: rgb(0.96, 0.62, 0.04) });

    // Coloring image, embedded at FULL native resolution (raster, ~1024px)
    // and scaled to fit the page. Crisp at US Letter/A4 print — see the
    // honesty note at the top of this file.
    const img = await embedImage(doc, images[i]);
    const dims = img.scale(1);
    const s = Math.min(540 / dims.width, 560 / dims.height);
    const iw = dims.width * s, ih = dims.height * s;
    page.drawImage(img, { x: (PW - iw) / 2, y: 64 + (600 - ih) / 2, width: iw, height: ih });

    // Footer.
    const foot = "Page " + (i + 1) + " of " + images.length + "  ·  Crayon Kid";
    const fw = small.widthOfTextAtSize(foot, 10);
    page.drawText(foot, { x: (PW - fw) / 2, y: 30, size: 10, font: small, color: rgb(0.45, 0.45, 0.45) });
  }
  return doc.save();
}

function pdfResponse(bytes, kidName) {
  const slug = kidName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "coloring-book";
  return new Response(bytes, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": 'attachment; filename="crayon-kid-' + slug + '.pdf"',
      "cache-control": "no-store",
    },
  });
}

export async function onRequestGet({ request, env }) {
  try {
    const token = (new URL(request.url).searchParams.get("token") || "").trim();
    if (!token || token.length < 16) {
      return Response.json({ ok: false, error: "invalid_token" }, { status: 403 });
    }
    if (!env.AI || !env.CACHE) {
      return Response.json({ ok: false, error: "service_unavailable" }, { status: 503 });
    }

    // 1. Verify payment with the centralized Stripe system (server-side).
    const st = await fetch(STATUS_URL + encodeURIComponent(token), {
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(15000),
    });
    const sj = await st.json().catch(() => ({}));
    if (!st.ok) {
      // Central ledger answered "unknown token" -> clean 403. Only use 502
      // when the central call itself failed: the Pages edge swallows our
      // JSON body on a function-returned 502, so unknown tokens must not
      // take that path.
      if (st.status === 404) {
        return Response.json({ ok: false, error: "invalid_token" }, { status: 403 });
      }
      return Response.json({ ok: false, error: "verification_failed" }, { status: 502 });
    }
    if (!sj.ok) {
      return Response.json({ ok: false, error: "verification_failed" }, { status: 502 });
    }
    if (sj.product_id !== PRODUCT_ID) {
      return Response.json({ ok: false, error: "wrong_product" }, { status: 403 });
    }
    if (!sj.paid) {
      return Response.json({ ok: false, error: "not_paid" }, { status: 402 });
    }
    const kidName = cleanName(sj.kid_name) || "Superstar";
    const theme = SIGNATURE_SCENE[sj.theme] ? sj.theme : "dinosaurs";

    // 2. Serve the cached PDF if this token already has one.
    const pdfKey = "pdf:" + token;
    const cached = await env.CACHE.get(pdfKey, "arrayBuffer").catch(() => null);
    if (cached && cached.byteLength > 10000) {
      return pdfResponse(cached, kidName);
    }

    // 3. Load the buyer's creative context, plan 12 scenes, generate images.
    const ctx = await loadPurchaseContext(env, sj.email);
    const descriptor = ctx.custom_prompt
      ? "prompt:" + ctx.custom_prompt
      : ctx.photo_desc
        ? "photo:" + ctx.photo_desc
        : "theme:" + theme;
    const scenes = await planScenes(env, theme, ctx);
    while (scenes.length < 12) scenes.push(fallbackScenes(theme)[scenes.length % 12]);
    const results = await Promise.allSettled(
      scenes.slice(0, 12).map((s) => sceneImage(env, theme, s, ctx.complexity, descriptor))
    );

    // 4. Guarantee 12 pages: substitute the signature scene for any failure.
    const sigBytes = await sceneImage(env, theme, SIGNATURE_SCENE[theme], ctx.complexity, descriptor);
    const images = results.map((r) =>
      r.status === "fulfilled" && r.value ? r.value : sigBytes
    );
    if (images.some((b) => !b)) {
      return Response.json({ ok: false, error: "generation_failed" }, { status: 502 });
    }

    // 5. Assemble, cache, serve.
    const pdfBytes = await buildPdf(kidName, images);
    await env.CACHE.put(pdfKey, pdfBytes, { expirationTtl: 60 * 60 * 24 * 30 }).catch((e) =>
      console.error("pdf cache put failed", e && e.message)
    );
    return pdfResponse(pdfBytes, kidName);
  } catch (e) {
    console.error("api/pdf error", e && e.message);
    return Response.json({ ok: false, error: "generation_failed" }, { status: 500 });
  }
}

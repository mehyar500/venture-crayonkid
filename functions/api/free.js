// functions/api/free.js
// POST /api/free — generate ONE free personalized coloring page.
// Body: { kid_name, theme, email }
// Stores the lead in D1, rate-limits per IP, returns the page as a data URL.
// The kid's name is overlaid client-side (image models mangle text).

const THEMES = {
  "dinosaurs": "a cute smiling T-Rex with baby dinosaurs",
  "space": "a cute smiling astronaut waving next to a rocket ship",
  "ocean": "a cute smiling octopus with happy fish friends",
  "jungle animals": "a cute smiling lion with a playful monkey",
  "unicorns": "a cute smiling unicorn under a rainbow",
  "vehicles": "a cute smiling race car next to a friendly truck",
  "farm animals": "a cute smiling cow with a happy piglet",
  "princess castle": "a cute smiling princess in front of a castle",
};
const IMG_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function cleanName(v) {
  return String(v || "")
    .replace(/[^\p{L} '\-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
}

function lineArtPrompt(scene) {
  // NB: do NOT use "children"/"kids" — the Workers AI safety filter flags them
  // on image calls. "Coloring book page" conveys the style alone.
  return (
    "Coloring book page, black and white line art: " + scene + ". " +
    "Bold thick black outlines only, pure white background, absolutely no shading, " +
    "no gradients, no grayscale, no color, simple clean line art, large easy shapes, " +
    "cute and friendly. No text, no words, no letters, no watermark."
  );
}

// flux-1-schnell returns { image: "<base64>" } via the Workers AI binding.
async function aiImageBytes(env, prompt) {
  const out = await env.AI.run(IMG_MODEL, { prompt });
  let b64 = null;
  if (out && typeof out.image === "string") b64 = out.image;
  else if (typeof out === "string") b64 = out;
  if (!b64) throw new Error("unexpected_ai_output");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function sniffMime(bytes) {
  if (bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return "image/png";
}

function sha256hex(str) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(str))
    .then((buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""));
}

function toDataUrl(bytes, mime) {
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return "data:" + mime + ";base64," + btoa(bin);
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => ({}));
    const kidName = cleanName(body.kid_name);
    const theme = String(body.theme || "").toLowerCase().trim();
    const email = String(body.email || "").trim().toLowerCase();

    if (kidName.length < 2) return json({ ok: false, error: "bad_name" }, 400);
    if (!THEMES[theme]) return json({ ok: false, error: "bad_theme" }, 400);
    if (!EMAIL_RE.test(email)) return json({ ok: false, error: "bad_email" }, 400);
    if (!env.AI || !env.DB || !env.CACHE) {
      return json({ ok: false, error: "service_unavailable" }, 503);
    }

    // Soft rate limit: 10 free pages per IP per hour.
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const rlKey = "rl:" + ip;
    const used = Number((await env.CACHE.get(rlKey)) || 0);
    if (used >= 10) return json({ ok: false, error: "rate_limited" }, 429);
    await env.CACHE.put(rlKey, String(used + 1), { expirationTtl: 3600 });

    // Store the lead (best effort — never block the free page on it).
    try {
      await env.DB.prepare(
        "INSERT INTO leads (email, kid_name, theme) VALUES (?, ?, ?)"
      ).bind(email, kidName, theme).run();
    } catch (e) {
      console.error("lead insert failed", e && e.message);
    }

    // Shared image cache: same theme+scene reuses the same drawing.
    const scene = THEMES[theme];
    const cacheKey = "img:" + (await sha256hex(theme + "::" + scene));
    let bytes = await env.CACHE.get(cacheKey, "arrayBuffer").catch(() => null);
    if (!bytes || bytes.byteLength < 10000) {
      bytes = await aiImageBytes(env, lineArtPrompt(scene));
      if (bytes && bytes.byteLength > 10000) {
        await env.CACHE.put(cacheKey, bytes, { expirationTtl: 60 * 60 * 24 * 30 }).catch(() => {});
      }
    }
    if (!bytes || bytes.byteLength < 10000) {
      return json({ ok: false, error: "generation_failed" }, 502);
    }
    bytes = new Uint8Array(bytes);

    return json({ ok: true, image: toDataUrl(bytes, sniffMime(bytes)), kid_name: kidName, theme });
  } catch (e) {
    console.error("api/free error", e && e.message);
    return json({ ok: false, error: "generation_failed" }, 500);
  }
}

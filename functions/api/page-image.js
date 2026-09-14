// functions/api/page-image.js
// GET /api/page-image?theme=... — serve the KV-cached line-art image for a
// preset theme. GET /api/page-image?img=<64-hex-id> — serve a custom-prompt
// or photo-derived drawing stored under its content id.
// Used by the free-page email so the parent can see the actual page
// (the Cloudflare email-sending API has no attachment support, so the email
// links/embeds this URL instead). Theme path uses the same cache key as
// /api/free's legacy path.

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

function sha256hex(str) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(str))
    .then((buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""));
}

function sniffMime(bytes) {
  if (bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return "image/png";
}

export async function onRequestGet({ request, env }) {
  const qs = new URL(request.url).searchParams;
  const theme = (qs.get("theme") || "").toLowerCase().trim();
  const imgId = (qs.get("img") || "").trim();
  if (!env.CACHE) return new Response("not found", { status: 404 });

  let cacheKey, filename;
  if (theme && THEMES[theme]) {
    // Preset theme drawing (same cache key as /api/free legacy path).
    cacheKey = "img:" + (await sha256hex(theme + "::" + THEMES[theme]));
    filename = "crayon-kid-" + theme.replace(/[^a-z]+/g, "-");
  } else if (/^[0-9a-f]{64}$/.test(imgId)) {
    // Custom-prompt or photo-derived drawing, stored under a content id.
    cacheKey = "pageimg:" + imgId;
    filename = "crayon-kid-page";
  } else {
    return new Response("not found", { status: 404 });
  }
  const bytes = await env.CACHE.get(cacheKey, "arrayBuffer").catch(() => null);
  if (!bytes || bytes.byteLength < 10000) {
    return new Response("not found", { status: 404 });
  }
  const u8 = new Uint8Array(bytes);
  return new Response(u8, {
    headers: {
      "content-type": sniffMime(u8),
      "cache-control": "public, max-age=2592000",
      "content-disposition": 'inline; filename="' + filename + '"',
    },
  });
}

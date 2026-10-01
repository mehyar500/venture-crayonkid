// functions/api/health.js
// GET /api/health — liveness probe. email_configured reports whether the
// transactional-email credentials are present (no secret values exposed).

export async function onRequestGet({ env }) {
  const emailConfigured = Boolean(
    env &&
    (env.CF_EMAIL_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID) &&
    (env.CLOUDFLARE_EMAIL || env.CF_EMAIL) &&
    (env.CLOUDFLARE_API_KEY || env.CF_EMAIL_GLOBAL_KEY)
  );
  return Response.json({
    ok: true,
    service: "crayonkid",
    time: new Date().toISOString(),
    email_configured: emailConfigured,
  });
}

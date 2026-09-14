// functions/api/health.js
// GET /api/health — liveness probe.

export async function onRequestGet() {
  return Response.json({
    ok: true,
    service: "crayonkid",
    time: new Date().toISOString(),
  });
}

// functions/_shared/emailSends.js
// Dedupe + bookkeeping for transactional emails. Table email_sends has a
// UNIQUE(event_type, event_key) constraint; the INSERT ... ON CONFLICT
// DO NOTHING claim is atomic, so concurrent/retried triggers send once.

export async function claimSend(db, eventType, eventKey, email) {
  const r = await db
    .prepare(
      "INSERT INTO email_sends (event_type, event_key, email, status) " +
      "VALUES (?, ?, ?, 'pending') ON CONFLICT(event_type, event_key) DO NOTHING"
    )
    .bind(eventType, eventKey, email)
    .run();
  return r && r.meta && r.meta.changes === 1;
}

export async function markSend(db, eventType, eventKey, ok, info) {
  try {
    await db
      .prepare(
        "UPDATE email_sends SET status = ?, message_id = ?, error = ? " +
        "WHERE event_type = ? AND event_key = ?"
      )
      .bind(
        ok ? "sent" : "failed",
        ok ? String(info || "").slice(0, 200) : null,
        ok ? null : String(info || "").slice(0, 300),
        eventType,
        eventKey
      )
      .run();
  } catch (e) {
    console.error("markSend failed", e && e.message);
  }
}

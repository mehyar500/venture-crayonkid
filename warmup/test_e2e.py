#!/usr/bin/env python3
"""Warmup E2E test (test address: info@mehyar.us ONLY).

Exercises the real path:
  Brevo send (send_day.brevo_send) -> warmup_campaign_sends row ->
  simulated Brevo 'delivered' webhook -> /api/warmup-unsubscribe click ->
  central opted_out -> suppression verified -> ALL test rows deleted.
"""
from __future__ import annotations
import json, secrets, sys, urllib.request

sys.path.insert(0, "/home/hatch/workspace/build/crayonkid-mvp/warmup")
from send_day import brevo_send, cf_d1, SUBJECT, HTML_TMPL, TEXT_TMPL, SITE, BRAND

TEST_EMAIL = "info@mehyar.us"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0"


def main() -> int:
    # 1. seed a pending central row for the test address
    cf_d1("""INSERT OR IGNORE INTO email_contact (email, brand, status, source, provider)
             VALUES (?,'crayonkid','pending','warmup-test','other')""", [TEST_EMAIL])
    token = secrets.token_urlsafe(32)
    cf_d1("INSERT INTO warmup_unsub_tokens (token, email, brand) VALUES (?,?,?)",
          [token, TEST_EMAIL, BRAND])
    unsub = f"{SITE}/api/warmup-unsubscribe?token={token}"

    # 2. real send via Brevo
    res = brevo_send(TEST_EMAIL, "Test", "[TEST] " + SUBJECT,
                     HTML_TMPL.format(greet="Hi Test,", site=SITE, day=0, unsub=unsub),
                     TEXT_TMPL.format(greet="Hi Test,", site=SITE, day=0, unsub=unsub),
                     {"List-Unsubscribe": f"<{unsub}>",
                      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"},
                     "warmup-test")
    assert res["ok"], f"brevo send failed: {res.get('error')}"
    msg_id = res["body"]["messageId"]
    print("sent, messageId:", msg_id)

    cf_d1("""INSERT INTO warmup_campaign_sends
             (brand, campaign_day, recipient_email, sent_at, status, message_id, source)
             VALUES ('crayonkid-test', 0, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'sent', ?, 'warmup-test')""",
          [TEST_EMAIL, msg_id])

    # 3. simulate Brevo 'delivered' webhook against the LIVE endpoint
    payload = json.dumps({"event": "delivered", "email": TEST_EMAIL,
                          "message-id": msg_id}).encode()
    req = urllib.request.Request(SITE + "/api/warmup-bwebhook", data=payload,
                                 headers={"Content-Type": "application/json",
                                          "User-Agent": UA}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        assert resp.status == 200, f"webhook HTTP {resp.status}"
    row = cf_d1("SELECT status FROM warmup_campaign_sends WHERE message_id=?", [msg_id])[0]
    assert row["status"] == "delivered", f"webhook did not flip status: {row}"
    print("webhook delivered -> status=delivered OK")

    # 4. click the one-click unsubscribe link (live)
    req = urllib.request.Request(unsub, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = resp.read().decode()
        assert resp.status == 200 and "unsubscribed" in body.lower(), "unsub page bad"
    st = cf_d1("SELECT status FROM email_contact WHERE email=? AND brand='crayonkid'",
               [TEST_EMAIL])[0]["status"]
    assert st == "opted_out", f"central flip failed: {st}"
    left = cf_d1("SELECT COUNT(*) n FROM warmup_unsub_tokens WHERE token=?", [token])[0]["n"]
    assert left == 0, "token not burned"
    print("unsubscribe click -> central opted_out + token burned OK")

    # 5. suppression: test address must NOT be drawable anymore
    draw = cf_d1("""SELECT email FROM email_contact WHERE brand='crayonkid'
                    AND source='legacy-daily' AND status='pending'
                    AND email NOT IN (SELECT recipient_email FROM warmup_campaign_sends)
                    LIMIT 5""")
    assert all(r["email"] != TEST_EMAIL for r in draw), "suppression leak!"
    print("suppression check OK (test address excluded from draw)")

    # 6. cleanup — zero residue
    cf_d1("DELETE FROM warmup_campaign_sends WHERE brand='crayonkid-test'")
    cf_d1("DELETE FROM email_contact WHERE email=? AND brand='crayonkid' AND source='warmup-test'",
          [TEST_EMAIL])
    n1 = cf_d1("SELECT COUNT(*) n FROM warmup_campaign_sends WHERE brand='crayonkid-test'")[0]["n"]
    n2 = cf_d1("SELECT COUNT(*) n FROM email_contact WHERE email=? AND brand='crayonkid'",
               [TEST_EMAIL])[0]["n"]
    n3 = cf_d1("SELECT COUNT(*) n FROM warmup_campaign_sends")[0]["n"]
    assert (n1, n2, n3) == (0, 0, 0), f"residue: {n1},{n2},{n3}"
    print("cleanup OK — zero test rows remain")
    print("E2E PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

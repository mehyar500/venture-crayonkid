#!/usr/bin/env python3
"""Screen the Legacy Daily pull and import the Crayon Kid warmup pool.

Screening recipe (mirrors the established legacy-cohort screening):
  - well-formed email address
  - gmail.com / googlemail.com only (provider='gmail' cohort)
  - no role addresses (admin@, info@, support@, ...)
  - no junk/disposable patterns
  - not already present in central email_contact under ANY brand
    (the 500 legacy contacts are mid-flight with another brand — never
    double-touch an inbox across brands)
  - deduped within the pull

Import: central mehyar-jobs D1 email_contact,
  brand='crayonkid', source='legacy-daily', status='pending', provider='gmail'.
INSERT OR IGNORE on UNIQUE(email, brand).

Usage: screen_and_import.py /tmp/crayonkid-pool.csv.gz [--take 2000] [--live]
  --live actually writes; without it, dry-run (prints what would import).
"""
from __future__ import annotations
import csv, gzip, json, os, re, sys, urllib.request

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

ACCOUNT_ID = "621600637337cc1c9ecb7095508bc732"
CENTRAL_DB = "de494f9a-9da2-4123-8bb7-269473cca8a6"
CRED = "custom.cloudflare"
HOSTS = ["api.cloudflare.com"]

EMAIL_RE = re.compile(r"^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$")
ROLE_LOCALS = {
    "admin", "administrator", "info", "support", "sales", "contact", "hello",
    "help", "billing", "abuse", "postmaster", "webmaster", "noreply",
    "no-reply", "donotreply", "careers", "jobs", "press", "media",
    "marketing", "team", "office", "service", "services", "accounts",
}
OK_DOMAINS = {"gmail.com", "googlemail.com"}
JUNK_PATTERNS = ("test", "spam", "fake", "junk", "trash", "tempmail", "guerrilla",
                 "mailinator", "10minutemail", "example.", "sample")


def d1_query(db_id: str, sql: str, params: list | None = None):
    url = (f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}"
           f"/d1/database/{db_id}/query")
    payload = {"sql": sql}
    if params:
        payload["params"] = params
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={
        "Content-Type": "application/json",
        "X-Auth-Email": load_email(),
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0",
    }, method="POST")
    add_surrogate_to_request(req, CRED, allowed_hosts=HOSTS)
    with urllib.request.urlopen(req, timeout=120) as resp:
        return read_json_response(resp)


def load_email():
    with open(os.path.expanduser("~/workspace/skills/cloudflare/config.json")) as f:
        return json.load(f)["email"]


def d1_all_emails() -> set[str]:
    body = d1_query(CENTRAL_DB, "SELECT email FROM email_contact")
    out = set()
    for r in body.get("result", []):
        for row in r.get("results", []):
            out.add(str(row["email"]).strip().lower())
    return out


def screened(path: str, existing: set[str]):
    seen, good, stats = set(), [], {"total": 0, "bad_format": 0, "role": 0,
                                    "junk": 0, "dup_pull": 0, "dup_central": 0}
    with gzip.open(path, "rt", newline="") as f:
        for row in csv.DictReader(f):
            stats["total"] += 1
            em = (row.get("email") or "").strip().lower()
            if not EMAIL_RE.match(em):
                stats["bad_format"] += 1
                continue
            local, _, domain = em.partition("@")
            if domain not in OK_DOMAINS:
                stats["junk"] += 1
                continue
            if local in ROLE_LOCALS or local.startswith(("noreply", "donotreply")):
                stats["role"] += 1
                continue
            if any(p in em for p in JUNK_PATTERNS):
                stats["junk"] += 1
                continue
            if em in seen:
                stats["dup_pull"] += 1
                continue
            seen.add(em)
            if em in existing:
                stats["dup_central"] += 1
                continue
            good.append({"email": em,
                         "first_name": (row.get("first_name") or "").strip()[:40]})
    return good, stats


def main(argv: list[str]) -> int:
    path = argv[1]
    take = int(argv[argv.index("--take") + 1]) if "--take" in argv else 2000
    live = "--live" in argv

    print("loading existing central emails...", flush=True)
    existing = d1_all_emails()
    print(f"central email_contact rows: {len(existing)}", flush=True)

    good, stats = screened(path, existing)
    print("screen stats:", json.dumps(stats))
    print(f"screened pool: {len(good)}")
    batch = good[:take]
    print(f"would import: {len(batch)} (live={live})")
    if not live or not batch:
        return 0

    # Multi-row INSERTs through the /query endpoint (the /batch endpoint
    # rejects this credential), 50 rows per call (D1 allows max 100
    # bound params per query; 2 params per row).
    inserted = 0
    for i in range(0, len(batch), 50):
        chunk = batch[i:i + 50]
        placeholders = ", ".join(["(?, 'crayonkid', 'pending', 'legacy-daily', ?, 'gmail')"] * len(chunk))
        params: list = []
        for c in chunk:
            params += [c["email"], c["first_name"]]
        res = d1_query(CENTRAL_DB,
            "INSERT OR IGNORE INTO email_contact (email, brand, status, source, first_name, provider) VALUES " + placeholders,
            params)
        if not res.get("success"):
            print("INSERT FAILED:", json.dumps(res)[:1500], file=sys.stderr)
            return 1
        for r in res.get("result", []):
            inserted += (r.get("meta") or {}).get("changes", 0) or 0
    print(f"imported rows (changes): {inserted}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

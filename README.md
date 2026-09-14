# 🖍️ Crayon Kid

**Live:** https://crayonkid.mehyar.us · **Price:** $6 one-time

A personalized AI coloring book for kids. Parent enters the kid's name + theme → one **free** AI-generated coloring page (name overlaid as real HTML text, never AI-generated text) → $6 Stripe checkout → **12-page personalized printable PDF**.

## Architecture

- **Host:** Cloudflare Pages project `crayonkid` (custom domain `crayonkid.mehyar.us`)
- **AI:** Workers AI binding `AI` directly on the Pages project (`[ai]` as a SINGLE table in wrangler.toml — verified working). Models: `@cf/black-forest-labs/flux-1-schnell` (line art), `@cf/meta/llama-3.1-8b-instruct-fp8` (scene planning).
- **DB:** D1 `crayonkid_db` binding `DB` — `leads(email, kid_name, theme, created_at)`
- **Cache:** KV `crayonkid_cache` binding `CACHE` — generated images (30d), finished PDFs (30d), IP rate limits (1h)
- **Payments:** centralized Stripe on mehyar-web — `POST mehyar.us/api/pay/checkout` with `product_id=crayonkid-coloring-book` (price from `billing_products`, $6). Paid status verified server-side via `GET mehyar.us/api/pay/status?token=`.

## Routes

| Route | What |
|---|---|
| `/` | Landing page + free page generator + $6 checkout CTA |
| `/unlock?paid=1&access_token=…` | Post-payment page: verifies via `/api/unlock`, builds the PDF (progress UI), downloads it |
| `POST /api/free` | `{kid_name, theme, email}` → D1 lead + 1 AI coloring page (data URL) |
| `GET /api/unlock?token=…` | Verifies payment → `{ok, paid, kid_name, theme}` |
| `GET /api/pdf?token=…` | Verifies payment → 12 AI pages → US-Letter PDF with name drawn on every page |
| `GET /api/health` | Liveness probe |

## Deploy

**Standard path (GitHub Actions is dead for ventures — do not use):**

```bash
python3 deploy.py   # from the project root
```

`deploy.py` stages a clean copy in `/tmp/ck-deploy`, mints a short-lived scoped
Cloudflare token (Pages Write + Memberships Read + User Details Read) via the
global admin credential (raw value only in the child-process env, never printed),
and runs `wrangler pages deploy`. The `.github/workflows/deploy.yml` file stays in
the repo for when the Actions restriction lifts.

This repo's wrangler.toml intentionally has NO `[vars]` section, so deploys are
idempotent w.r.t. project env. **Never** use this deploy pattern on a project
whose secrets live only in the dashboard (e.g. mehyar-web).

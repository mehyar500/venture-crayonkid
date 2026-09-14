# 🖍️ Crayon Kid

**Live:** https://crayonkid.mehyar.us · **Price:** $6 one-time

A personalized AI coloring book for kids. Parent enters the kid's name + theme → one **free** AI-generated coloring page (name overlaid as real HTML text, never AI-generated text) → $6 Stripe checkout → **12-page personalized printable PDF**.

## Architecture

- **Host:** Cloudflare Pages project `crayonkid` (custom domain `crayonkid.mehyar.us`)
- **AI:** Workers AI binding `AI` (no API tokens) — `@cf/black-forest-labs/flux-1-schnell` for line art, `@cf/meta/llama-3.1-8b-instruct` for scene planning
- **DB:** D1 `crayonkid_db` binding `DB` — `leads(email, kid_name, theme, created_at)`
- **Cache:** KV `crayonkid_cache` binding `CACHE` — generated images (30d), finished PDFs (30d), IP rate limits (1h)
- **Payments:** centralized Stripe on mehyar-web — `POST mehyar.us/api/pay/checkout` with `product_id=crayonkid-coloring-book` (price from `billing_products`, $6). Paid status verified server-side via `GET mehyar.us/api/pay/status?token=`.

## Routes

| Route | What |
|---|---|
| `/` | Landing page + free page generator + $6 checkout CTA |
| `/unlock?token=…` | Post-payment page: builds the PDF (progress UI) and downloads it |
| `POST /api/free` | `{kid_name, theme, email}` → D1 lead + 1 AI coloring page (data URL) |
| `GET /api/pdf?token=…` | Verifies payment → 12 AI pages → US-Letter PDF with name drawn on every page |

## Deploy

Push to `main` (or run the workflow manually) → `.github/workflows/deploy.yml` runs
`wrangler pages deploy` from GitHub Actions. **Never** run `wrangler pages deploy` locally
from a directory with `[vars]` in wrangler.toml — this repo's toml intentionally has none.

Secrets needed in GitHub Actions: `CLOUDFLARE_API_TOKEN` (Pages:Edit scoped), `CLOUDFLARE_ACCOUNT_ID`.

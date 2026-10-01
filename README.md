# 🖍️ Crayon Kid

**Live:** https://crayonkid.mehyar.us · **Price:** $6 one-time

A personalized AI coloring book for kids. Parent enters the kid's name, then creates a free coloring page three ways — **pick a theme**, **describe anything**, or **upload a photo** (redrawn as line art) — with a Simple/Detailed complexity toggle → $6 Stripe checkout → **12-page personalized printable PDF** (high-res print quality, crisp at US Letter/A4).

## Architecture

- **Host:** Cloudflare Pages project `crayonkid` (custom domain `crayonkid.mehyar.us`)
- **AI:** Workers AI binding `AI` directly on the Pages project (`[ai]` as a SINGLE table in wrangler.toml — verified working). Models: `@cf/black-forest-labs/flux-1-schnell` (line art), `@cf/meta/llama-3.1-8b-instruct-fp8` (scene planning), `@cf/meta/llama-3.2-11b-vision-instruct` (photo description, one image per call).
- **DB:** D1 `crayonkid_db` binding `DB` — `leads`, `email_sends` (dedupe), `purchase_context` (creative context keyed by email — the centralized status endpoint only exposes kid_name/theme, so this is how complexity/custom prompts/photo descriptions reach the paid PDF). See `schema.sql`.
- **Cache:** KV `crayonkid_cache` binding `CACHE` — generated images (30d), finished PDFs (30d), IP rate limits (1h)
- **Payments:** centralized Stripe on mehyar-web — `POST mehyar.us/api/pay/checkout` with `product_id=crayonkid-coloring-book` (price from `billing_products`, $6). Paid status verified server-side via `GET mehyar.us/api/pay/status?token=`.

## Routes

| Route | What |
|---|---|
| `/` | Landing page: 3 creation modes (theme / describe / photo) + complexity toggle + $6 checkout CTA |
| `/unlock?paid=1&access_token=…` | Post-payment page: verifies via `/api/unlock`, builds the PDF (progress UI), downloads it |
| `POST /api/free` | `{kid_name, email, theme?, prompt?, complexity?}` → D1 lead + 1 AI coloring page (data URL) + free-page email |
| `POST /api/photo` | multipart `{photo, kid_name, email, complexity}` → vision-describe → line-art redraw (data URL). Original photo is NEVER stored; tighter rate limit (3/hr/IP) |
| `GET /api/page-image?theme=…` / `?img=<id>` | Serves the KV-cached drawing for the free-page email (email API has no attachments) |
| `GET /api/unlock?token=…` | Verifies payment → `{ok, paid, kid_name, theme}` + sends receipt email once |
| `GET /api/pdf?token=…` | Verifies payment → honors purchase_context (complexity/custom/photo) → 12 AI pages → US-Letter PDF with name drawn on every page |
| `GET /api/health` | Liveness probe |

## Print-quality honesty

flux-1-schnell's schema only accepts `{prompt, steps}` — output is fixed-resolution **raster** (~1024px JPEG), no vector/upscaling knob. The PDF embeds those bytes at full native resolution: crisp at US Letter/A4 print size. We never claim infinite scaling — not in code, email copy, or FAQ.

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

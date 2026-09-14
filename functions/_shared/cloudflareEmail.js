// functions/_shared/cloudflareEmail.js
// Verbatim copy of mehyar-web's functions/api/_shared/cloudflareEmail.js
// (the exact email-sending code path used by the centralized Stripe
// `digital` fulfillment hook). Sends via the Cloudflare email-sending API.
// Reads credentials from env: CF_EMAIL_ACCOUNT_ID (or CLOUDFLARE_ACCOUNT_ID),
// CLOUDFLARE_EMAIL (or CF_EMAIL), CLOUDFLARE_API_KEY (or CF_EMAIL_GLOBAL_KEY).
const EMAIL_API = "https://api.cloudflare.com/client/v4/accounts";

export async function sendCloudflareEmail(env, message) {
  const accountId = env?.CF_EMAIL_ACCOUNT_ID || env?.CLOUDFLARE_ACCOUNT_ID;
  const authEmail = env?.CLOUDFLARE_EMAIL || env?.CF_EMAIL;
  const authKey = env?.CLOUDFLARE_API_KEY || env?.CF_EMAIL_GLOBAL_KEY;
  if (!accountId || !authEmail || !authKey) {
    return { ok: false, status: "not_configured", error: "cloudflare_email_credentials_missing" };
  }

  const response = await fetch(`${EMAIL_API}/${encodeURIComponent(accountId)}/email/sending/send`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-auth-email": authEmail,
      "x-auth-key": authKey,
    },
    body: JSON.stringify({
      to: message.to,
      from: {
        address: message.from || env.CONTACT_FROM_EMAIL || "info@mehyar.us",
        name: message.fromName || "MehyarSoft",
      },
      reply_to: message.replyTo || "info@mehyar.us",
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) {
    const firstError = Array.isArray(payload?.errors) ? payload.errors[0] : null;
    return {
      ok: false,
      status: `cloudflare_email_${response.status}`,
      error: String(firstError?.message || "cloudflare_email_send_failed").slice(0, 300),
    };
  }
  const delivered = Array.isArray(payload?.result?.delivered) ? payload.result.delivered : [];
  const queued = Array.isArray(payload?.result?.queued) ? payload.result.queued : [];
  return {
    ok: true,
    status: delivered.length ? "delivered" : queued.length ? "queued" : "accepted",
    messageId: payload?.result?.messageId || payload?.result?.id || null,
  };
}

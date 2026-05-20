# Resend SMTP Setup Checklist

What this enables: transactional emails (order confirmation, proof-ready, approval-confirmation, change-request notifications, contact form). Without this, the proof workflow logs to the console but customers never receive emails.

Free tier: 3,000 emails/mo (100/day). Generous for launch volume.

---

## Step 1 — Resend account + domain (10 min)

1. Sign up at https://resend.com (use `david.stillbesideme@gmail.com` so all admin emails land in one inbox).
2. In the Resend dashboard: **Domains → Add Domain → `stillbesideme.com`**.
3. Resend will show you 3 DNS records to add:
   - 1× **MX** record (for receiving bounces)
   - 1× **TXT** for SPF — `v=spf1 include:_spf.resend.com ~all`
   - 1× **TXT** for DKIM — long `resend._domainkey` value
4. Wherever DNS is hosted (Cloudflare, Namecheap, GoDaddy, etc.), add these three records exactly as shown. Don't change anything else.
5. Wait 5–10 minutes for propagation. Click **Verify** in Resend. All three should turn green.

> **Don't skip the DKIM record.** Without it, emails will hit Gmail/Outlook spam folders.

## Step 2 — API key (1 min)

1. **Resend → API Keys → Create API Key**.
2. Name it `still-beside-me-production`. Permission: `Sending access` (not full).
3. Copy the key (`re_xxxxxxxxxxxx`). You won't see it again.

## Step 3 — Railway environment variables (3 min)

In Railway → your service → **Variables** tab, add these:

```
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_USER=resend
SMTP_PASS=re_xxxxxxxxxxxx           # the key from step 2
EMAIL_FROM=Still Beside Me <hello@stillbesideme.com>
ADMIN_EMAIL=david.stillbesideme@gmail.com
```

Save. Railway will redeploy automatically.

## Step 4 — Smoke test (2 min)

From your local machine (not Railway), populate the same vars in `.env` and run:

```
node scripts/test-email.js david.stillbesideme@gmail.com
```

You should receive three emails within a minute:
- "Order confirmed — 00000000"
- "Your design proof is ready — Order 00000000"
- "Your tribute is printing — Order 00000000"

If any land in spam, the DKIM record isn't verified yet — wait longer and re-verify in Resend.

If `EAUTH` error: SMTP_PASS is wrong.
If `ECONNECTION`: SMTP_HOST / SMTP_PORT wrong.

## Step 5 — End-to-end test on Railway (5 min)

1. Open the live site, build a tribute, run a Stripe test-mode purchase (use card `4242 4242 4242 4242`).
2. Within seconds, you should receive **"Order confirmed"** at the email you entered at checkout.
3. Within 30s, you should receive **"Your design proof is ready"** with a clickable link.
4. Click "Review your proof" → approve → you should receive **"Your tribute is printing"**.
5. Visit `/order` on the live site → enter that email + the short order ID from the confirmation email → you should see the full status timeline.

If all four emails arrive and the status page works → launch-ready.

---

## What's already coded (no further work needed)

- `src/services/emailService.js`: four functions — `sendOrderConfirmation`, `sendProofEmail`, `sendChangeRequestNotification`, `sendApprovalConfirmation`. All send via Nodemailer with the SMTP creds above.
- `src/routes/stripeWebhooks.js`: fires order confirmation immediately on payment, then generates proof, then fires proof email.
- `src/routes/proofApproval.js`: fires approval confirmation on customer approval.
- All transactional emails include a link to the order status page (`/order/:token`).

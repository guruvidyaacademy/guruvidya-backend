GuruVidya 20 Oct 10:37 PM baseline - targeted backend patch
Changed: server.js only.

Email View in CRM: signed redirect records Clicked + timestamp when the link is requested. Uses INTERNAL_ALERT_CLICK_SECRET (recommended) or RESEND_WEBHOOK_SECRET. Configure PUBLIC_API_URL to the deployed HTTPS backend. This applies to NEW internal-team emails after deployment, not old emails.

Resend Delivered / Opened: genuine provider callbacks are required. In Resend dashboard enable open/click tracking for the sending domain, configure webhook https://<backend-host>/api/webhook/resend for email.delivered, email.opened, email.clicked and set RESEND_WEBHOOK_SECRET to the matching whsec_ signing secret in Render. Email clients may block open pixels; never infer opens from reading in the mail app. Signed CRM clicks may be triggered by security link scanners; interpret cautiously.

WhatsApp: Existing BotSailor send/file endpoint supports image+caption, not native URL CTA. A genuine WhatsApp CTA requires an approved WhatsApp template with URL button and the matching BotSailor account-specific send-template API configuration. No unsafe/unverified API calls added; current caption/URL remains clickable as a hyperlink in WhatsApp. This ZIP does NOT claim to solve native WhatsApp CTA.

No Admin changes. No booking/design/rules changes.

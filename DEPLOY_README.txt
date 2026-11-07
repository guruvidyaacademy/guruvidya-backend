Guruvidya Smart Reminder 2h/1h preference filtering — changed files only
Baseline: guruvidya-backend-main-8nov-1-13am.zip

Replace these files in the BACKEND repository at exactly the same paths:
 booking/smart-reminder-step6g-dispatch-guard.js
 booking/smart-reminder-step6e-queue-worker.js
 booking/smart-reminder-preference-change.js
 booking/smart-reminder-step6g-dispatch-guard.test.mjs (test file)

No admin changes. Keep master automation OFF.

Scope: NO preference suppresses pending and newly queued 2h/1h reminders on WhatsApp AND Email; online 5min remains independent. Existing 4h WhatsApp preference handling remains otherwise unchanged.

NOT INCLUDED: Email response button/endpoint and cross-channel confirmation synchronization. The existing backend does not provide the required authenticated email attendance action in the smart-reminder workflow. This patch must NOT be represented as the approved complete cross-channel feature. Automatic 2h/1h live sending is not activated by this patch.

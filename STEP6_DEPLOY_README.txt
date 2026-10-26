GURUVIDYA SMART REMINDERS — STEP 6A: READ-ONLY SCHEMA PREFLIGHT

Add booking/smart-reminder-step6-preflight.js to the backend repository.
This is an export-only diagnostic. It does NOT start a worker or activate dispatch.
No server.js modification is included. Existing services remain unchanged.

Before any live activation, a developer should invoke runSmartReminderStep6Preflight(pool)
from a trusted backend maintenance context, with a connected pg Pool.
It returns ready/missing/queueUnique; do NOT expose this diagnostic publicly.

IMPORTANT: Deployment startup success alone does NOT verify the queue schema.
The existing queue planner requires GV_SMART_REMINDER_QUEUE_PLANNING=enabled AND
GV_SMART_REMINDER_REVISION_WRITES=enabled; DO NOT enable these until the actual
booking schema and lifecycle writes are audited.

The existing dispatch boundary is NOT a provider adapter. Do not enable live
sending until transaction-safe claims, consent, approved WhatsApp templates,
email fallback, actual provider receipts, and tracking are integrated and tested.

Test: node --test booking/smart-reminder-step6-preflight.test.mjs
This package is not the final live scheduler release.

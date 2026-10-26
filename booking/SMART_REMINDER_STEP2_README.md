# Step 2 — Scheduler planning foundation (HOLD)

Based on the uploaded 28 Oct 7:41 PM backend baseline. Copy these three files to `booking/` (two new, one modified). No Admin files changed.

The pure `planSmartReminderStages` function computes future offline 4h/2h/1h and online 4h/2h/1h/5min stages with per-recipient/channel settings, appointment revision checks, cancellation checks and deterministic idempotency keys. Expired stages are never backfilled.

**IMPORTANT: Not an automatic scheduler.** This is deliberately unmounted, makes no DB calls, sends no WhatsApp/email, never activates cron, and leaves master automation OFF. Actual database-backed atomic claims, safe reschedule revision increments, persistent jobs, email fallback and provider dispatch require a separately reviewed integration before activation.

Existing `runSmartReminderDisabledScheduler` is unchanged and continues returning transport_hold. No live production validation has been performed.

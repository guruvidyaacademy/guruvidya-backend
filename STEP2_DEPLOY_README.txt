GURUVIDYA SMART REMINDERS - STEP 2 / CUSTOM TIMING PLANNER
CHANGED FILE: booking/smart-reminder-stage-planner.js

Replace this file in the Backend GitHub repository at the same path, then deploy Render.
No Admin files changed. Existing Step 1 queue initialization remains untouched.

What changed:
- Read saved stage_minutes values for Offline/Online stage timing.
- Validate integer minute values (1..10080), reject duplicate stage timings per mode.
- Produce future-only, revision-bound, recipient/channel-specific planning items.
- Keep immutable stage identifiers (4h, 2h, 1h, 5min) for existing tracking and queue compatibility.
- Explicitly remain planning-only; no job insertion or WhatsApp/Email dispatch.

Verification: Run 'node --test booking/smart-reminder-stage-planner.test.mjs' locally
if you copy the optional test file from this ZIP into booking/. (Tests use node ESM.)

IMPORTANT: Step 1 database queue table is NOT proven present by generic startup logs.
Before moving to Step 3 verify in PostgreSQL:
SELECT to_regclass('public.booking_smart_reminder_jobs');

Next step: queue persistence with schema-aware validation and reschedule/cancel safeguards.
Master Automation stays OFF until live sender, consent, and delivery receipt integration are complete.

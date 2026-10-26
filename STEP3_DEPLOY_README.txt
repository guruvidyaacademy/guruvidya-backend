Guruvidya CRM Phase 3 - STEP 3: Transactional Reminder Job Queue Writer

Changed-files-only ZIP. No Admin changes.

1. Copy booking/smart-reminder-step3-job-store.js to the exact same backend path.
2. Optionally copy booking/smart-reminder-step3-job-store.test.mjs (tests only).
3. Commit and deploy to Render.
4. Confirm startup and PostgreSQL connection in Render logs.

WHAT THIS STEP DOES:
- Provides a transaction-safe queue writer using one dedicated PostgreSQL client.
- Validates saved dynamic Hours/Minutes against each due time.
- Checks booking status, appointment revision, mode, cancellation/trash, and future due time.
- Uses ON CONFLICT idempotency and returns inserted/skipped counts.
- Does not send WhatsApp/Email or start any timer.

IMPORTANT LIMITATIONS:
- Queue writer is NOT yet connected to the automatic scheduler, so deploying this step does NOT automatically create jobs.
- Requires verified booking_smart_reminder_jobs table and appointment_revision column + enabled revision updates before future wiring.
- No live sending; Master Automation remains OFF.
- A successful Render startup does NOT verify table existence. Run schema checks before Step 4.

LOCAL TEST: node --test booking/smart-reminder-step3-job-store.test.mjs
Expected: 4 passing tests.

NEXT STEP: verify live PostgreSQL schema/revision writes and wire a safe, controlled planning/queue trigger; then due-job runner and provider delivery.

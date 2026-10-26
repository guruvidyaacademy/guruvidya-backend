GURUVIDYA PHASE 3 / STEP 4 — QUEUE PLANNING ONLY

Changed files:
- server.js (one import and one startup call)
- booking/smart-reminder-step4-queue-reconciler.js (new)

IMPORTANT: Existing Reminder Settings UI and existing booking notification flows are unchanged.
WhatsApp/email sends: ZERO. Master Automation: still locked OFF.

Deploy:
1. Copy the two code files into the same paths in the Backend repository.
2. Deploy on Render. Keep GV_SMART_REMINDER_QUEUE_PLANNING unset (safe default).
3. Confirm logs include: [Smart Reminders Step 4] Queue planner disabled (safe default).
4. Before enabling planning, verify student_bookings.appointment_revision exists, is positive,
   and ALL booking lifecycle paths increment revision on reschedule/cancel/slot changes.
   Also verify booking_smart_reminder_jobs table and its UNIQUE constraint exist.
5. Only after database/revision audit and correction, set BOTH Render environment flags:
     GV_SMART_REMINDER_REVISION_WRITES=enabled
     GV_SMART_REMINDER_QUEUE_PLANNING=enabled
   Redeploy. Observe [Smart Reminders Step 4] {"status":"queued_only",...}.
   Never set these flags without the revision migration/audit; the system fails closed.
6. Read-only PostgreSQL verification:
   SELECT status,COUNT(*) FROM booking_smart_reminder_jobs GROUP BY status;
   SELECT id,booking_id,appointment_revision,recipient,channel,stage,due_at,status
   FROM booking_smart_reminder_jobs ORDER BY id DESC LIMIT 20;

WARNING: This step deliberately does NOT install revision schema migrations automatically,
so the existing booking system cannot be changed silently. Queue planning may remain OFF
until the revision audit is complete. Job creation alone does not mean delivery.

Rollback: remove these two changes and unset GV_SMART_REMINDER_QUEUE_PLANNING.

GURUVIDYA SMART REMINDERS - STEP 1 / DATABASE QUEUE FOUNDATION
Baseline: Admin and Backend full ZIPs from 27 Oct, 1:42 AM.
Changed backend files (copy to same relative paths in repository):
  booking/booking.js
  booking/smart-reminder-job-schema.js
No Admin changes in Step 1.

DEPLOY:
1. Back up your Render PostgreSQL database before deployment.
2. Replace/add these two files in the Backend GitHub repository; commit and deploy on Render.
3. Check Render startup logs. The existing initBooking() now attempts to create
   booking_smart_reminder_jobs and its pending-due index, after tracking schema init.
4. Verify with PostgreSQL SQL editor:
   SELECT to_regclass('public.booking_smart_reminder_jobs') AS job_table;
   SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='booking_smart_reminder_jobs';
   SELECT count(*) FROM public.booking_smart_reminder_jobs;
5. Expected: job_table is booking_smart_reminder_jobs; index exists; count may be 0.
   If logs show 'Tracking schema unavailable', send the full error before Step 2.

IMPORTANT:
- This step ONLY creates an additive queue table. It does not send any message.
- Master Automation remains OFF/locked. Existing booking alerts remain unchanged.
- No changes to existing booking, consent, or tracking records.
- Next step: safely enqueue jobs using saved custom timing and appointment revision.
- Do not enable Master Automation or expect live WhatsApp/Email delivery yet.

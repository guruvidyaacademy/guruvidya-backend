Guruvidya Phase 3 - Step 6H Atomic Queue Reservation
Files: booking/smart-reminder-step6h-atomic-queue.js and its test.
This module is NOT imported into server.js, does NOT start a worker, does NOT send WhatsApp/Email,
and does NOT unlock Master Automation. Existing CRM remains unchanged.
DO NOT call reserveDueSmartReminderJobs(enabled:true) in production until there is a
verified claim lease/recovery policy, booking revision + consent revalidation, and provider
acceptance/receipt writer. Claimed jobs cannot be retried by this module alone.
Run test: node --test booking/smart-reminder-step6h-atomic-queue.test.mjs
This is NOT a final live automation release.

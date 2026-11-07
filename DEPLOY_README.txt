GURUVIDYA 4H EMAIL — APPROVED VISUAL CORRECTION, CHANGED FILES ONLY

Files:
 server.js
 booking/smart-reminder-original-logo.png (original user-supplied logo, retained)
 booking/smart-reminder-approved-banner.jpg (approved banner crop)
 booking/smart-reminder-header-wave.jpg (approved header wave crop)

Changes: premium branded 4h manual-test email header/banner, original logo, existing red/blue icon assets, three-column blue appointment card, help icons. The existing shared student-email footer function is reused UNCHANGED. Existing 4h WhatsApp code untouched.

IMPORTANT LIMITATION: Manual 4h email has no secure action URLs. Accordingly the TEST email intentionally shows 'No action is required' rather than displaying fake clickable buttons. Real Yes/Reschedule/Cancel email actions and Email-WhatsApp synchronization remain NOT IMPLEMENTED. Do not represent this as a complete live 4h reminder feature.

DEPLOYMENT SAFETY: server.js is based on the earlier 8 Nov 1:13 AM backend with the previous email-design patch. If your GitHub server.js contains newer changes, do not overwrite it blindly; merge only the new art route and smartReminderFourHourEmailHtml function. Keep Master Automation OFF. No Admin files modified.

Validation: node --check server.js; ZIP CRC check. No live email/DB test performed.

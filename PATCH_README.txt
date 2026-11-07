GURUVIDYA 4H EMAIL — HEADER WAVE & WHATSAPP ICON VISUAL PATCH

Only changed backend files:
 server.js (one isolated 4h email WhatsApp icon reference)
 booking/smart-reminder-header-wave.jpg (approved wave crop)
 booking/email-icons/whatsapp-reminder-green.png (dedicated reminder icon; existing shared icon untouched)

No Admin changes. Existing shared Student Confirmed/Rescheduled/Cancelled email footer is unchanged. Existing WhatsApp 4h flow untouched. No email action buttons added: manual-test message still intentionally has no secure links.

CRITICAL DEPLOYMENT NOTE: server.js was patched against the previous 8 Nov visual-fix ZIP, NOT verified against your latest live GitHub server.js. Do NOT blindly replace server.js if GitHub has newer commits. Merge the single HTML image reference within smartReminderFourHourEmailHtml, and copy the two assets.

To merge: inside smartReminderFourHourEmailHtml only, replace ${icon('whatsapp','green',22)} with <img src="${esc(base)}/api/public/booking/email-icon/whatsapp-reminder-green.png?v=1" width="22" height="22" alt="WhatsApp" style="display:block;width:22px;height:22px;border:0">.

Node syntax PASS. No live Gmail rendering or integration test performed. Keep Master Automation OFF.

// Table-based email layout for Outlook, Apple Mail and Gmail.
// Original logo files and acknowledgement/tracking routes are deliberately unchanged.
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const socials = [
  ['Facebook', 'https://www.facebook.com/guruvidyaacademypvtltd', 'f', '#1877f2'],
  ['Instagram', 'https://www.instagram.com/guruvidyaca/', '◎', '#cf3588'],
  ['YouTube', 'https://www.youtube.com/c/GuruvidyaIn', '▶', '#ed3333'],
  ['LinkedIn', 'https://www.linkedin.com/in/guruvidya-academy-pvt-ltd', 'in', '#0a78b7'],
  ['X', 'https://x.com/guruvidya_', 'X', '#17243a']
];

export function renderInternalReminderEmail({name, number, total, remaining, acknowledgementUrl, publicBase}) {
  const minutesLeft = Math.max(0, Math.floor(Number(remaining) || 0));
  const hours = Math.floor(minutesLeft / 60);
  const minutes = minutesLeft % 60;
  const recipient = esc(name || 'Recipient');
  const base = String(publicBase || '').replace(/\/$/, '');
  const logo = esc(base + '/api/public/internal-reminder/logo');
  const footerIcon = esc(base + '/api/public/internal-reminder/g-icon');
  const socialLinks = socials.map(([label, url, glyph, color]) =>
    `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(label)}" aria-label="${esc(label)}" style="display:inline-block;vertical-align:middle;text-align:center;width:28px;line-height:28px;margin:0 2px 5px;border-radius:50%;background:${color};color:#ffffff;font:bold 13px/28px Arial,sans-serif;text-decoration:none">${glyph}</a>`
  ).join('');
  const row = (symbol, label, value) => `<tr><td width="44" style="padding:12px 6px 12px 15px;border-bottom:1px solid #dbe8f8"><span style="display:inline-block;border-radius:50%;background:#e9f4ff;color:#0757b9;font-size:20px;text-align:center;width:36px;line-height:36px">${symbol}</span></td><td style="padding:12px 6px;border-bottom:1px solid #dbe8f8;color:#425677;font-size:14px">${label}</td><td style="padding:12px 12px 12px 6px;border-bottom:1px solid #dbe8f8;color:#102b5b;font-size:15px;font-weight:bold">${value}</td></tr>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:18px 8px;background:#edf5fc;font-family:Arial,Helvetica,sans-serif;color:#10264d">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden">
<tr><td style="padding:25px 26px 18px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td width="70%" style="vertical-align:middle;padding-right:15px"><img src="${logo}" alt="Guruvidya – REAL EDUCATION • REAL RESULTS" width="380" style="display:block;width:100%;max-width:380px;height:auto;border:0"></td>
<td width="30%" align="center" style="vertical-align:middle;border-left:1px solid #c5d9f5;padding-left:13px"><div style="background:#eef7ff;border-radius:12px;padding:13px 5px;color:#0d3472;font-size:14px;line-height:1.35;font-weight:bold">✉ &nbsp;Internal<br>Appointment<br>Alert</div></td>
</tr></table></td></tr>
<tr><td style="padding:0 26px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eaf9f1;border-left:7px solid #0dbb65;border-radius:12px"><tr>
<td width="64" align="center" style="padding:20px 5px 20px 15px;vertical-align:middle"><span style="display:inline-block;border-radius:50%;background:#05a65a;color:white;width:56px;line-height:56px;text-align:center;font-size:30px">☎</span></td>
<td style="padding:20px 12px;vertical-align:middle"><div style="color:#062c2a;font-size:21px;line-height:1.25;font-weight:bold">WhatsApp 24-Hour Window Reminder</div><div style="padding-top:11px"><span style="display:inline-block;background:#008e52;color:white;border-radius:24px;padding:8px 16px;font-size:15px;font-weight:bold">Reminder ${Number(number)} of ${Number(total)}</span></div></td>
</tr></table>
<h2 style="color:#171717;font-size:21px;margin:24px 0 8px">Dear ${recipient},</h2>
<p style="font-size:15px;line-height:1.65;color:#34466a;margin:0 0 20px">This is an automated reminder regarding the WhatsApp service window for the student. Please take the necessary action.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #c7ddfb;border-radius:12px;border-collapse:separate;border-spacing:0">
${row('●', 'Recipient', recipient)}
${row('✉', 'Channel', 'Email')}
${row('◷', 'Window Remaining', `<span style="display:inline-block;background:#e4f3ff;border-radius:20px;padding:7px 11px;white-space:nowrap">◷ ${hours}h ${minutes}m</span>`)}
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px"><tr><td align="center" bgcolor="#009c59" style="border-radius:10px"><a href="${esc(acknowledgementUrl)}" target="_blank" rel="noopener noreferrer" style="display:block;padding:18px 10px;color:#ffffff;text-decoration:none;font-size:21px;line-height:1.25;font-weight:bold">✓ &nbsp;Acknowledge Receipt &nbsp;→</a></td></tr></table>
<p style="text-align:center;color:#425576;font-size:13px;line-height:1.5;margin:10px 0 20px">Click to confirm that you have received and reviewed this email.</p>
<div style="background:#e6f4ff;border-radius:10px;padding:16px;color:#0766d6;font-size:14px;line-height:1.55">ⓘ &nbsp;Your acknowledgement helps us keep our records updated and ensures timely follow-up.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #b6d6fa;margin-top:24px;text-align:center;color:#0b3374"><tr>
<td width="33%" style="padding:16px 3px;font-size:13px;font-weight:bold;line-height:1.4"><span style="font-size:25px;color:#0871dd">◎</span><br>Timely<br>Follow-up</td>
<td width="34%" style="padding:16px 3px;font-size:13px;font-weight:bold;line-height:1.4;border-left:1px solid #d6e6fa;border-right:1px solid #d6e6fa"><span style="font-size:25px;color:#0871dd">♟</span><br>Better<br>Student Support</td>
<td width="33%" style="padding:16px 3px;font-size:13px;font-weight:bold;line-height:1.4"><span style="font-size:25px;color:#0871dd">▥</span><br>Stay<br>Organized</td>
</tr></table>
</td></tr>
<tr><td bgcolor="#052c67" style="padding:23px 25px;background:#052c67;border-top:8px solid #0874dc">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td width="60%" style="vertical-align:middle"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="vertical-align:middle;padding-right:9px"><img src="${footerIcon}" alt="Guruvidya G icon" width="55" height="54" style="display:block;border:0"></td><td style="vertical-align:middle"><div style="color:#ffffff;font-size:16px;line-height:1.25;font-weight:bold">Guruvidya Academy Pvt. Ltd.</div><div style="color:#ff5555;font-size:10px;line-height:1.5;font-weight:bold">REAL EDUCATION • REAL RESULTS</div></td></tr></table></td>
<td width="40%" align="right" style="vertical-align:middle">${socialLinks}<div style="font-size:12px;padding-top:4px"><a href="https://www.guruvidya.in" target="_blank" rel="noopener noreferrer" style="color:#ffffff;text-decoration:none">www.guruvidya.in</a></div></td>
</tr></table>
<div style="border-top:1px solid #5279ad;margin-top:20px;padding-top:12px;color:#e2efff;font-size:12px;line-height:1.5">ACCA | CA | CS | CMA | B.Com | 11th &amp; 12th (Commerce)</div>
</td></tr></table>
</body></html>`;
}

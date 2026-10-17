// Reference-matched email artwork. Original Guruvidya PNGs and acknowledgement flow are unchanged.
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const socials=[
 ['facebook','https://www.facebook.com/guruvidyaacademypvtltd'],
 ['instagram','https://www.instagram.com/guruvidyaca/'],
 ['youtube','https://www.youtube.com/c/GuruvidyaIn'],
 ['linkedin','https://www.linkedin.com/in/guruvidya-academy-pvt-ltd'],
 ['x','https://x.com/guruvidya_']
];
export function renderInternalReminderEmail({name,number,total,remaining,acknowledgementUrl,publicBase}){
  const base=String(publicBase||'').replace(/\/$/,'');
  const art=(id)=>esc(base+'/api/public/internal-reminder/art/'+id);
  const logo=esc(base+'/api/public/internal-reminder/logo');
  const gIcon=esc(base+'/api/public/internal-reminder/g-icon');
  const img=(id,w,h,alt='')=>`<img src="${art(id)}" width="${w}" height="${h}" alt="${esc(alt)}" style="display:block;border:0;width:${w}px;height:${h}px">`;
  const recipient=esc(name||'Recipient');
  const left=Math.max(0,Math.floor(Number(remaining)||0));
  const time=`${Math.floor(left/60)}h ${left%60}m`;
  const row=(id,label,value)=>`<tr><td width="76" style="padding:3px 12px 3px 18px;border-bottom:1px solid #d1e2f8">${img(id,48,48)}</td><td width="35%" style="font-size:16px;color:#394d78;border-bottom:1px solid #d1e2f8">${label}</td><td style="font-size:17px;font-weight:bold;color:#071e59;border-bottom:1px solid #d1e2f8">${value}</td></tr>`;
  const links=socials.map(([id,url])=>`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${id}" style="display:inline-block;vertical-align:middle;margin-left:4px;text-decoration:none">${img(id,36,36,id)}</a>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:12px 8px;background:#edf6ff;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:640px;margin:auto;background:#ffffff;border-radius:15px;overflow:hidden">
<tr><td style="padding:22px 26px 13px">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
<td width="65%" style="vertical-align:middle;padding-right:18px"><img src="${logo}" width="390" alt="Guruvidya – REAL EDUCATION • REAL RESULTS" style="display:block;border:0;width:100%;max-width:390px;height:auto"></td>
<td width="35%" align="right" style="vertical-align:middle;border-left:1px solid #b9d5f9;padding-left:16px">${img('header-alert',168,72,'Internal Appointment Alert')}</td>
</tr></table></td></tr>
<tr><td style="padding:0 26px">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#e8f8ef;border-left:7px solid #09ba60;border-radius:12px">
<tr><td width="110" style="padding:14px 10px 14px 16px;vertical-align:middle">${img('whatsapp-circle',76,76,'WhatsApp')}</td>
<td style="padding:17px 9px;vertical-align:middle"><div style="font-size:21px;line-height:1.3;font-weight:800;color:#08252b">WhatsApp 24-Hour Window Reminder</div>
<div style="padding-top:10px"><span style="display:inline-block;background:#008d53;color:#ffffff;border-radius:28px;padding:9px 19px;font-size:17px;font-weight:bold">Reminder ${Number(number)} of ${Number(total)}</span></div></td></tr></table>
<h2 style="margin:20px 0 5px;color:#111111;font-size:23px;font-weight:800">Dear ${recipient},</h2>
<p style="margin:0 0 17px;color:#354777;font-size:16px;line-height:1.55">This is an automated reminder regarding the WhatsApp service window for the student. Please take the necessary action.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #b5d8ff;border-radius:12px;border-spacing:0">
${row('recipient','Recipient',recipient)}
${row('channel','Channel','Email')}
${row('clock','Window Remaining',`<span style="display:inline-block;background:#e4f3ff;border-radius:15px;padding:5px 12px 5px 5px;white-space:nowrap;vertical-align:middle"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td>${img('timer-clock',34,34)}</td><td style="font-size:19px;font-weight:bold;color:#092363;padding-left:6px">${time}</td></tr></table></span>`)}
</table>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:19px"><tr><td align="center" bgcolor="#009f59" style="border-radius:10px;background:#009f59">
<a href="${esc(acknowledgementUrl)}" target="_blank" rel="noopener noreferrer" style="display:block;padding:17px 8px;color:#ffffff;font-size:22px;line-height:1.35;font-weight:bold;text-decoration:none"><span style="display:inline-block;vertical-align:middle;width:36px;height:36px;line-height:36px;text-align:center;border-radius:50%;background:#ffffff;color:#008c51;font-size:27px;margin-right:12px">✓</span>Acknowledge Receipt &nbsp;❯</a></td></tr></table>
<p style="text-align:center;margin:10px 0 16px;color:#3c4e79;font-size:14px">Click to confirm that you have received and reviewed this email.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e3f3ff;border-radius:11px"><tr>
<td width="57" style="padding:15px 8px 15px 16px">${img('info',38,38,'Information')}</td>
<td style="padding:15px 14px 15px 0;color:#0874ed;font-size:16px;line-height:1.5">Your acknowledgement helps us keep our records updated and ensures timely follow-up.</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:19px;border-top:1px solid #a8d3fc;text-align:center"><tr>
<td width="33%" align="center" style="padding:11px 5px;color:#08245d;font-size:14px;font-weight:bold;line-height:1.3">${img('target',60,60,'Timely Follow-up')}<div style="padding-top:5px">Timely<br>Follow-up</div></td>
<td width="34%" align="center" style="padding:11px 5px;color:#08245d;font-size:14px;font-weight:bold;line-height:1.3">${img('people',60,60,'Better Student Support')}<div style="padding-top:5px">Better<br>Student Support</div></td>
<td width="33%" align="center" style="padding:11px 5px;color:#08245d;font-size:14px;font-weight:bold;line-height:1.3">${img('bars',60,60,'Stay Organized')}<div style="padding-top:5px">Stay<br>Organized</div></td>
</tr></table></td></tr>
<tr><td style="padding:0"><img src="${art('footer-waves')}" alt="" width="640" style="display:block;width:100%;height:auto;border:0"></td></tr>
<tr><td bgcolor="#052e68" style="background:#052e68;padding:12px 25px 18px">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
<td width="59%" style="vertical-align:middle"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="vertical-align:middle;padding-right:8px"><img src="${gIcon}" width="70" alt="Original Guruvidya G" style="display:block;border:0;width:70px;height:auto"></td>
<td style="vertical-align:middle"><div style="color:#ffffff;font-size:16px;font-weight:bold;line-height:1.3">Guruvidya Academy Pvt. Ltd.</div><div style="color:#ff444c;font-size:11px;font-weight:bold;line-height:1.4">REAL EDUCATION • REAL RESULTS</div></td>
</tr></table></td>
<td align="right" style="vertical-align:middle;border-left:1px solid #8ca8cc">${links}<div style="padding-top:8px"><a href="https://www.guruvidya.in" target="_blank" rel="noopener noreferrer" style="color:#ffffff;text-decoration:none;font-size:13px">www.guruvidya.in</a></div></td>
</tr></table></td></tr></table></body></html>`;
}

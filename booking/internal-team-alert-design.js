// Internal team appointment artwork only. Never used by student/parent notifications.
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';

const titles={confirmed:'New Appointment Confirmed!',rescheduled:'Appointment Rescheduled!',cancelled:'Appointment Cancelled!'};
const colors={confirmed:['#0056bd','#e9f5ff'],rescheduled:['#ed6800','#fff5e9'],cancelled:['#d80b2a','#fff0f2']};
const socials=[['f','https://www.facebook.com/guruvidyaacademypvtltd'],['◎','https://www.instagram.com/guruvidyaca/'],['▶','https://www.youtube.com/c/GuruvidyaIn'],['in','https://www.linkedin.com/in/guruvidya-academy-pvt-ltd'],['X','https://x.com/guruvidya_']];
const esc=v=>String(v??'—').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const phone=v=>{const digits=String(v||'').replace(/\D/g,'').slice(-10);return digits.length===10?`+91-${digits}`:'—';};
const format=(value,opts={})=>value?new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',day:'2-digit',month:'short',year:'numeric',...opts}).format(new Date(value)):'—';
const time=value=>format(value,{hour:'numeric',minute:'2-digit',hour12:true})+' (IST)';
export const internalActor=(booking,event,history)=>{
  if(event==='confirmed')return String(booking.booked_by||'Student').toLowerCase().includes('parent')?'Parent':'Student';
  if(event==='cancelled'&&booking.cancelled_by)return /parent|guardian/i.test(booking.cancelled_by)?'Parent':/student/i.test(booking.cancelled_by)?'Student':/admin/i.test(booking.cancelled_by)?'Admin':'Unknown';
  const actor=String(history?.actor||'').toLowerCase();
  if(actor.includes('admin'))return 'Admin';
  const named=String(history?.details?.rescheduled_by||history?.details?.cancelled_by||'');
  if(named)return named.toLowerCase().includes('parent')?'Parent':named.toLowerCase().includes('student')?'Student':named;
  // Legacy customer reschedules did not record Student vs Parent.
  // Show the known actor class without inventing an individual identity.
  if(actor.includes('customer'))return 'Student / Parent';
  return 'Not recorded';
};
export const internalCaption=(event,actor)=>`${{confirmed:'Booked',rescheduled:'Rescheduled',cancelled:'Cancelled'}[event]}${actor&&actor!=='Unknown'?' by '+actor:''}`;
export function internalAlertRows(b,event,history){
  const rows=[['Booking Reference',b.booking_ref],['Student Name',b.student_name],['Parent / Guardian',[b.parent_name,b.parent_relation&&`(${b.parent_relation})`].filter(Boolean).join(' ')],['Student WhatsApp',phone(b.student_mobile)],['Parent WhatsApp',phone(b.parent_mobile)],['Email',b.student_email||b.parent_email],['Course',b.course],['Mode',b.mode==='online'?'Online (Live Counselling)':`Offline (${b.offline_location_name||'Branch'})`]];
  if(event==='rescheduled')rows.push(['Previous Date & Time',history?.details?.previous_starts_at||history?.details?.old_starts_at?time(history.details.previous_starts_at||history.details.old_starts_at):'Not recorded'],['New Date & Time',time(b.starts_at)]);
  else rows.push(['Date',format(b.starts_at,{weekday:'long',day:'2-digit',month:'long',year:'numeric'})],['Time (IST)',time(b.starts_at)]);
  rows.push(['Counsellor',b.counsellor_name]);
  if(b.mode==='offline')rows.push(['Location',[b.offline_location_name,b.offline_address].filter(Boolean).join(' — ')]);
  const actor=internalActor(b,event,history);
  rows.push([event==='confirmed'?'Booked By':event==='rescheduled'?'Rescheduled By':'Cancelled By',actor]);
  rows.push([event==='confirmed'?'Booking Created At':event==='rescheduled'?'Rescheduled At':'Cancelled At',time(event==='confirmed'?b.created_at:event==='cancelled'?(b.cancelled_at||history?.created_at):history?.created_at)]);
  if(event==='cancelled')rows.push(['Cancellation Reason',b.cancellation_reason||'Not specified']);
  return rows;
}
export function internalAlertHtml(b,event,history,crmUrl,meetingUrl,baseUrl){
  const [primary,tint]=colors[event],rows=internalAlertRows(b,event,history);
  const hero=`${baseUrl}/api/public/booking/internal-team-alert/header/${event}.png`;
  const icons={
    'Booking Reference':'document-blue','Student Name':'user-blue','Parent / Guardian':'users-blue',
    'Student WhatsApp':'whatsapp-green','Parent WhatsApp':'whatsapp-green','Email':'mail-blue',
    'Course':'course-blue','Mode':b.mode==='online'?'video-blue':'pin-blue',
    'Date':'calendar-blue','Time (IST)':'calendar-blue','Counsellor':'user-blue',
    'Location':'pin-blue','Booked By':'user-blue','Booking Created At':'info-blue',
    'Rescheduled By':'user-blue','Rescheduled At':'info-blue','Cancelled By':'user-blue',
    'Cancelled At':'info-blue','Previous Date & Time':'calendar-blue','New Date & Time':'calendar-blue',
    'Cancellation Reason':'info-blue'
  };
  const icon=(name)=>`<img src="${esc(baseUrl)}/api/public/booking/email-icon/${name}.png" width="22" height="22" alt="" style="display:block;width:22px;height:22px;border:0">`;
  const rowHtml=rows.map(([k,v])=>{
    const special=k==='Previous Date & Time'?'#fff0f0':k==='New Date & Time'?'#edfff0':k==='Cancellation Reason'?'#ffebed':'';
    const valueColor=k==='Previous Date & Time'||k==='Cancellation Reason'?'#bd2934':k==='New Date & Time'?'#188b55':'#113f87';
    const modeBadge=k==='Mode';const modeOnline=b.mode==='online';const displayValue=modeBadge?`<span style="display:inline-block;background:${modeOnline?'#0868ed':'#f36b19'};color:#fff;border-radius:8px;padding:7px 10px;font-weight:700"><img src="${esc(baseUrl)}/api/public/booking/email-icon/${modeOnline?'video-white':'pin-white'}.png" width="15" height="15" alt="" style="vertical-align:middle;margin-right:5px">${esc(v)}</span>`:esc(v);return `<tr style="background:${special||'#fff'}"><td width="30" valign="top" style="padding:9px 2px 9px 8px;border-bottom:1px solid #e0e9f3">${(k==='Previous Date & Time'||k==='New Date & Time'||k==='Cancellation Reason')?icon(icons[k]||'info-blue').replace('style="display:block;',`style="filter:${k==='New Date & Time'?'sepia(1) saturate(5) hue-rotate(80deg)':'sepia(1) saturate(8) hue-rotate(315deg)'};display:block;`):icon(icons[k]||'info-blue')}</td><td valign="top" style="padding:10px 5px;border-bottom:1px solid #e0e9f3;color:${valueColor};font-weight:700;width:39%;font-size:12px">${esc(k)}</td><td valign="top" style="padding:10px 7px;border-bottom:1px solid #e0e9f3;color:${valueColor};overflow-wrap:anywhere;font-size:12px">${displayValue}</td></tr>`;
  }).join('');
  const meetingIcon=`<img src="${esc(baseUrl)}/api/public/booking/email-icon/video-white.png" width="21" height="21" alt="" style="display:inline-block;width:21px;height:21px;border:0;vertical-align:middle">`;
  const button=(label,url,bg,iconName,width)=>`<td width="${width}" style="padding:4px"><a href="${esc(url)}" style="display:block;text-align:center;padding:15px 5px;background:${bg};color:#ffffff;text-decoration:none;border-radius:9px;font-weight:700;font-size:14px;white-space:nowrap"><span style="color:#fff;font-size:19px;vertical-align:middle">${iconName}</span>&nbsp; ${esc(label)} &nbsp;›</a></td>`;
  const join=(event!=='cancelled'&&b.mode==='online'&&meetingUrl);
  const links=`<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;table-layout:fixed"><tr>${join?button('Join Online Meeting',meetingUrl,'#0868ed',meetingIcon,'50%'):''}${crmUrl?button('View in CRM',crmUrl,event==='rescheduled'?'#dc922f':event==='cancelled'?'#d73333':'#079847','↗',join?'50%':'100%'):''}</tr></table>`;
  const detailColor=event==='confirmed'?'#06358b':'#b72a25';
  const detailIcon=event==='confirmed'?'#06358b':'#b72a25';
  const social=socials.map(([label,url],i)=>`<a href="${esc(url)}" style="display:inline-block;vertical-align:middle;margin-left:5px"><img src="${esc(baseUrl)}/api/public/internal-reminder/art/${['facebook','instagram','youtube','linkedin','x'][i]}" width="26" height="26" alt="${esc(label)}" style="display:block;border:0"></a>`).join('');
  const wave=`${baseUrl}/api/public/booking/internal-team-alert/footer-wave.png`;
  return `<!doctype html><html><body style="margin:0;background:#f1f5fb;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center"><table role="presentation" width="560" style="width:560px;max-width:100%;background:#fff;border-radius:14px;overflow:hidden" cellspacing="0" cellpadding="0"><tr><td><img src="${esc(hero)}" alt="GuruVidya Internal Team Alert: ${esc(titles[event])}" style="display:block;width:100%;height:auto;border:0"></td></tr><tr><td style="padding:12px 16px 0"><div style="border:2px solid #0b69bd;border-radius:15px;padding:10px;background:#fff"><div style="background:${tint};color:${detailColor};padding:12px;font-size:18px;font-weight:700;border-radius:9px"><span style="display:inline-block;background:${detailIcon};padding:7px;border-radius:6px;margin-right:10px;vertical-align:middle"><img src="${esc(baseUrl)}/api/public/booking/email-icon/calendar-white.png" width="23" height="23" alt="" style="display:block"></span> Appointment Details</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse">${rowHtml}</table><div style="text-align:center;padding:14px 0 0">${links}</div></div></td></tr><tr><td style="padding:0"><img src="${esc(wave)}" width="560" alt="" style="display:block;width:100%;height:auto;border:0"></td></tr><tr><td style="background:#052762;color:#fff;padding:5px 14px 18px"><table role="presentation" width="100%"><tr><td valign="middle" style="font-size:16px;font-weight:700"><img src="${esc(baseUrl)}/api/public/internal-reminder/g-icon" width="46" alt="GuruVidya" style="vertical-align:middle;margin-right:5px;border:0"><span style="display:inline-block;vertical-align:middle"><span style="display:block">Guruvidya Academy Pvt. Ltd.</span><span style="display:block;color:#ff4b53;font-size:10px;line-height:12px;margin-top:5px;text-align:center;letter-spacing:.1px">REAL EDUCATION • REAL RESULTS</span></span></td><td valign="middle" align="right"><div style="display:inline-block;text-align:center">${social}<div style="font-size:11px;margin-top:8px;text-align:center"><a href="https://www.guruvidya.in" style="color:#fff;text-decoration:none">www.guruvidya.in</a></div></div></td></tr></table></td></tr></table></td></tr></table></body></html>`;
}
export async function internalAlertPng(b,event,history){
  const rows=internalAlertRows(b,event,history),[primary,tint]=colors[event];
  const head=await readFile(new URL(`./internal-team-alert-assets/${event}-header.png`,import.meta.url));
  const width=900,headerHeight=510,rowHeight=62,contentHeight=135+rows.length*rowHeight,total=headerHeight+contentHeight;
  const text=(value,x,y,size=24,bold=false,color='#113f87')=>`<text x="${x}" y="${y}" font-family="Arial,sans-serif" font-size="${size}" font-weight="${bold?'700':'400'}" fill="${color}">${esc(String(value??'—').slice(0,bold?26:65))}</text>`;
  const wrap=(v,x,y)=>{const str=String(v??'—');const chunks=str.match(/.{1,44}(?:\s|$)|.{1,44}/g)||['—'];return chunks.slice(0,2).map((s,i)=>text(s.trim(),x,y+i*23,19,false)).join('')};
  const iconNames={
    'Booking Reference':'document-blue','Student Name':'user-blue','Parent / Guardian':'users-blue',
    'Student WhatsApp':'whatsapp-green','Parent WhatsApp':'whatsapp-green','Email':'mail-blue',
    'Course':'course-blue','Mode':b.mode==='online'?'video-white':'pin-white',
    'Date':'calendar-blue','Time (IST)':'clock-blue','Counsellor':'user-blue',
    'Location':'pin-blue','Booked By':'user-blue','Booking Created At':'document-blue',
    'Rescheduled By':'user-blue','Rescheduled At':'document-blue','Cancelled By':'user-blue',
    'Cancelled At':'document-blue','Previous Date & Time':'calendar-blue','New Date & Time':'calendar-blue',
    'Cancellation Reason':'info-blue'
  };
  const iconCache={};
  for(const name of new Set(Object.values(iconNames))){
    try{iconCache[name]=(await readFile(new URL(`./email-icons/${name}.png`,import.meta.url))).toString('base64')}catch{}
  }
  for(const [name,target] of [['calendar-red','#c62828'],['calendar-green','#188b55'],['info-red','#c62828']]){const src=name.startsWith('info')?'info-blue':'calendar-blue';if(iconCache[src]){const buf=Buffer.from(iconCache[src],'base64');iconCache[name]=(await sharp(buf).ensureAlpha().tint(target).png().toBuffer()).toString('base64')}}
  // Preserve the original deep-blue location pin on the Mode label.
  const modeLabelIconData=await readFile(new URL('./email-icons/pin-blue.png',import.meta.url)).then(b=>b.toString('base64'));
  const modeBadgeIconData=iconCache[b.mode==='online'?'video-white':'pin-white'];
  const rowSvg=rows.map(([k,v],i)=>{const y=115+i*rowHeight;
    const special=k==='Previous Date & Time'?'#fff0f0':k==='New Date & Time'?'#eaffef':k==='Cancellation Reason'?'#ffeded':null;
    const color=k==='Previous Date & Time'||k==='Cancellation Reason'?'#bd2934':k==='New Date & Time'?'#188b55':'#06367c';
    const isMode=k==='Mode';
    const iconName=k==='Previous Date & Time'?'calendar-red':k==='New Date & Time'?'calendar-green':k==='Cancellation Reason'?'info-red':iconNames[k];
    const iconData=iconCache[iconName];
    const iconMarkup=iconData?`<image x="52" y="${y-29}" width="29" height="29" href="data:image/png;base64,${iconData}"/>`:text('●',52,y-5,24,true,color);
    const val=String(v??'—');
    const modeTextSize=val.length>35?15:18;
    const modeBadgeWidth=Math.min(445,Math.max(260,Math.ceil(val.length*modeTextSize*.58+62)));
    // Do not use the generic bold text helper here: it truncates at 26 characters.
    // SVG textLength ensures even long branch names stay within the orange badge.
    const modeTextWidth=modeBadgeWidth-54;
    const modeText=`<text x="454" y="${y-10}" font-family="Arial,sans-serif" font-size="${modeTextSize}" font-weight="700" fill="#ffffff" textLength="${Math.min(modeTextWidth,Math.ceil(val.length*modeTextSize*.56))}" lengthAdjust="spacingAndGlyphs">${esc(val)}</text>`;
    const modeValue=isMode?`<rect x="409" y="${y-38}" width="${modeBadgeWidth}" height="43" rx="13" fill="${b.mode==='online'?'#0868ed':'#f36b19'}"/>${modeBadgeIconData?`<image x="420" y="${y-29}" width="25" height="25" href="data:image/png;base64,${modeBadgeIconData}"/>`:''}${modeText}`:((k==='Previous Date & Time'||k==='New Date & Time'||k==='Cancellation Reason')?wrap(v,409,y-5).replace(/fill="#113f87"/g,`fill="${color}"`):wrap(v,409,y-5));
    return `${special?`<rect x="42" y="${y-39}" width="816" height="55" rx="9" fill="${special}"/>`:''}<line x1="45" x2="855" y1="${y+19}" y2="${y+19}" stroke="#d8e6f2"/>${isMode?`<image x="52" y="${y-29}" width="29" height="29" href="data:image/png;base64,${modeLabelIconData}"/>`:iconMarkup}${text(k,97,y-5,19,true,color)}${text(':',380,y-5,20,true,color)}${modeValue}`;
  }).join('');
  const detailColor=event==='confirmed'?'#06358b':'#b72a25';
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${contentHeight}"><rect width="900" height="${contentHeight}" fill="white"/><rect x="25" y="18" width="850" height="${contentHeight-35}" rx="22" fill="#f9fcff" stroke="#0b69bd" stroke-width="3"/><rect x="42" y="30" width="816" height="52" rx="12" fill="${tint}"/><rect x="53" y="39" width="38" height="36" rx="6" fill="${detailColor}"/><g stroke="#ffffff" fill="none" stroke-width="3" stroke-linecap="round"><rect x="60" y="46" width="25" height="23" rx="3"/><path d="M60 53h25M67 42v8M78 42v8M67 60h3M76 60h3"/></g>${text('Appointment Details',109,65,29,true,detailColor)}${rowSvg}</svg>`;
  return sharp({create:{width,height:total,channels:4,background:'#fff'}}).composite([{input:await sharp(head).resize({width,height:headerHeight,fit:'fill'}).toBuffer(),top:0,left:0},{input:Buffer.from(svg),top:headerHeight,left:0}]).png().toBuffer();
}

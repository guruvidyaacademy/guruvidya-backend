// Internal team appointment artwork only. Never used by student/parent notifications.
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';

const titles={confirmed:'New Appointment Confirmed!',rescheduled:'Appointment Rescheduled!',cancelled:'Appointment Cancelled!'};
const colors={confirmed:['#0056bd','#e9f5ff'],rescheduled:['#ed6800','#fff5e9'],cancelled:['#d80b2a','#fff0f2']};
const socials=[['f','https://www.facebook.com/guruvidyaacademypvtltd'],['◎','https://www.instagram.com/guruvidyaca/'],['▶','https://www.youtube.com/c/GuruvidyaIn'],['in','https://www.linkedin.com/in/guruvidya-academy-pvt-ltd'],['X','https://x.com/guruvidya_']];
const esc=v=>String(v??'—').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const format=(value,opts={})=>value?new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',day:'2-digit',month:'short',year:'numeric',...opts}).format(new Date(value)):'—';
const time=value=>format(value,{hour:'numeric',minute:'2-digit',hour12:true})+' (IST)';
export const internalActor=(booking,event,history)=>{
  if(event==='confirmed')return String(booking.booked_by||'Student').toLowerCase().includes('parent')?'Parent':'Student';
  if(event==='cancelled'&&booking.cancelled_by)return /parent|guardian/i.test(booking.cancelled_by)?'Parent':/student/i.test(booking.cancelled_by)?'Student':/admin/i.test(booking.cancelled_by)?'Admin':'Unknown';
  const actor=String(history?.actor||'').toLowerCase();
  if(actor.includes('admin'))return 'Admin';
  const named=String(history?.details?.rescheduled_by||history?.details?.cancelled_by||'');
  if(named)return named.toLowerCase().includes('parent')?'Parent':named.toLowerCase().includes('student')?'Student':named;
  // Customer reschedule does not currently persist the actor identity: do not guess.
  return 'Unknown';
};
export const internalCaption=(event,actor)=>`${{confirmed:'Booked',rescheduled:'Rescheduled',cancelled:'Cancelled'}[event]}${actor&&actor!=='Unknown'?' by '+actor:''}`;
export function internalAlertRows(b,event,history){
  const rows=[['Booking Reference',b.booking_ref],['Student Name',b.student_name],['Parent / Guardian',[b.parent_name,b.parent_relation&&`(${b.parent_relation})`].filter(Boolean).join(' ')],['Student WhatsApp',b.student_mobile],['Parent WhatsApp',b.parent_mobile],['Email',b.student_email||b.parent_email],['Course',b.course],['Mode',b.mode==='online'?'Online (Live Counselling)':`Offline (${b.offline_location_name||'Branch'})`]];
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
    'Booking Reference':'info-blue','Student Name':'user-blue','Parent / Guardian':'users-blue',
    'Student WhatsApp':'whatsapp-green','Parent WhatsApp':'whatsapp-green','Email':'mail-blue',
    'Course':'course-blue','Mode':b.mode==='online'?'video-blue':'pin-blue',
    'Date':'calendar-blue','Time (IST)':'calendar-blue','Counsellor':'user-blue',
    'Location':'pin-blue','Booked By':'user-blue','Booking Created At':'info-blue',
    'Rescheduled By':'user-blue','Rescheduled At':'info-blue','Cancelled By':'user-blue',
    'Cancelled At':'info-blue','Previous Date & Time':'calendar-red','New Date & Time':'calendar-green',
    'Cancellation Reason':'info-red'
  };
  const icon=(name)=>`<img src="${esc(baseUrl)}/api/public/booking/email-icon/${name}.png" width="22" height="22" alt="" style="display:block;width:22px;height:22px;border:0">`;
  const rowHtml=rows.map(([k,v])=>{
    const special=k==='Previous Date & Time'?'#fff0f0':k==='New Date & Time'?'#edfff0':k==='Cancellation Reason'?'#ffebed':'';
    const valueColor=k==='Previous Date & Time'||k==='Cancellation Reason'?'#c71724':k==='New Date & Time'?'#078b37':'#113f87';
    return `<tr style="background:${special||'#fff'}"><td width="30" valign="top" style="padding:9px 2px 9px 8px;border-bottom:1px solid #e0e9f3">${icon(icons[k]||'info-blue')}</td><td valign="top" style="padding:10px 5px;border-bottom:1px solid #e0e9f3;color:${valueColor};font-weight:700;width:39%;font-size:12px">${esc(k)}</td><td valign="top" style="padding:10px 7px;border-bottom:1px solid #e0e9f3;color:${valueColor};overflow-wrap:anywhere;font-size:12px">${esc(v)}</td></tr>`;
  }).join('');
  // Full-width table-aligned CTA: one button for offline/cancelled, two equal columns for online active appointments.
  const button=(label,url,bg,iconName)=>`<a href="${esc(url)}" style="display:block;box-sizing:border-box;width:100%;text-align:center;padding:16px 5px;background:${bg};color:#fff;text-decoration:none;border-radius:9px;font-weight:700;font-size:14px">${iconName} ${esc(label)} ›</a>`;
  const hasJoin=event!=='cancelled'&&b.mode==='online'&&Boolean(meetingUrl);
  const links=hasJoin&&crmUrl
    ?`<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td width="50%" style="padding-right:5px">${button('Join Online Meeting',meetingUrl,'#0868ed','▣')}</td><td width="50%" style="padding-left:5px">${button('View in CRM',crmUrl,'#079847','↗')}</td></tr></table>`
    :hasJoin?button('Join Online Meeting',meetingUrl,'#0868ed','▣')
    :crmUrl?button('View in CRM',crmUrl,'#079847','↗'):'';
  const social=socials.map(([label,url],i)=>`<a href="${esc(url)}" style="display:inline-block;vertical-align:middle;margin-left:5px"><img src="${esc(baseUrl)}/api/public/internal-reminder/art/${['facebook','instagram','youtube','linkedin','x'][i]}" width="26" height="26" alt="${esc(label)}" style="display:block;border:0"></a>`).join('');
  const wave=`${baseUrl}/api/public/booking/internal-team-alert/footer-wave.png`;
  return `<!doctype html><html><body style="margin:0;background:#f1f5fb;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center"><table role="presentation" width="560" style="width:560px;max-width:100%;background:#fff;border-radius:14px;overflow:hidden" cellspacing="0" cellpadding="0"><tr><td><img src="${esc(hero)}" alt="GuruVidya Internal Team Alert: ${esc(titles[event])}" style="display:block;width:100%;height:auto;border:0"></td></tr><tr><td style="padding:12px 16px 0"><div style="background:${tint};color:${primary};padding:12px;font-size:18px;font-weight:700;border-radius:9px">▦ &nbsp; Appointment Details</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse">${rowHtml}</table><div style="width:100%;padding:17px 0">${links}</div></td></tr><tr><td style="padding:0"><img src="${esc(wave)}" width="560" alt="" style="display:block;width:100%;height:auto;border:0"></td></tr><tr><td style="background:#052762;color:#fff;padding:5px 14px 18px"><table role="presentation" width="100%"><tr><td valign="middle" style="font-size:13px;font-weight:700;white-space:nowrap"><img src="${esc(baseUrl)}/api/public/internal-reminder/g-icon" width="46" alt="GuruVidya" style="vertical-align:middle;margin-right:5px;border:0">GuruVidya Academy Pvt. Ltd.<div style="color:#ff4b53;font-size:9px;margin-top:0;margin-left:52px;font-weight:700;white-space:nowrap">REAL EDUCATION • REAL RESULTS</div></td><td valign="middle" align="right">${social}<div style="font-size:11px;margin-top:8px"><a href="https://www.guruvidya.in" style="color:#fff;text-decoration:none">www.guruvidya.in</a></div></td></tr></table></td></tr></table></td></tr></table></body></html>`;
}
export async function internalAlertPng(b,event,history){
  const rows=internalAlertRows(b,event,history),[primary,tint]=colors[event];
  const head=await readFile(new URL(`./internal-team-alert-assets/${event}-header.png`,import.meta.url));
  const width=900,headerHeight=510,rowHeight=62,contentHeight=135+rows.length*rowHeight,total=headerHeight+contentHeight;
  const text=(value,x,y,size=24,bold=false,color='#113f87')=>`<text x="${x}" y="${y}" font-family="Arial,sans-serif" font-size="${size}" font-weight="${bold?'700':'400'}" fill="${color}">${esc(String(value??'—').slice(0,bold?26:65))}</text>`;
  const wrap=(v,x,y)=>{const str=String(v??'—');const chunks=str.match(/.{1,44}(?:\s|$)|.{1,44}/g)||['—'];return chunks.slice(0,2).map((s,i)=>text(s.trim(),x,y+i*23,19,false)).join('')};
  // Use the same approved PNG icon artwork as the email templates, not placeholder glyphs.
  const iconNames={
    'Booking Reference':'document-blue','Student Name':'user-blue','Parent / Guardian':'user-blue',
    'Student WhatsApp':'whatsapp-green','Parent WhatsApp':'whatsapp-green','Email':'mail-blue',
    'Course':'course-blue','Mode':b.mode==='online'?'video-blue':'pin-blue',
    'Date':'calendar-blue','Time (IST)':'clock-blue','Counsellor':'user-blue',
    'Location':'pin-blue','Booked By':'user-blue','Booking Created At':'document-blue',
    'Rescheduled By':'user-blue','Rescheduled At':'document-blue','Cancelled By':'user-blue',
    'Cancelled At':'document-blue','Previous Date & Time':'calendar-red',
    'New Date & Time':'calendar-green','Cancellation Reason':'info-red'
  };
  const iconLayers=[];
  for(let i=0;i<rows.length;i++){
    const iconName=iconNames[rows[i][0]]||'document-blue';
    const data=await readFile(new URL(`./email-icons/${iconName}.png`,import.meta.url));
    iconLayers.push({input:await sharp(data).resize(31,31,{fit:'contain'}).png().toBuffer(),left:headerHeight?55:55,top:headerHeight+115+i*rowHeight-33});
  }
  const rowSvg=rows.map(([k,v],i)=>{const y=115+i*rowHeight;
    const special=k==='Previous Date & Time'?'#fff0f0':k==='New Date & Time'?'#eaffef':k==='Cancellation Reason'?'#ffeded':null;
    const color=k==='Previous Date & Time'||k==='Cancellation Reason'?'#cc1727':k==='New Date & Time'?'#058f40':'#06367c';
    return `${special?`<rect x="42" y="${y-39}" width="816" height="55" rx="9" fill="${special}"/>`:''}<line x1="45" x2="855" y1="${y+19}" y2="${y+19}" stroke="#d8e6f2"/>${text(k,97,y-5,19,true,color)}${text(':',380,y-5,20,true,color)}${wrap(v,409,y-5)}`;
  }).join('');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${contentHeight}"><rect width="900" height="${contentHeight}" fill="white"/><rect x="25" y="18" width="850" height="${contentHeight-35}" rx="22" fill="#f9fcff" stroke="#dce8f2"/><rect x="42" y="30" width="816" height="52" rx="12" fill="${tint}"/>${text('Appointment Details',106,65,29,true,primary)}${rowSvg}</svg>`;
  const sectionIcon=await readFile(new URL('./email-icons/calendar-white.png',import.meta.url));
  const sectionLayer={input:await sharp(sectionIcon).resize(34,34,{fit:'contain'}).png().toBuffer(),top:headerHeight+38,left:60};
  return sharp({create:{width,height:total,channels:4,background:'#fff'}}).composite([{input:await sharp(head).resize({width,height:headerHeight,fit:'fill'}).toBuffer(),top:0,left:0},{input:Buffer.from(svg),top:headerHeight,left:0},sectionLayer,...iconLayers]).png().toBuffer();
}

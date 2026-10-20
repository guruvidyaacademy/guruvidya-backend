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
  if(event==='cancelled'&&booking.cancelled_by)return String(booking.cancelled_by).replace(/\s*\/\s*Guardian/i,'');
  const actor=String(history?.actor||'').toLowerCase();
  if(actor.includes('admin'))return 'Admin';
  const named=String(history?.details?.rescheduled_by||history?.details?.cancelled_by||'');
  if(named)return named.toLowerCase().includes('parent')?'Parent':named.toLowerCase().includes('student')?'Student':named;
  // Customer reschedule does not currently persist the actor identity: do not guess.
  return actor==='customer'?'Student/Parent':'Unknown';
};
export const internalCaption=(event,actor)=>`${{confirmed:'Booked',rescheduled:'Rescheduled',cancelled:'Cancelled'}[event]} by ${actor}`;
export function internalAlertRows(b,event,history){
  const rows=[['Booking Reference',b.booking_ref],['Student Name',b.student_name],['Parent / Guardian',[b.parent_name,b.parent_relation&&`(${b.parent_relation})`].filter(Boolean).join(' ')],['Student WhatsApp',b.student_mobile],['Parent WhatsApp',b.parent_mobile],['Email',b.student_email||b.parent_email],['Course',b.course],['Mode',b.mode==='online'?'Online (Live Counselling)':`Offline (${b.offline_location_name||'Branch'})`]];
  if(event==='rescheduled')rows.push(['Previous Date & Time',history?.details?.previous_starts_at||history?.details?.old_starts_at?time(history.details.previous_starts_at||history.details.old_starts_at):'Not recorded'],['New Date & Time',time(b.starts_at)]);
  else rows.push(['Date',format(b.starts_at,{weekday:'long'})],['Time (IST)',time(b.starts_at)]);
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
  const rowHtml=rows.map(([k,v],i)=>`<tr><td style="padding:9px 12px;border-bottom:1px solid #e0e9f3;color:#06367c;font-weight:700;width:43%;vertical-align:top">${esc(k)}</td><td style="padding:9px 12px;border-bottom:1px solid #e0e9f3;color:#113f87;overflow-wrap:anywhere;vertical-align:top">${esc(v)}</td></tr>`).join('');
  const button=(label,url,bg)=>`<a href="${esc(url)}" style="display:inline-block;padding:13px 17px;background:${bg};color:white;text-decoration:none;border-radius:9px;font-weight:700;margin:5px">${esc(label)} ↗</a>`;
  const links=(event!=='cancelled'&&b.mode==='online'&&meetingUrl?button('Join Online Meeting',meetingUrl,'#0769ec'):'')+(crmUrl?button('View in CRM',crmUrl,'#079847'):'');
  const social=socials.map(([label,url],i)=>`<a href="${esc(url)}" style="display:inline-block;vertical-align:middle;margin-left:4px"><img src="${esc(baseUrl)}/api/public/internal-reminder/art/${['facebook','instagram','youtube','linkedin','x'][i]}" width="27" height="27" alt="${esc(label)}" style="display:block;border:0"></a>`).join('');
  return `<!doctype html><html><body style="margin:0;background:#f1f5fb;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center"><table role="presentation" width="560" style="max-width:100%;background:#fff;border-radius:14px;overflow:hidden" cellspacing="0" cellpadding="0"><tr><td><img src="${esc(hero)}" alt="GuruVidya Internal Team Alert: ${esc(titles[event])}" style="display:block;width:100%;height:auto;border:0"></td></tr><tr><td style="padding:14px 20px 5px"><div style="background:${tint};color:${primary};padding:13px;font-size:19px;font-weight:700;border-radius:9px">▦ &nbsp; Appointment Details</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:13px;border-collapse:collapse">${rowHtml}</table><div style="text-align:center;padding:20px 0">${links}</div></td></tr><tr><td style="background:#052762;color:#fff;padding:18px 16px"><table role="presentation" width="100%"><tr><td style="font-size:14px;font-weight:700"><img src="${esc(baseUrl)}/api/public/internal-reminder/g-icon" width="52" alt="GuruVidya" style="vertical-align:middle;margin-right:6px;border:0">GuruVidya Academy Pvt. Ltd.<div style="color:#ff4b53;font-size:10px;margin-top:5px">REAL EDUCATION • REAL RESULTS</div></td><td align="right">${social}<div style="font-size:12px;margin-top:8px"><a href="https://www.guruvidya.in" style="color:#fff;text-decoration:none">www.guruvidya.in</a></div></td></tr></table></td></tr></table></td></tr></table></body></html>`;
}
export async function internalAlertPng(b,event,history){
  const rows=internalAlertRows(b,event,history),[primary,tint]=colors[event];
  const head=await readFile(new URL(`./internal-team-alert-assets/${event}-header.png`,import.meta.url));
  const width=900,headerHeight=510,rowHeight=62,contentHeight=135+rows.length*rowHeight,total=headerHeight+contentHeight;
  const text=(value,x,y,size=24,bold=false,color='#113f87')=>`<text x="${x}" y="${y}" font-family="Arial,sans-serif" font-size="${size}" font-weight="${bold?'700':'400'}" fill="${color}">${esc(String(value??'—').slice(0,bold?26:65))}</text>`;
  const wrap=(v,x,y)=>{const str=String(v??'—');const chunks=str.match(/.{1,44}(?:\s|$)|.{1,44}/g)||['—'];return chunks.slice(0,2).map((s,i)=>text(s.trim(),x,y+i*23,19,false)).join('')};
  const rowSvg=rows.map(([k,v],i)=>{const y=115+i*rowHeight;return `<line x1="40" x2="860" y1="${y+19}" y2="${y+19}" stroke="#d8e6f2"/>${text(k,65,y-5,20,true,'#06367c')}${text(':',377,y-5,20,true)}${wrap(v,408,y-5)}`}).join('');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${contentHeight}"><rect width="900" height="${contentHeight}" fill="white"/><rect x="25" y="18" width="850" height="${contentHeight-35}" rx="22" fill="#f9fcff" stroke="#dce8f2"/><rect x="42" y="30" width="816" height="52" rx="12" fill="${tint}"/>${text('▦  Appointment Details',65,65,29,true,primary)}${rowSvg}</svg>`;
  return sharp({create:{width,height:total,channels:4,background:'#fff'}}).composite([{input:await sharp(head).resize({width,height:headerHeight,fit:'fill'}).toBuffer(),top:0,left:0},{input:Buffer.from(svg),top:headerHeight,left:0}]).png().toBuffer();
}

import {createHmac,timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const days=new Set(['day1','day2','day3']);
const secret=()=>process.env.SMART_REMINDER_ACTION_SECRET||process.env.SMART_REMINDER_TOKEN_SECRET||process.env.BOOKING_LINK_SECRET||process.env.GV_BOOKING_ACTION_SECRET||process.env.JWT_SECRET||'';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const clean=(v,max=55)=>String(v??'').replace(/[\x00-\x1f]/g,' ').trim().slice(0,max);
const sign=(body,key)=>createHmac('sha256',key).update(body).digest('base64url');
export function createActivationImageToken({stage,name,date,time,course}){
 const key=secret();if(key.length<24)throw new Error('A configured activation image signing secret (>=24 chars) is required');
 if(!days.has(stage))throw new Error('Invalid stage');
 const data={s:stage,n:clean(name,42),d:clean(date,32),t:clean(time,20),c:clean(course,28),e:Date.now()+15*60*1000};
 const body=Buffer.from(JSON.stringify(data)).toString('base64url');
 return body+'.'+sign(body,key);
}
function verify(token){
 const key=secret();if(key.length<24||typeof token!=='string'||token.length>1500)return null;
 const [body,sig,...rest]=token.split('.');if(rest.length||!body||!sig)return null;
 const expected=sign(body,key);const a=Buffer.from(sig),b=Buffer.from(expected);
 if(a.length!==b.length||!timingSafeEqual(a,b))return null;
 try{const x=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));return days.has(x.s)&&Number.isFinite(x.e)&&x.e>Date.now()&&x.e<Date.now()+16*60*1000?x:null}catch{return null}
}
// The approved artwork remains the background. Only personalized name/date/time/course value regions are overlaid.
function overlay(data){
 const day=data.s;
 const positions={
  day1:{name:[64,435,610,60], date:[166,598,320,68],time:[625,598,285,68],course:[981,598,175,68]},
  day2:{name:[62,455,640,61], date:[170,615,322,74],time:[628,615,270,74],course:[984,615,174,74]},
  day3:{name:[68,440,650,65], date:[190,618,315,68],time:[650,618,210,68],course:[990,618,160,68]}
 }[day];
 const text=(value,x,y,w,h,fill,fontSize=34,bg='#e3f0fb')=>{
  const str=esc(value);const size=Math.max(19,Math.min(fontSize,Math.floor(w/Math.max(1,str.length)*1.55)));
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${bg}"/><text x="${x+4}" y="${y+h/2+size*.34}" font-family="Arial,DejaVu Sans,sans-serif" font-size="${size}" font-weight="700" fill="${fill}">${str}</text>`;
 };
 const p=positions;
 return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1199" height="1312">${text('Dear '+data.n+',',...p.name,'#0b1648',43,'#ffffff')}${text(data.d,...p.date,'#0b1648',33)}${text(data.t,...p.time,'#0b1648',32)}${text(data.c,...p.course,'#0b1648',32)}</svg>`);
}
export function installActivationDynamicMedia(app){
 app.get('/api/public/booking/activation-dynamic/:token.png',async(req,res)=>{
  const data=verify(req.params.token);if(!data)return res.status(404).end();
  try{
   const file=path.join(process.cwd(),'booking','activation-test',data.s+'.png');
   const img=await readFile(file);
   const output=await sharp(img).composite([{input:overlay(data)}]).png().toBuffer();
   res.set({'Cache-Control':'private,no-store','X-Content-Type-Options':'nosniff'});return res.type('png').send(output);
  }catch(e){console.error('activation dynamic image render failed',e.message);return res.status(500).end()}
 });
}

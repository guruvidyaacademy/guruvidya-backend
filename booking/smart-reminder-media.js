// Isolated media generation for manually tested Smart Appointment Reminder Utility templates.
// Does not change booking alerts, internal team alerts or scheduled reminder dispatch.
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

let schemaPromise;
const ensureSchema = (pool) => {
  if (!schemaPromise) schemaPromise = pool.query(`CREATE TABLE IF NOT EXISTS booking_smart_reminder_test_media (
    token TEXT PRIMARY KEY, image_bytes BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
  )`).catch(e => { schemaPromise = null; throw e; });
  return schemaPromise;
};
const esc = value => String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const fit = (value, max=34) => { const s=String(value??'').trim()||'—';return s.length>max?s.slice(0,max-1)+'…':s; };

export function installSmartReminderTestMediaRoute(app, pool) {
  app.get('/api/public/booking/smart-reminder/test-media/:token.jpg', async (req,res) => {
    const token=String(req.params.token||'');
    if(!/^[a-f0-9]{64}$/.test(token)) return res.status(404).end();
    try {
      await ensureSchema(pool);
      const r=await pool.query('SELECT image_bytes FROM booking_smart_reminder_test_media WHERE token=$1 AND expires_at>NOW()', [token]);
      if(!r.rowCount)return res.status(404).end();
      return res.status(200).set({ 'Content-Type':'image/jpeg', 'Cache-Control':'public, max-age=3600', 'X-Content-Type-Options':'nosniff', 'Content-Disposition':'inline; filename="reminder.jpg"' }).send(r.rows[0].image_bytes);
    } catch(e) { console.error('Smart reminder test media fetch:',e?.message||e);return res.status(503).end(); }
  });
}

export async function createSmartReminderTestMedia(pool, booking, publicBase) {
  if(!/^https:\/\/[^\s]+$/i.test(publicBase))throw Error('PUBLIC_API_URL must be a public HTTPS backend URL');
  const online=String(booking.mode||'').toLowerCase()==='online';
  const file=new URL(online?'./smart-reminder-online.png':'./smart-reminder-offline.png',import.meta.url);
  const original=await readFile(file);
  const date=new Date(booking.starts_at);
  if(!Number.isFinite(date.getTime()))throw Error('Invalid booking start time');
  const dateText=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',day:'2-digit',month:'short',year:'numeric'}).format(date);
  const timeText=new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',hour:'numeric',minute:'2-digit',hour12:true}).format(date)+' IST';
  const values=[booking.booking_ref,booking.student_name,booking.course,dateText,timeText,booking.counsellor_name||'Admission Counsellor',online?'Online':'Offline',...(online?[]:[booking.offline_location_name||'Head Office – Tagore Garden'])];
  const rows=values.map((v,i)=>{
    const y=702+i*65;
    const size=String(v??'').length>26?23:29;
    return `<text x="439" y="${y+11}" font-family="Arial,Helvetica,sans-serif" font-size="${size}" fill="#082c69">${esc(fit(v,36))}</text><line x1="433" x2="971" y1="${y+32}" y2="${y+32}" stroke="#b9dbf5" stroke-width="1"/>`;
  }).join('');
  const height=online?482:540;
  const svg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1536"><rect x="430" y="666" width="550" height="${height}" fill="#eaf5ff" fill-opacity="0.98"/>${rows}</svg>`);
  const jpeg=await sharp(original).composite([{input:svg}]).flatten({background:'#ffffff'}).jpeg({quality:83,mozjpeg:true}).toBuffer();
  if(jpeg.length<1024||jpeg.length>5*1024*1024)throw Error('Reminder JPEG invalid or too large');
  await ensureSchema(pool);
  const token=randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO booking_smart_reminder_test_media(token,image_bytes,expires_at) VALUES($1,$2,NOW()+INTERVAL '24 hours')`,[token,jpeg]);
  pool.query('DELETE FROM booking_smart_reminder_test_media WHERE expires_at<NOW()').catch(e=>console.error('Smart reminder media cleanup:',e?.message||e));
  return `${publicBase.replace(/\/$/,'')}/api/public/booking/smart-reminder/test-media/${token}.jpg`;
}

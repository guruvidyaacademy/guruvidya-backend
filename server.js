
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

let counters = { leads:1, admissions:1, appointments:1, support:1, faculty:1, alerts:1, reminders:1, whatsapp_logs:1 };
const db = { leads:[], admissions:[], appointments:[], support:[], faculty:[], alerts:[], reminders:[], whatsapp_logs:[] };

let config = {
  autoAssign: true,
  whatsappEnabled: false,
  botsailorApiUrl: "",
  botsailorToken: "",
  followupDays: [2,3,5],
  counselors: ["Counselor 1","Counselor 2","Reception"],
  nextCounselorIndex: 0
};

const now = () => new Date().toISOString().replace("T"," ").slice(0,19);
const nextId = (t) => counters[t]++;

function addAlert(type, title, payload={}) {
  const a = { id: nextId("alerts"), type, title, payload, created_at: now() };
  db.alerts.unshift(a);
  return a;
}
function calcPriority(p) {
  const txt = `${p.course||""} ${p.issue||""} ${p.note||""} ${p.description||""}`.toLowerCase();
  if (txt.includes("acca") || txt.includes("urgent") || txt.includes("payment")) return "hot";
  if (txt.includes("ca") || txt.includes("cma") || txt.includes("call")) return "warm";
  return "cold";
}
function autoOwner() {
  if (!config.autoAssign || !config.counselors.length) return "Unassigned";
  const owner = config.counselors[config.nextCounselorIndex % config.counselors.length];
  config.nextCounselorIndex++;
  return owner;
}
function addReminder(table, record, days=2, reason="follow_up") {
  const due = new Date(Date.now() + days*86400000).toISOString().slice(0,10);
  const r = { id: nextId("reminders"), table, record_id: record.id, name: record.name||"", mobile: record.mobile||"", owner: record.owner||"Unassigned", reason, due_date: due, status:"pending", created_at: now() };
  db.reminders.unshift(r);
  addAlert("followup_reminder", `Follow-up reminder created`, r);
  return r;
}
function whatsappLog(table, record, template="update") {
  const w = { id: nextId("whatsapp_logs"), table, record_id: record.id, mobile: record.mobile||"", template, status: config.whatsappEnabled ? "ready_to_send" : "placeholder_only", message: `Guruvidya update: ${record.name||"Student"}, status ${record.status}, assigned to ${record.owner}`, created_at: now() };
  db.whatsapp_logs.unshift(w);
  addAlert("whatsapp_trigger", "WhatsApp trigger generated", w);
  return w;
}
function insert(table, payload) {
  const record = { id: nextId(table), ...payload, priority: payload.priority || calcPriority(payload), status: payload.status || (table==="appointments" ? "requested" : "new"), owner: payload.owner || autoOwner(), note: payload.note || "", admin_note: payload.admin_note || "", created_at: now() };
  db[table].unshift(record);
  addAlert(`${table}_created`, `New ${table} received`, { id: record.id, name: record.name, mobile: record.mobile, owner: record.owner, priority: record.priority });
  if (["leads","admissions","appointments"].includes(table)) addReminder(table, record, config.followupDays[0] || 2);
  whatsappLog(table, record, `${table}_created`);
  return record;
}

app.get("/health", (req,res)=>res.json({success:true,message:"OK",phase:"2"}));

app.get("/api/admin/config", (req,res)=>res.json({success:true,data:config}));
app.post("/api/admin/config", (req,res)=>{ config={...config,...req.body}; addAlert("config_updated","Automation config updated",req.body); res.json({success:true,data:config}); });

app.get("/api/admin/counselor-stats", (req,res)=>{
  const all = ["leads","admissions","appointments","support","faculty"].flatMap(t=>db[t].map(r=>({...r,table:t})));
  const names = Array.from(new Set([...config.counselors,"Unassigned",...all.map(r=>r.owner||"Unassigned")]));
  const data = names.map(owner => {
    const rows = all.filter(r => (r.owner||"Unassigned") === owner);
    return { owner, total: rows.length, hot: rows.filter(r=>r.priority==="hot").length, warm: rows.filter(r=>r.priority==="warm").length, cold: rows.filter(r=>r.priority==="cold").length, converted: rows.filter(r=>["converted","completed","resolved","selected"].includes(r.status)).length, follow_up: rows.filter(r=>["follow_up","contacted","interested","confirmed","in_progress"].includes(r.status)).length };
  });
  res.json({success:true,data});
});

app.post("/api/public/enquiry", (req,res)=>res.json({success:true,data:insert("leads",{name:req.body.name||"",mobile:req.body.mobile||req.body.phone||req.body.whatsapp||"",course:req.body.course||"",note:req.body.note||""})}));
app.post("/api/public/admission-enquiry", (req,res)=>res.json({success:true,data:insert("admissions",{name:req.body.name||"",mobile:req.body.mobile||req.body.phone||"",email:req.body.email||"",course:req.body.course||"",note:req.body.note||""})}));
app.post("/api/public/appointment-request", (req,res)=>res.json({success:true,data:insert("appointments",{name:req.body.name||"",mobile:req.body.mobile||req.body.phone||"",course:req.body.course||"",datetime:req.body.datetime||req.body.date||"",note:req.body.note||""})}));
app.post("/api/public/support-request", (req,res)=>res.json({success:true,data:insert("support",{name:req.body.name||"",mobile:req.body.mobile||req.body.phone||"",issue:req.body.issue||"",description:req.body.description||req.body.message||"",owner:req.body.owner||"Technical"})}));
app.post("/api/public/faculty-interest", (req,res)=>res.json({success:true,data:insert("faculty",{name:req.body.name||"",mobile:req.body.mobile||req.body.phone||"",course:req.body.course||"",mode:req.body.mode||"",owner:req.body.owner||"HR"})}));

for (const t of ["leads","admissions","appointments","support","faculty","alerts","reminders","whatsapp_logs"]) {
  app.get(`/api/admin/${t}`, (req,res)=>res.json({success:true,data:db[t]||[]}));
}
for (const t of ["leads","admissions","appointments","support","faculty"]) {
  app.post(`/api/admin/${t}/:id/action`, (req,res)=>{
    const item = db[t].find(r=>Number(r.id)===Number(req.params.id));
    if (!item) return res.status(404).json({success:false,message:"Record not found"});
    const oldStatus = item.status, oldOwner = item.owner;
    item.status = req.body.status || item.status || "new";
    item.owner = req.body.owner || item.owner || "Unassigned";
    item.priority = req.body.priority || item.priority || "cold";
    item.note = req.body.note || "";
    item.admin_note = item.note;
    item.updated_at = now();
    if (req.body.sendNotification !== false) addAlert(`${t}_action`, `${t} updated`, {id:item.id,name:item.name,mobile:item.mobile,oldStatus,newStatus:item.status,oldOwner,newOwner:item.owner,note:item.note});
    if (req.body.createReminder || ["follow_up","interested","contacted"].includes(item.status)) addReminder(t,item,Number(req.body.reminderDays||2));
    if (req.body.sendWhatsapp) whatsappLog(t,item,`${t}_action`);
    res.json({success:true,message:`${t} updated`,data:item});
  });
}

app.listen(PORT,()=>console.log(`Guruvidya Phase 2 backend running on ${PORT}`));

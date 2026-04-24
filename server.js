
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

let counters = {
  leads: 1,
  admissions: 1,
  appointments: 1,
  support: 1,
  faculty: 1,
  alerts: 1
};

const db = {
  leads: [],
  admissions: [],
  appointments: [],
  support: [],
  faculty: [],
  alerts: []
};

const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const nextId = (table) => counters[table]++;

function addAlert(type, title, payload = {}) {
  const alert = { id: nextId("alerts"), type, title, payload, created_at: now() };
  db.alerts.unshift(alert);
  return alert;
}

function normalizeActionBody(body = {}) {
  return {
    status: body.status || "new",
    owner: body.owner || "Unassigned",
    note: body.note || body.admin_note || "",
    sendNotification: body.sendNotification !== false,
    sendWhatsapp: body.sendWhatsapp === true
  };
}

function publicInsert(table, payload) {
  const record = {
    id: nextId(table),
    ...payload,
    status: payload.status || (table === "appointments" ? "requested" : "new"),
    owner: payload.owner || "Unassigned",
    note: payload.note || "",
    admin_note: payload.admin_note || "",
    created_at: now()
  };
  db[table].unshift(record);
  addAlert(`${table}_created`, `New ${table} received`, { id: record.id, name: record.name, mobile: record.mobile, course: record.course });
  return record;
}

app.get("/health", (req, res) => res.json({ success: true, message: "OK" }));

app.post("/api/public/enquiry", (req, res) => {
  const record = publicInsert("leads", {
    name: req.body.name || "",
    mobile: req.body.mobile || req.body.phone || req.body.whatsapp || "",
    course: req.body.course || "",
  });
  res.json({ success: true, data: record });
});

app.post("/api/public/admission-enquiry", (req, res) => {
  const record = publicInsert("admissions", {
    name: req.body.name || "",
    mobile: req.body.mobile || req.body.phone || "",
    email: req.body.email || "",
    course: req.body.course || "",
  });
  res.json({ success: true, data: record });
});

app.post("/api/public/appointment-request", (req, res) => {
  const record = publicInsert("appointments", {
    name: req.body.name || "",
    mobile: req.body.mobile || req.body.phone || "",
    course: req.body.course || "",
    datetime: req.body.datetime || req.body.date || "",
  });
  res.json({ success: true, data: record });
});

app.post("/api/public/support-request", (req, res) => {
  const record = publicInsert("support", {
    name: req.body.name || "",
    mobile: req.body.mobile || req.body.phone || "",
    issue: req.body.issue || "",
    description: req.body.description || req.body.message || "",
  });
  res.json({ success: true, data: record });
});

app.post("/api/public/faculty-interest", (req, res) => {
  const record = publicInsert("faculty", {
    name: req.body.name || "",
    mobile: req.body.mobile || req.body.phone || "",
    course: req.body.course || "",
    mode: req.body.mode || "",
  });
  res.json({ success: true, data: record });
});

app.get("/api/admin/leads", (req, res) => res.json({ success: true, data: db.leads }));
app.get("/api/admin/admissions", (req, res) => res.json({ success: true, data: db.admissions }));
app.get("/api/admin/appointments", (req, res) => res.json({ success: true, data: db.appointments }));
app.get("/api/admin/support", (req, res) => res.json({ success: true, data: db.support }));
app.get("/api/admin/faculty", (req, res) => res.json({ success: true, data: db.faculty }));
app.get("/api/admin/alerts", (req, res) => res.json({ success: true, data: db.alerts }));

for (const table of ["leads","admissions","appointments","support","faculty"]) {
  app.post(`/api/admin/${table}/:id/action`, (req, res) => {
    const id = Number(req.params.id);
    const item = db[table].find(r => Number(r.id) === id);
    if (!item) return res.status(404).json({ success: false, message: "Record not found" });

    const oldStatus = item.status;
    const oldOwner = item.owner;
    const action = normalizeActionBody(req.body);

    item.status = action.status;
    item.owner = action.owner;
    item.note = action.note;
    item.admin_note = action.note;
    item.updated_at = now();

    if (action.sendNotification) {
      addAlert(`${table}_action`, `${table} updated`, {
        id: item.id,
        name: item.name,
        mobile: item.mobile,
        oldStatus,
        newStatus: item.status,
        oldOwner,
        newOwner: item.owner,
        note: item.note
      });
    }

    if (action.sendWhatsapp) {
      addAlert("whatsapp_placeholder", "WhatsApp trigger placeholder", {
        table,
        id: item.id,
        mobile: item.mobile,
        message: `Guruvidya update: status ${item.status}, assigned to ${item.owner}`
      });
    }

    res.json({ success: true, message: `${table} updated`, data: item });
  });
}

app.listen(PORT, () => console.log(`Guruvidya backend running on port ${PORT}`));

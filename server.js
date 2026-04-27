import express from "express";
import cors from "cors";
import axios from "axios";
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
  alerts: 1,
  reminders: 1,
  whatsapp_logs: 1,
  integration_logs: 1
};

const db = {
  leads: [],
  admissions: [],
  appointments: [],
  support: [],
  faculty: [],
  alerts: [],
  reminders: [],
  whatsapp_logs: [],
  integration_logs: []
};

let config = {
  autoAssign: true,

  whatsappEnabled: false,
  botsailorApiUrl: "",
  botsailorToken: "",
  botsailorInstanceId: "",
  botsailorTemplateId: "",

  razorpayEnabled: false,
  razorpayKeyId: "",
  razorpayKeySecret: "",

  youtubeEnabled: false,
  youtubeApiKey: "",

  myoperatorEnabled: false,
  myoperatorApiKey: "",

  aiEnabled: false,
  aiProvider: "",
  aiApiKey: "",
  aiMode: "assist",

  followupDays: [2, 3, 5],
  counselors: ["Counselor 1", "Counselor 2", "Reception"],
  nextCounselorIndex: 0
};

const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const nextId = (t) => counters[t]++;

function addAlert(type, title, payload = {}) {
  const a = { id: nextId("alerts"), type, title, payload, created_at: now() };
  db.alerts.unshift(a);
  return a;
}

function addIntegrationLog(channel, action, status, payload = {}, response = {}) {
  const log = {
    id: nextId("integration_logs"),
    channel,
    action,
    status,
    payload,
    response,
    created_at: now()
  };
  db.integration_logs.unshift(log);
  return log;
}

function calcPriority(p) {
  const txt = `${p.course || ""} ${p.issue || ""} ${p.note || ""} ${p.description || ""}`.toLowerCase();
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

function addReminder(table, record, days = 2, reason = "follow_up") {
  const due = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const r = {
    id: nextId("reminders"),
    table,
    record_id: record.id,
    name: record.name || "",
    mobile: record.mobile || "",
    owner: record.owner || "Unassigned",
    reason,
    due_date: due,
    status: "pending",
    created_at: now()
  };
  db.reminders.unshift(r);
  addAlert("followup_reminder", "Follow-up reminder created", r);
  return r;
}

async function sendBotSailorMessage(record, template = "update") {
  if (!config.whatsappEnabled) {
    return { success: false, status: "disabled", message: "WhatsApp disabled" };
  }

  if (!config.botsailorApiUrl || !config.botsailorToken) {
    return { success: false, status: "missing_config", message: "BotSailor API URL or token missing" };
  }

  const message = `Guruvidya update:
Name: ${record.name || "Student"}
Mobile: ${record.mobile || ""}
Course: ${record.course || ""}
Status: ${record.status || "new"}
Owner: ${record.owner || "Unassigned"}`;

  const payload = {
    apiToken: config.botsailorToken,
    phoneNumberID: config.botsailorInstanceId,
    botTemplateID: config.botsailorTemplateId,
    sendToPhoneNumber: record.mobile || "",
    phone: record.mobile || "",
    mobile: record.mobile || "",
    message,
    template
  };

  try {
    const response = await fetch(config.botsailorApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.botsailorToken}`
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    addIntegrationLog("whatsapp", "send_message", response.ok ? "success" : "failed", payload, data);

    return {
      success: response.ok,
      status: response.ok ? "sent" : "failed",
      message,
      response: data
    };
  } catch (err) {
    addIntegrationLog("whatsapp", "send_message", "failed", payload, { error: err.message });
    return {
      success: false,
      status: "failed",
      message,
      error: err.message
    };
  }
}

async function whatsappLog(table, record, template = "update") {
  const result = await sendBotSailorMessage(record, template);

  const w = {
    id: nextId("whatsapp_logs"),
    table,
    record_id: record.id,
    mobile: record.mobile || "",
    template,
    status: result.status || "placeholder_only",
    message:
      result.message ||
      `Guruvidya update: ${record.name || "Student"}, status ${record.status}, assigned to ${record.owner}`,
    response: result.response || {},
    error: result.error || "",
    created_at: now()
  };

  db.whatsapp_logs.unshift(w);
  addAlert("whatsapp_trigger", "WhatsApp trigger processed", w);
  return w;
}

async function insert(table, payload) {
  const record = {
    id: nextId(table),
    ...payload,
    priority: payload.priority || calcPriority(payload),
    status: payload.status || (table === "appointments" ? "requested" : "new"),
    owner: payload.owner || autoOwner(),
    note: payload.note || "",
    admin_note: payload.admin_note || "",
    created_at: now()
  };

  db[table].unshift(record);

  addAlert(`${table}_created`, `New ${table} received`, {
    id: record.id,
    name: record.name,
    mobile: record.mobile,
    owner: record.owner,
    priority: record.priority
  });

  if (["leads", "admissions", "appointments"].includes(table)) {
    addReminder(table, record, config.followupDays[0] || 2);
  }

  await whatsappLog(table, record, `${table}_created`);
  return record;
}

app.get("/health", (req, res) =>
  res.json({ success: true, message: "OK", phase: "3", module: "integration_panel" })
);

// Admin config
app.get("/api/admin/config", (req, res) => res.json({ success: true, data: config }));

app.post("/api/admin/config", (req, res) => {
  config = { ...config, ...req.body };
  addAlert("config_updated", "Automation config updated", req.body);
  res.json({ success: true, data: config });
});

// Integration Panel APIs
app.get("/api/admin/integrations", (req, res) => {
  res.json({
    success: true,
    data: {
      whatsappEnabled: config.whatsappEnabled,
      botsailorApiUrl: config.botsailorApiUrl,
      botsailorToken: config.botsailorToken,
      botsailorInstanceId: config.botsailorInstanceId,
      botsailorTemplateId: config.botsailorTemplateId,

      razorpayEnabled: config.razorpayEnabled,
      razorpayKeyId: config.razorpayKeyId,
      razorpayKeySecret: config.razorpayKeySecret,

      youtubeEnabled: config.youtubeEnabled,
      youtubeApiKey: config.youtubeApiKey,

      myoperatorEnabled: config.myoperatorEnabled,
      myoperatorApiKey: config.myoperatorApiKey,

      aiEnabled: config.aiEnabled,
      aiProvider: config.aiProvider,
      aiApiKey: config.aiApiKey,
      aiMode: config.aiMode
    }
  });
});

app.post("/api/admin/integrations", (req, res) => {
  config = { ...config, ...req.body };
  addAlert("integration_updated", "Integration settings updated", req.body);
  addIntegrationLog("settings", "save", "success", req.body, { message: "Settings saved" });
  res.json({ success: true, message: "Integration settings saved", data: config });
});

app.post("/api/admin/integrations/botsailor/test", async (req, res) => {
  const testRecord = {
    name: req.body.name || "Test Student",
    mobile: req.body.mobile || req.body.phone || "",
    course: req.body.course || "ACCA",
    status: "test",
    owner: "Admin"
  };

  const result = await sendBotSailorMessage(testRecord, "test_connection");
  res.json({
    success: result.success,
    message: result.success ? "BotSailor test successful" : "BotSailor test failed",
    data: result
  });
});

app.get("/api/admin/integration-logs", (req, res) =>
  res.json({ success: true, data: db.integration_logs })
);

// Counselor stats
app.get("/api/admin/counselor-stats", (req, res) => {
  const all = ["leads", "admissions", "appointments", "support", "faculty"].flatMap((t) =>
    db[t].map((r) => ({ ...r, table: t }))
  );

  const names = Array.from(new Set([...config.counselors, "Unassigned", ...all.map((r) => r.owner || "Unassigned")]));

  const data = names.map((owner) => {
    const rows = all.filter((r) => (r.owner || "Unassigned") === owner);
    return {
      owner,
      total: rows.length,
      hot: rows.filter((r) => r.priority === "hot").length,
      warm: rows.filter((r) => r.priority === "warm").length,
      cold: rows.filter((r) => r.priority === "cold").length,
      converted: rows.filter((r) => ["converted", "completed", "resolved", "selected"].includes(r.status)).length,
      follow_up: rows.filter((r) =>
        ["follow_up", "contacted", "interested", "confirmed", "in_progress"].includes(r.status)
      ).length
    };
  });

  res.json({ success: true, data });
});

// Public website APIs
app.post("/api/public/enquiry", async (req, res) =>
  res.json({
    success: true,
    data: await insert("leads", {
      name: req.body.name || "",
      mobile: req.body.mobile || req.body.phone || req.body.whatsapp || "",
      course: req.body.course || "",
      note: req.body.note || ""
    })
  })
);

app.post("/api/public/admission-enquiry", async (req, res) =>
  res.json({
    success: true,
    data: await insert("admissions", {
      name: req.body.name || "",
      mobile: req.body.mobile || req.body.phone || "",
      email: req.body.email || "",
      course: req.body.course || "",
      note: req.body.note || ""
    })
  })
);

app.post("/api/public/appointment-request", async (req, res) =>
  res.json({
    success: true,
    data: await insert("appointments", {
      name: req.body.name || "",
      mobile: req.body.mobile || req.body.phone || "",
      course: req.body.course || "",
      datetime: req.body.datetime || req.body.date || "",
      note: req.body.note || ""
    })
  })
);

app.post("/api/public/support-request", async (req, res) =>
  res.json({
    success: true,
    data: await insert("support", {
      name: req.body.name || "",
      mobile: req.body.mobile || req.body.phone || "",
      issue: req.body.issue || "",
      description: req.body.description || req.body.message || "",
      owner: req.body.owner || "Technical"
    })
  })
);

app.post("/api/public/faculty-interest", async (req, res) =>
  res.json({
    success: true,
    data: await insert("faculty", {
      name: req.body.name || "",
      mobile: req.body.mobile || req.body.phone || "",
      course: req.body.course || "",
      mode: req.body.mode || "",
      owner: req.body.owner || "HR"
    })
  })
);

// Admin listing APIs
for (const t of [
  "leads",
  "admissions",
  "appointments",
  "support",
  "faculty",
  "alerts",
  "reminders",
  "whatsapp_logs",
  "integration_logs"
]) {
  app.get(`/api/admin/${t}`, (req, res) => res.json({ success: true, data: db[t] || [] }));
}

// Action Panel APIs
for (const t of ["leads", "admissions", "appointments", "support", "faculty"]) {
  app.post(`/api/admin/${t}/:id/action`, async (req, res) => {
    const item = db[t].find((r) => Number(r.id) === Number(req.params.id));

    if (!item) return res.status(404).json({ success: false, message: "Record not found" });

    const oldStatus = item.status;
    const oldOwner = item.owner;

    item.status = req.body.status || item.status || "new";
    item.owner = req.body.owner || item.owner || "Unassigned";
    item.priority = req.body.priority || item.priority || "cold";
    item.note = req.body.note || "";
    item.admin_note = item.note;
    item.updated_at = now();

    if (req.body.sendNotification !== false) {
      addAlert(`${t}_action`, `${t} updated`, {
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

    if (req.body.createReminder || ["follow_up", "interested", "contacted"].includes(item.status)) {
      addReminder(t, item, Number(req.body.reminderDays || 2));
    }

    if (req.body.sendWhatsapp) {
      await whatsappLog(t, item, `${t}_action`);
    }

    res.json({ success: true, message: `${t} updated`, data: item });
  });
}

app.post("/api/webhook/botsailor", async (req, res) => {
  const payload = req.body || {};

  const lead = {
    id: counters.leads++,
    name: payload.name || "WhatsApp Lead",
    mobile: String(payload.phone || payload.subscriber_id || ""),
    course: payload.course || "ACCA",
    priority: "hot",
    status: "new",
    owner: "Counselor 1",
    note: `Source: botsailor_whatsapp | Subscriber ID: ${payload.subscriber_id || ""}`,
    created_at: new Date().toISOString().replace("T", " ").slice(0, 19)
  };

  db.leads.unshift(lead);

  // ✅ WhatsApp auto message
 await sendWhatsAppMessage(
  lead.mobile,
  `Hi ${lead.name}, Thanks for connecting to Guruvidya 🎓`
);

  console.log("BotSailor Lead Saved:", lead);

  res.status(200).json({
    status: "ok",
    message: "Lead saved from BotSailor",
    lead
  });
});

async function sendWhatsAppMessage(phone, message) {
  try {
    const response = await axios.post(
      "https://botsailor.com/api/v1/whatsapp/send",
      {
        apiToken: process.env.BOTSAILOR_API_KEY,
        phone_number_id: process.env.BOTSAILOR_INSTANCE_ID,
        phone_number: phone,
        message: message,
      }
    );

    console.log("WhatsApp Sent:", response.data);
  } catch (error) {
    console.log("WhatsApp Error:", error.response?.data || error.message);
  }
}

app.listen(PORT, () => console.log(`Guruvidya Phase 3 backend running on ${PORT}`));

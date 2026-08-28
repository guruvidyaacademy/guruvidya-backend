import express from "express";
import cors from "cors";
import axios from "axios";
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});
pool.query("SELECT NOW()")
  .then(() => console.log("✅ PostgreSQL connected successfully"))
  .catch((err) => console.error("❌ PostgreSQL connection error:", err.message));
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY,
        name TEXT,
        mobile TEXT,
        course TEXT,
        priority TEXT,
        status TEXT,
        owner TEXT,
        note TEXT,
        admin_note TEXT,
        lead_score INTEGER DEFAULT 50,
        lead_stage TEXT,
        next_best_action TEXT,
        enquiry_count INTEGER DEFAULT 1,
        next_followup TIMESTAMP,
        last_enquiry_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS admissions (
        id SERIAL PRIMARY KEY,
        name TEXT,
        mobile TEXT,
        email TEXT,
        course TEXT,
        priority TEXT,
        status TEXT,
        owner TEXT,
        note TEXT,
        admin_note TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS appointments (
        id SERIAL PRIMARY KEY,
        name TEXT,
        mobile TEXT,
        course TEXT,
        datetime TEXT,
        priority TEXT,
        status TEXT,
        owner TEXT,
        note TEXT,
        admin_note TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS support (
        id SERIAL PRIMARY KEY,
        name TEXT,
        mobile TEXT,
        issue TEXT,
        description TEXT,
        priority TEXT,
        status TEXT,
        owner TEXT,
        note TEXT,
        admin_note TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS faculty (
        id SERIAL PRIMARY KEY,
        name TEXT,
        mobile TEXT,
        course TEXT,
        mode TEXT,
        priority TEXT,
        status TEXT,
        owner TEXT,
        note TEXT,
        admin_note TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP
      );
            CREATE TABLE IF NOT EXISTS alerts (
        id SERIAL PRIMARY KEY,
        type TEXT,
        title TEXT,
        payload JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS reminders (
        id SERIAL PRIMARY KEY,
        table_name TEXT,
        record_id INTEGER,
        name TEXT,
        mobile TEXT,
        owner TEXT,
        reason TEXT,
        due_date DATE,
        status TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS whatsapp_logs (
        id SERIAL PRIMARY KEY,
        table_name TEXT,
        record_id INTEGER,
        mobile TEXT,
        template TEXT,
        status TEXT,
        message TEXT,
        response JSONB DEFAULT '{}'::jsonb,
        error TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS integration_logs (
        id SERIAL PRIMARY KEY,
        channel TEXT,
        action TEXT,
        status TEXT,
        payload JSONB DEFAULT '{}'::jsonb,
        response JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("✅ PostgreSQL tables ready");
  } catch (err) {
    console.error("❌ PostgreSQL table setup error:", err.message);
  }
}

initDatabase();
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

// ✅ GLOBAL DUPLICATE CODE START
function cleanMobile(v = "") {
  return String(v || "").replace(/\D/g, "");
}

function findDuplicate(table, mobile, extraCheck = null) {
  const cm = cleanMobile(mobile);
  return db[table].find(r => {
    if (cleanMobile(r.mobile) !== cm) return false;
    if (extraCheck && !extraCheck(r)) return false;
    return true;
  });
}

async function insertUnique(table, payload, options = {}) {
  const mobile = cleanMobile(payload.mobile || payload.phone || payload.whatsapp || "");
  const duplicate = findDuplicate(table, mobile, options.extraCheck);

  if (duplicate) {
    duplicate.updated_at = new Date().toISOString().replace("T", " ").slice(0, 19);

    if (payload.course && payload.course !== duplicate.course) {
      duplicate.note = (duplicate.note || "") + 
        ` | Course changed: ${duplicate.course || ""} → ${payload.course}`;
      
      duplicate.course = payload.course;
    }

    if (payload.issue) duplicate.issue = payload.issue;
    if (payload.description) duplicate.description = payload.description;
    if (payload.mode) duplicate.mode = payload.mode;

   duplicate.status = options.duplicateStatus || "re-enquiry";
duplicate.last_enquiry_at = now();
duplicate.enquiry_count = (duplicate.enquiry_count || 1) + 1;

// 🔥 AI behaviour add karo yahin
duplicate.lead_score = (duplicate.lead_score || 50) + 10;
duplicate.next_best_action = "Call again - high intent";

// 🔥 NEW ADD START
if (duplicate.enquiry_count >= 3) {
  duplicate.priority = "very hot";
}

const next = new Date();
next.setDate(next.getDate() + 1); // next day follow-up
duplicate.next_followup = next.toISOString().slice(0, 19).replace("T", " ");
// 🔥 NEW ADD END

const duplicateNote = `Duplicate updated in ${table}`;
if (!(duplicate.note || "").includes(duplicateNote)) {
  duplicate.note = (duplicate.note || "") + ` | ${duplicateNote}`;
}

    return duplicate;
  }

  return await insert(table, { ...payload, mobile });
}
// ✅ GLOBAL DUPLICATE CODE END

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

async function addAlert(type, title, payload = {}) {
  try {
    const result = await pool.query(
      `INSERT INTO alerts (type, title, payload, created_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       RETURNING *`,
      [type, title, JSON.stringify(payload)]
    );

    const a = result.rows[0];
    db.alerts.unshift(a);
    return a;
  } catch (err) {
    console.error("❌ Alert PostgreSQL insert error:", err.message);
    throw err;
  }
}
async function addIntegrationLog(channel, action, status, payload = {}, response = {}) {
  try {
    const result = await pool.query(
      `INSERT INTO integration_logs
       (channel, action, status, payload, response, created_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        channel,
        action,
        status,
        JSON.stringify(payload),
        JSON.stringify(response)
      ]
    );

    const log = result.rows[0];
    db.integration_logs.unshift(log);
    return log;
  } catch (err) {
    console.error("❌ Integration Log PostgreSQL insert error:", err.message);
    throw err;
  }
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

async function addReminder(table, record, days = 2, reason = "follow_up") {
  try {
    const due = new Date(Date.now() + days * 86400000)
      .toISOString()
      .slice(0, 10);

    const result = await pool.query(
      `INSERT INTO reminders
       (table_name, record_id, name, mobile, owner, reason, due_date, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        table,
        record.id,
        record.name || "",
        record.mobile || "",
        record.owner || "Unassigned",
        reason,
        due,
        "pending"
      ]
    );

    const r = result.rows[0];
    db.reminders.unshift(r);

    await addAlert(
      "followup_reminder",
      "Follow-up reminder created",
      r
    );

    return r;
  } catch (err) {
    console.error("❌ Reminder PostgreSQL insert error:", err.message);
    throw err;
  }
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

  try {
    const pgResult = await pool.query(
      `INSERT INTO whatsapp_logs
       (table_name, record_id, mobile, template, status, message, response, error, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        table,
        record.id,
        record.mobile || "",
        template,
        result.status || "placeholder_only",
        result.message ||
          `Guruvidya update: ${record.name || "Student"}, status ${record.status}, assigned to ${record.owner}`,
        JSON.stringify(result.response || {}),
        result.error || ""
      ]
    );

    const w = pgResult.rows[0];

    db.whatsapp_logs.unshift(w);

    await addAlert(
      "whatsapp_trigger",
      "WhatsApp trigger processed",
      w
    );

    return w;
  } catch (err) {
    console.error("❌ WhatsApp Log PostgreSQL insert error:", err.message);
    throw err;
  }
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
// ✅ Save new lead permanently in PostgreSQL
if (table === "leads") {
  try {
    const pgResult = await pool.query(
      `INSERT INTO leads
      (
        name,
        mobile,
        course,
        priority,
        status,
        owner,
        note,
        admin_note,
        lead_score,
        lead_stage,
        next_best_action,
        enquiry_count,
        next_followup,
        last_enquiry_at,
        created_at
      )
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *`,
      [
        record.name || "",
        record.mobile || "",
        record.course || "",
        record.priority || "hot",
        record.status || "new",
        record.owner || "Counselor 1",
        record.note || "",
        record.admin_note || "",
        record.lead_score ?? 50,
        record.lead_stage || "new",
        record.next_best_action || "",
        record.enquiry_count ?? 1,
        record.next_followup || null,
        record.last_enquiry_at || null,
        record.created_at
      ]
    );

    // PostgreSQL ka permanent ID use karo
    record.id = pgResult.rows[0].id;

    console.log("✅ Lead saved to PostgreSQL:", record.id);
  } catch (err) {
    console.error("❌ PostgreSQL lead insert error:", err.message);
    throw err;
  }
}
// ✅ Save admissions, appointments, support and faculty permanently in PostgreSQL
if (["admissions", "appointments", "support", "faculty"].includes(table)) {
  try {
    const columnsByTable = {
      admissions: [
        "name", "mobile", "email", "course", "priority",
        "status", "owner", "note", "admin_note"
      ],

      appointments: [
        "name", "mobile", "course", "datetime", "priority",
        "status", "owner", "note", "admin_note"
      ],

      support: [
        "name", "mobile", "issue", "description", "priority",
        "status", "owner", "note", "admin_note"
      ],

      faculty: [
        "name", "mobile", "course", "mode", "priority",
        "status", "owner", "note", "admin_note"
      ]
    };

    const columns = columnsByTable[table];

    const values = columns.map((col) => {
      if (col === "priority") return record[col] || "warm";
      if (col === "status") return record[col] || "new";
      if (col === "owner") return record[col] || "Counselor 1";
      return record[col] || "";
    });

    const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");

    const pgResult = await pool.query(
      `INSERT INTO ${table} (${columns.join(", ")})
       VALUES (${placeholders})
       RETURNING *`,
      values
    );

    record.id = pgResult.rows[0].id;

    console.log(`✅ ${table} saved to PostgreSQL:`, record.id);
  } catch (err) {
    console.error(`❌ PostgreSQL ${table} insert error:`, err.message);
    throw err;
  }
}
  
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

app.get("/api/admin/pipeline", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM leads ORDER BY id DESC"
    );

    const leads = result.rows;
    const today = new Date().toISOString().slice(0, 10);

    const normalize = (value) =>
      String(value || "").trim().toLowerCase();

    const isToday = (value) => {
      if (!value) return false;

      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return false;

      return date.toISOString().slice(0, 10) === today;
    };

    // Converted
    const converted = leads.filter(
      (l) => normalize(l.status) === "converted"
    );

    // Re-Enquiry
    const reEnquiry = leads.filter(
      (l) => normalize(l.status) === "re-enquiry"
    );

    // Follow-up due today
    const followupToday = leads.filter(
      (l) =>
        isToday(l.next_followup) &&
        !["converted", "re-enquiry"].includes(normalize(l.status))
    );

    // No Response
    const noResponse = leads.filter(
      (l) =>
        normalize(l.status) === "no_response" &&
        !isToday(l.next_followup)
    );

  // Very Hot
const veryHotLeads = leads.filter(
  (l) =>
    normalize(l.priority) === "very hot" &&
    ![
      "converted",
      "re-enquiry",
      "no_response",
      "not_interested",
      "closed"
    ].includes(normalize(l.status)) &&
    !isToday(l.next_followup)
);

// Hot
const hotLeads = leads.filter(
  (l) =>
    normalize(l.priority) === "hot" &&
    ![
      "converted",
      "re-enquiry",
      "no_response",
      "not_interested",
      "closed"
    ].includes(normalize(l.status)) &&
    !isToday(l.next_followup)
);

    // New
    const newLeads = leads.filter(
      (l) =>
        (
          normalize(l.lead_stage) === "new" ||
          normalize(l.status) === "new"
        ) &&
        !["hot", "very hot"].includes(normalize(l.priority)) &&
        !["converted", "re-enquiry", "no_response"].includes(
          normalize(l.status)
        ) &&
        !isToday(l.next_followup)
    );

    const data = {
      new_leads: newLeads,
      hot_leads: hotLeads,
      very_hot_leads: veryHotLeads,
      re_enquiry: reEnquiry,
      followup_today: followupToday,
      no_response: noResponse,
      converted
    };

    res.json({
      success: true,
      data
    });

  } catch (err) {
    console.error("❌ Pipeline fetch error:", err.message);

    res.status(500).json({
      success: false,
      message: "Failed to fetch pipeline"
    });
  }
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

app.get("/api/admin/integration-logs", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM integration_logs ORDER BY id DESC"
    );

    res.json({
      success: true,
      data: result.rows
    });
  } catch (err) {
    console.error("Integration logs fetch error:", err.message);

    res.status(500).json({
      success: false,
      message: "Failed to fetch integration logs"
    });
  }
});

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
    data: await insertUnique("leads", {
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
    data: await insertUnique("admissions", {
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
    data: await insertUnique("support", {
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
    data: await insertUnique("faculty", {
      name: req.body.name || "",
      mobile: req.body.mobile || req.body.phone || "",
      course: req.body.course || "",
      mode: req.body.mode || "",
      owner: req.body.owner || "HR"
    })
  })
);
// PostgreSQL Leads Listing API
app.get("/api/admin/leads", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM leads ORDER BY id DESC"
    );

    res.json({
      success: true,
      data: result.rows
    });
  } catch (err) {
    console.error("Leads fetch error:", err.message);

    res.status(500).json({
      success: false,
      message: "Failed to fetch leads"
    });
  }
});
// Admin listing APIs - PostgreSQL permanent data

for (const t of ["admissions", "appointments", "support", "faculty"]) {
  app.get(`/api/admin/${t}`, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT * FROM ${t} ORDER BY id DESC`
      );

      res.json({
        success: true,
        data: result.rows
      });
    } catch (err) {
      console.error(`❌ ${t} fetch error:`, err.message);

      res.status(500).json({
        success: false,
        message: `Failed to fetch ${t}`
      });
    }
  });
}

// PostgreSQL listing APIs for alerts, reminders, WhatsApp logs and integration logs
for (const t of [
  "alerts",
  "reminders",
  "whatsapp_logs",
  "integration_logs"
]) {
  app.get(`/api/admin/${t}`, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT * FROM ${t} ORDER BY id DESC`
      );

      res.json({
        success: true,
        data: result.rows
      });
    } catch (err) {
      console.error(`❌ ${t} fetch error:`, err.message);

      res.status(500).json({
        success: false,
        message: `Failed to fetch ${t}`
      });
    }
  });
}
// Action Panel APIs - PostgreSQL based
for (const t of ["leads", "admissions", "appointments", "support", "faculty"]) {
  app.post(`/api/admin/${t}/:id/action`, async (req, res) => {
    try {
      const id = Number(req.params.id);

      const currentResult = await pool.query(
        `SELECT * FROM ${t} WHERE id = $1`,
        [id]
      );

      if (currentResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Record not found"
        });
      }

      const item = currentResult.rows[0];

      const oldStatus = item.status;
      const oldOwner = item.owner;

      const newStatus =
        req.body.status !== undefined
          ? req.body.status
          : item.status || "new";

      const newOwner =
        req.body.owner !== undefined
          ? req.body.owner
          : item.owner || "Unassigned";

      const newPriority =
        req.body.priority !== undefined
          ? req.body.priority
          : item.priority || "cold";

      const newNote =
        req.body.note !== undefined
          ? req.body.note
          : item.note || "";

      let updatedResult;

      // Leads ke extra editable fields
      if (t === "leads") {
        const newName =
          req.body.name !== undefined
            ? req.body.name
            : item.name || "";

        const newMobile =
          req.body.mobile !== undefined
            ? cleanMobile(req.body.mobile)
            : item.mobile || "";

        const newCourse =
          req.body.course !== undefined
            ? req.body.course
            : item.course || "";

        const newNextFollowup =
  req.body.next_followup !== undefined
    ? (req.body.next_followup === ""
        ? null
        : req.body.next_followup)
    : item.next_followup;

        updatedResult = await pool.query(
          `UPDATE leads
           SET name = $1,
               mobile = $2,
               course = $3,
               status = $4,
               owner = $5,
               priority = $6,
               note = $7,
               admin_note = $8,
               next_followup = $9,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $10
           RETURNING *`,
          [
            newName,
            newMobile,
            newCourse,
            newStatus,
            newOwner,
            newPriority,
            newNote,
            newNote,
            newNextFollowup,
            id
          ]
        );
      } else {
        // Admissions / Appointments / Support / Faculty ka existing behavior
        updatedResult = await pool.query(
          `UPDATE ${t}
           SET status = $1,
               owner = $2,
               priority = $3,
               note = $4,
               admin_note = $5,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $6
           RETURNING *`,
          [
            newStatus,
            newOwner,
            newPriority,
            newNote,
            newNote,
            id
          ]
        );
      }

      const updatedItem = updatedResult.rows[0];

      // Memory copy sync
      const index = db[t].findIndex(
        (r) => Number(r.id) === id
      );

      if (index !== -1) {
        db[t][index] = {
          ...db[t][index],
          ...updatedItem
        };
      }

      // Alert
      if (req.body.sendNotification !== false) {
        await addAlert(
          `${t}_action`,
          `${t} updated`,
          {
            id: updatedItem.id,
            name: updatedItem.name,
            mobile: updatedItem.mobile,
            oldStatus,
            newStatus: updatedItem.status,
            oldOwner,
            newOwner: updatedItem.owner,
            note: updatedItem.note
          }
        );
      }

      // Reminder
      if (
        req.body.createReminder ||
        ["follow_up", "interested", "contacted"].includes(
          updatedItem.status
        )
      ) {
        await addReminder(
          t,
          updatedItem,
          Number(req.body.reminderDays || 2)
        );
      }

      // WhatsApp
      if (req.body.sendWhatsapp) {
        await whatsappLog(
          t,
          updatedItem,
          `${t}_action`
        );
      }

      res.json({
        success: true,
        message: `${t} updated`,
        data: updatedItem
      });

    } catch (err) {
      console.error(
        `❌ ${t} action error:`,
        err.message
      );

      res.status(500).json({
        success: false,
        message: `Failed to update ${t}`
      });
    }
  });
}
app.post("/api/webhook/botsailor", async (req, res) => {
  const payload = req.body || {};

  const mobile = String(payload.mobile || payload.phone || "").replace(/\D/g, "");
  const nowTime = new Date();
  const DUPLICATE_DAYS = 15;

 // Check duplicate lead from PostgreSQL within last 15 days
const duplicateResult = await pool.query(
  `SELECT *
   FROM leads
   WHERE regexp_replace(COALESCE(mobile, ''), '\\D', '', 'g') = $1
     AND created_at >= CURRENT_TIMESTAMP - INTERVAL '15 days'
   ORDER BY created_at DESC
   LIMIT 1`,
  [mobile]
);

if (duplicateResult.rows.length > 0) {
  const existingLead = duplicateResult.rows[0];

  let updatedCourse = existingLead.course;
  let updatedNote = existingLead.note || "";

  if (payload.course && payload.course !== existingLead.course) {
    updatedNote += ` | Course changed: ${existingLead.course} → ${payload.course}`;
    updatedCourse = payload.course;
  }

  updatedNote += " | Re-enquiry within 15 days";

  const updateResult = await pool.query(
    `UPDATE leads
     SET course = $1,
         status = 're-enquiry',
         note = $2,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $3
     RETURNING *`,
    [updatedCourse, updatedNote, existingLead.id]
  );

  const updatedLead = updateResult.rows[0];
// Keep memory copy in sync after duplicate update
const memoryIndex = db.leads.findIndex(
  (l) => Number(l.id) === Number(updatedLead.id)
);

if (memoryIndex !== -1) {
  db.leads[memoryIndex] = updatedLead;
} else {
  db.leads.unshift(updatedLead);
}
  return res.status(200).json({
    status: "ok",
    message: "Duplicate lead updated",
    lead: updatedLead
  });
}

// Create new lead permanently in PostgreSQL
const newLeadResult = await pool.query(
  `INSERT INTO leads
   (name, mobile, course, priority, status, owner, lead_score, lead_stage,
    next_best_action, note, created_at, updated_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
   RETURNING *`,
  [
    payload.name || "WhatsApp Lead",
    mobile,
    payload.course || "ACCA",
    "hot",
    "new",
    "Counselor 1",
    50,
    "new",
    "Call within 24 hours",
    `Source: botsailor_whatsapp | Subscriber ID: ${payload.subscriber_id || ""}`
  ]
);

const lead = newLeadResult.rows[0];

// Keep memory copy in sync
db.leads.unshift(lead);

  await sendWhatsAppMessage(
    lead.mobile,
    `Hi ${lead.name}, You’ve made a great choice! 🎯`
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

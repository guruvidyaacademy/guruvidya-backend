import express from "express";
import cors from "cors";
import axios from "axios";
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const INDIA_TZ = "Asia/Kolkata";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let counters = {
  leads: 1,
  admissions: 1,
  appointments: 1,
  support: 1,
  faculty: 1,
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
  integration_logs: [],
};

const DEFAULT_CONFIG = {
  autoAssign: true,

  whatsappEnabled: false,
  botsailorApiUrl: "https://botsailor.com/api/v1/whatsapp/send",
  botsailorToken: "",
  botsailorInstanceId: "",
  botsailorTemplateId: "",

  // CRM WhatsApp automation
  whatsappAutoFollowupEnabled: true,
  automationCheckMinutes: 5,
  quietHoursStart: 0,
  quietHoursEnd: 9,
  minimumAutoMessageGapHours: 3,

  followup3Enabled: true,
  followup3Hours: 3,
  followup3UseCallButton: true,
  followup3Message:
    "Hi {{name}},\n\nHope you have checked the details for {{course}}.\n\nDo you need any assistance regarding admission?",

  followup6Enabled: true,
  followup6Hours: 6,
  followup6UseCallButton: true,
  followup6Message:
    "Hi {{name}},\n\nNeed any help regarding your {{course}} admission?\n\nOur Admission Counsellor can assist you with your admission queries.",

  followup9Enabled: true,
  followup9Hours: 9,
  followup9UseCallButton: false,
  followup9Message:
    "Hi {{name}},\n\nAre you planning to proceed with your {{course}} admission?\n\nIf you need any assistance before taking your decision, our Admission Team is available to help you.",

  windowClosingEnabled: true,
  windowClosingHoursBefore: 3,
  windowClosingMessage:
    "Hi {{name}}, do you need any assistance regarding your {{course}} enquiry?\n\nPlease reply YES if you would like our admission counsellor to assist you.\n\nOur counsellor will contact you during working hours (9:00 AM onwards).\n\nGuruvidya Academy",

  // Existing BotSailor flow to be triggered after CRM Call for Admission button click.
  callForAdmissionFlowUniqueId: "",

  razorpayEnabled: false,
  razorpayKeyId: "",
  razorpayKeySecret: "",

  youtubeEnabled: false,
  youtubeApiKey: "",

  myoperatorEnabled: false,
  myoperatorApiKey: "",

  aiEnabled: false,
  aiProvider: "OpenAI",
  aiApiKey: "",
  aiMode: "assist",

  followupDays: [2, 3, 5],
  counselors: ["Counselor 1", "Counselor 2", "Reception"],
  nextCounselorIndex: 0,
};

let config = { ...DEFAULT_CONFIG };
let automationRunning = false;

const nowSql = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const nextId = (t) => counters[t]++;

function cleanMobile(v = "") {
  return String(v || "").replace(/\D/g, "");
}

function normalize(v = "") {
  return String(v || "").trim().toLowerCase();
}

function renderMessage(template, record = {}) {
  return String(template || "")
    .replaceAll("{{name}}", record.name || "Student")
    .replaceAll("{{course}}", record.course || "your course")
    .replaceAll("{{mobile}}", record.mobile || "")
    .replaceAll("{{owner}}", record.owner || "Admission Team");
}

function indiaHour(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: INDIA_TZ,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === "hour")?.value || 0);
  return h === 24 ? 0 : h;
}

function isQuietHours(date = new Date()) {
  const start = Number(config.quietHoursStart ?? 0);
  const end = Number(config.quietHoursEnd ?? 9);
  const h = indiaHour(date);

  if (start === end) return false;
  if (start < end) return h >= start && h < end;
  return h >= start || h < end;
}

function isConvertedOrClosed(status = "") {
  return ["converted", "closed", "not_interested"].includes(normalize(status));
}

function hasOpenWhatsappWindow(record, at = new Date()) {
  if (!record?.last_customer_message_at) return false;
  const last = new Date(record.last_customer_message_at);
  if (Number.isNaN(last.getTime())) return false;
  const diff = at.getTime() - last.getTime();
  return diff >= 0 && diff < DAY;
}

function hoursUntilWindowClose(record, at = new Date()) {
  if (!record?.last_customer_message_at) return null;
  const last = new Date(record.last_customer_message_at);
  if (Number.isNaN(last.getTime())) return null;
  return (last.getTime() + DAY - at.getTime()) / HOUR;
}

function findDuplicate(table, mobile, extraCheck = null) {
  const cm = cleanMobile(mobile);
  return db[table]?.find((r) => {
    if (cleanMobile(r.mobile) !== cm) return false;
    if (extraCheck && !extraCheck(r)) return false;
    return true;
  });
}

function calcPriority(p) {
  const txt = `${p.course || ""} ${p.issue || ""} ${p.note || ""} ${p.description || ""}`.toLowerCase();
  if (txt.includes("acca") || txt.includes("urgent") || txt.includes("payment")) return "hot";
  if (txt.includes("ca") || txt.includes("cma") || txt.includes("call")) return "warm";
  return "cold";
}

function autoOwner() {
  if (!config.autoAssign || !config.counselors?.length) return "Unassigned";
  const owner = config.counselors[config.nextCounselorIndex % config.counselors.length];
  config.nextCounselorIndex += 1;
  return owner;
}

async function initDatabase() {
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

    CREATE TABLE IF NOT EXISTS integration_settings (
      id INTEGER PRIMARY KEY,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS whatsapp_templates (
      id SERIAL PRIMARY KEY,
      botsailor_id TEXT UNIQUE NOT NULL,
      meta_template_id TEXT,
      template_name TEXT,
      locale TEXT,
      status TEXT,
      body_content TEXT,
      variable_map JSONB DEFAULT '{}'::jsonb,
      raw JSONB DEFAULT '{}'::jsonb,
      imported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS botsailor_flows (
      id SERIAL PRIMARY KEY,
      botsailor_id TEXT,
      name TEXT,
      unique_id TEXT UNIQUE NOT NULL,
      status TEXT,
      raw JSONB DEFAULT '{}'::jsonb,
      imported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS source TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_customer_message_at TIMESTAMP;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS automation_started_at TIMESTAMP;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup_3h_sent_at TIMESTAMP;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup_6h_sent_at TIMESTAMP;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup_9h_sent_at TIMESTAMP;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS window_closing_sent_at TIMESTAMP;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_auto_message_at TIMESTAMP;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS automation_paused BOOLEAN DEFAULT FALSE;
  `);

  console.log("✅ PostgreSQL tables + automation fields ready");
}

async function loadPersistedConfig() {
  try {
    const result = await pool.query("SELECT config FROM integration_settings WHERE id = 1");
    if (result.rows.length) {
      config = { ...DEFAULT_CONFIG, ...result.rows[0].config };
    } else {
      config = { ...DEFAULT_CONFIG };
    }
  } catch (err) {
    console.error("❌ Config load error:", err.message);
    config = { ...DEFAULT_CONFIG };
  }
  return config;
}

async function savePersistedConfig(patch = {}) {
  config = { ...config, ...patch };
  await pool.query(
    `INSERT INTO integration_settings (id, config, updated_at)
     VALUES (1, $1::jsonb, CURRENT_TIMESTAMP)
     ON CONFLICT (id)
     DO UPDATE SET config = EXCLUDED.config, updated_at = CURRENT_TIMESTAMP`,
    [JSON.stringify(config)]
  );
  return config;
}

async function addAlert(type, title, payload = {}) {
  const result = await pool.query(
    `INSERT INTO alerts (type, title, payload, created_at)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
     RETURNING *`,
    [type, title, JSON.stringify(payload)]
  );
  const item = result.rows[0];
  db.alerts.unshift(item);
  return item;
}

async function addIntegrationLog(channel, action, status, payload = {}, response = {}) {
  const result = await pool.query(
    `INSERT INTO integration_logs
     (channel, action, status, payload, response, created_at)
     VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
     RETURNING *`,
    [channel, action, status, JSON.stringify(payload), JSON.stringify(response)]
  );
  const item = result.rows[0];
  db.integration_logs.unshift(item);
  return item;
}

async function addReminder(table, record, days = 2, reason = "follow_up") {
  const due = new Date(Date.now() + Number(days || 2) * DAY).toISOString().slice(0, 10);
  const result = await pool.query(
    `INSERT INTO reminders
     (table_name, record_id, name, mobile, owner, reason, due_date, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', CURRENT_TIMESTAMP)
     RETURNING *`,
    [
      table,
      record.id,
      record.name || "",
      record.mobile || "",
      record.owner || "Unassigned",
      reason,
      due,
    ]
  );
  const item = result.rows[0];
  db.reminders.unshift(item);
  await addAlert("followup_reminder", "Follow-up reminder created", item);
  return item;
}

async function botSailorPost(url, fields = {}) {
  if (!config.botsailorToken || !config.botsailorInstanceId) {
    return {
      success: false,
      status: "missing_config",
      message: "BotSailor token or Phone Number ID missing",
      response: {},
    };
  }

  const formData = new URLSearchParams();
  Object.entries(fields).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      formData.append(key, typeof value === "string" ? value : JSON.stringify(value));
    }
  });

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: formData.toString(),
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    const success = response.ok && (String(data?.status) === "1" || data?.success === true);
    return {
      success,
      status: success ? "sent" : "failed",
      response: data,
      httpStatus: response.status,
      message: data?.message || (success ? "Success" : "BotSailor request failed"),
    };
  } catch (err) {
    return {
      success: false,
      status: "failed",
      message: err.message,
      error: err.message,
      response: {},
    };
  }
}

async function sendBotSailorText(record, message, action = "send_message") {
  if (!config.whatsappEnabled) {
    return { success: false, status: "disabled", message: "WhatsApp disabled" };
  }

  const finalMessage = renderMessage(message, record);
  const apiUrl = config.botsailorApiUrl || "https://botsailor.com/api/v1/whatsapp/send";
  const payload = {
    apiToken: config.botsailorToken,
    phone_number_id: config.botsailorInstanceId,
    phone_number: cleanMobile(record.mobile || ""),
    message: finalMessage,
  };

  const result = await botSailorPost(apiUrl, payload);
  await addIntegrationLog("whatsapp", action, result.success ? "success" : "failed", {
    phone_number_id: config.botsailorInstanceId,
    phone_number: payload.phone_number,
    message: finalMessage,
  }, result.response || { error: result.error || result.message });

  console.log("BotSailor Text:", result.status, result.response || result.message);
  return { ...result, messageText: finalMessage };
}

async function sendBotSailorInteractiveCall(record, message, action = "send_interactive_call") {
  if (!config.whatsappEnabled) {
    return { success: false, status: "disabled", message: "WhatsApp disabled" };
  }

  const finalMessage = renderMessage(message, record);
  const payload = {
    apiToken: config.botsailorToken,
    phone_number_id: config.botsailorInstanceId,
    phone_number: cleanMobile(record.mobile || ""),
    message: finalMessage,
    buttons: JSON.stringify([{ id: "crm_call_for_admission", title: "Call for Admission" }]),
    button_footer_text: "Guruvidya Academy",
  };

  const result = await botSailorPost(
    "https://botsailor.com/api/v1/whatsapp/send/interactive-buttons",
    payload
  );

  await addIntegrationLog("whatsapp", action, result.success ? "success" : "failed", {
    phone_number_id: config.botsailorInstanceId,
    phone_number: payload.phone_number,
    message: finalMessage,
    buttons: [{ id: "crm_call_for_admission", title: "Call for Admission" }],
  }, result.response || { error: result.error || result.message });

  return { ...result, messageText: finalMessage };
}

async function triggerBotSailorFlow(phone, uniqueId) {
  if (!uniqueId) {
    return { success: false, status: "missing_flow", message: "Call for Admission flow not selected" };
  }

  const payload = {
    apiToken: config.botsailorToken,
    phone_number_id: config.botsailorInstanceId,
    bot_flow_unique_id: uniqueId,
    phone_number: cleanMobile(phone),
  };

  const result = await botSailorPost("https://botsailor.com/api/v1/whatsapp/trigger-bot", payload);
  await addIntegrationLog(
    "whatsapp",
    "trigger_bot_flow",
    result.success ? "success" : "failed",
    { ...payload, apiToken: "***" },
    result.response || { error: result.error || result.message }
  );
  return result;
}

async function sendBotSailorTemplate(record, templateRecord, variables = {}) {
  if (!config.whatsappEnabled) {
    return { success: false, status: "disabled", message: "WhatsApp disabled" };
  }
  if (!templateRecord?.botsailor_id) {
    return { success: false, status: "missing_template", message: "Template not found" };
  }

  // BotSailor's generated template endpoint uses botTemplateID + phoneNumberID.
  // Extra variable keys can be passed exactly as generated by BotSailor, e.g. templateVariable-Name-1.
  const fields = {
    apiToken: config.botsailorToken,
    phoneNumberID: config.botsailorInstanceId,
    botTemplateID: templateRecord.botsailor_id,
    sendToPhoneNumber: cleanMobile(record.mobile || ""),
    ...variables,
  };

  const result = await botSailorPost("https://botsailor.com/api/v1/whatsapp/send/template", fields);
  await addIntegrationLog(
    "whatsapp",
    "send_template",
    result.success ? "success" : "failed",
    {
      phone: cleanMobile(record.mobile || ""),
      template: templateRecord.template_name,
      botTemplateID: templateRecord.botsailor_id,
      variables,
    },
    result.response || { error: result.error || result.message }
  );

  return {
    ...result,
    messageText: templateRecord.body_content || templateRecord.template_name || "Template message",
  };
}

async function logWhatsAppSend(table, record, label, result) {
  const pgResult = await pool.query(
    `INSERT INTO whatsapp_logs
     (table_name, record_id, mobile, template, status, message, response, error, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
     RETURNING *`,
    [
      table,
      record.id,
      record.mobile || "",
      label,
      result?.status || "failed",
      result?.messageText || result?.message || "",
      JSON.stringify(result?.response || {}),
      result?.error || (result?.success === false ? result?.message || "Send failed" : ""),
    ]
  );

  const item = pgResult.rows[0];
  db.whatsapp_logs.unshift(item);
  await addAlert("whatsapp_trigger", "WhatsApp trigger processed", item);
  return item;
}

async function sendAndLogText(table, record, label, message, useCallButton = false) {
  const result = useCallButton
    ? await sendBotSailorInteractiveCall(record, message, label)
    : await sendBotSailorText(record, message, label);
  await logWhatsAppSend(table, record, label, result);
  return result;
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
    created_at: nowSql(),
  };

  if (table === "leads") {
    const pgResult = await pool.query(
      `INSERT INTO leads
       (name, mobile, course, priority, status, owner, note, admin_note,
        lead_score, lead_stage, next_best_action, enquiry_count, next_followup,
        last_enquiry_at, source, last_customer_message_at, automation_started_at, created_at, updated_at)
       VALUES
       ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,CURRENT_TIMESTAMP)
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
        record.source || "",
        record.last_customer_message_at || null,
        record.automation_started_at || record.created_at,
        record.created_at,
      ]
    );
    Object.assign(record, pgResult.rows[0]);
  }

  if (["admissions", "appointments", "support", "faculty"].includes(table)) {
    const columnsByTable = {
      admissions: ["name", "mobile", "email", "course", "priority", "status", "owner", "note", "admin_note"],
      appointments: ["name", "mobile", "course", "datetime", "priority", "status", "owner", "note", "admin_note"],
      support: ["name", "mobile", "issue", "description", "priority", "status", "owner", "note", "admin_note"],
      faculty: ["name", "mobile", "course", "mode", "priority", "status", "owner", "note", "admin_note"],
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
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}) RETURNING *`,
      values
    );
    Object.assign(record, pgResult.rows[0]);
  }

  db[table].unshift(record);
  await addAlert(`${table}_created`, `New ${table} received`, {
    id: record.id,
    name: record.name,
    mobile: record.mobile,
    owner: record.owner,
    priority: record.priority,
  });

  if (["leads", "admissions", "appointments"].includes(table)) {
    await addReminder(table, record, config.followupDays?.[0] || 2);
  }

  // IMPORTANT: no immediate CRM WhatsApp here.
  // Lead follow-up is controlled only by the 3h/6h/9h automation or counselor manual send.
  return record;
}

async function insertUnique(table, payload, options = {}) {
  const mobile = cleanMobile(payload.mobile || payload.phone || payload.whatsapp || "");

  if (table === "leads" && mobile) {
    const duplicateResult = await pool.query(
      `SELECT * FROM leads
       WHERE regexp_replace(COALESCE(mobile, ''), '\\D', '', 'g') = $1
         AND created_at >= CURRENT_TIMESTAMP - INTERVAL '15 days'
       ORDER BY created_at DESC
       LIMIT 1`,
      [mobile]
    );

    if (duplicateResult.rows.length) {
      const existingLead = duplicateResult.rows[0];
      let updatedCourse = existingLead.course;
      let updatedNote = existingLead.note || "";

      if (payload.course && payload.course !== existingLead.course) {
        updatedNote += ` | Course changed: ${existingLead.course || ""} → ${payload.course}`;
        updatedCourse = payload.course;
      }
      updatedNote += " | Re-enquiry within 15 days";

      const newEnquiryCount = Number(existingLead.enquiry_count || 1) + 1;
      const newLeadScore = Number(existingLead.lead_score || 50) + 10;
      const newPriority = newEnquiryCount >= 3 ? "very hot" : existingLead.priority || "hot";
      const newStatus = newEnquiryCount >= 3 ? "very_hot" : options.duplicateStatus || "re-enquiry";
      const nextFollowup = new Date(Date.now() + DAY);

      const updateResult = await pool.query(
        `UPDATE leads
         SET course = $1,
             status = $2,
             priority = $3,
             note = $4,
             enquiry_count = $5,
             lead_score = $6,
             last_enquiry_at = CURRENT_TIMESTAMP,
             next_followup = $7,
             next_best_action = $8,
             source = COALESCE(NULLIF($9, ''), source),
             automation_started_at = CURRENT_TIMESTAMP,
             followup_3h_sent_at = NULL,
             followup_6h_sent_at = NULL,
             followup_9h_sent_at = NULL,
             window_closing_sent_at = NULL,
             last_auto_message_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $10
         RETURNING *`,
        [
          updatedCourse,
          newStatus,
          newPriority,
          updatedNote,
          newEnquiryCount,
          newLeadScore,
          nextFollowup,
          newEnquiryCount >= 3 ? "Call immediately - very high intent" : "Call again - re-enquiry",
          payload.source || "",
          existingLead.id,
        ]
      );

      const updatedLead = updateResult.rows[0];
      const memoryIndex = db.leads.findIndex((l) => Number(l.id) === Number(updatedLead.id));
      if (memoryIndex !== -1) db.leads[memoryIndex] = updatedLead;
      else db.leads.unshift(updatedLead);
      return updatedLead;
    }
  }

  const duplicate = findDuplicate(table, mobile, options.extraCheck);
  if (duplicate) {
    duplicate.updated_at = nowSql();
    if (payload.course && payload.course !== duplicate.course) {
      duplicate.note = (duplicate.note || "") + ` | Course changed: ${duplicate.course || ""} → ${payload.course}`;
      duplicate.course = payload.course;
    }
    if (payload.issue) duplicate.issue = payload.issue;
    if (payload.description) duplicate.description = payload.description;
    if (payload.mode) duplicate.mode = payload.mode;
    duplicate.status = options.duplicateStatus || "re-enquiry";
    return duplicate;
  }

  return insert(table, { ...payload, mobile });
}

async function importBotSailorTemplates() {
  const result = await botSailorPost("https://botsailor.com/api/v1/whatsapp/get/template/list", {
    apiToken: config.botsailorToken,
    phone_number_id: config.botsailorInstanceId,
  });

  if (!result.success) return result;

  const rawMessage = result.response?.message;
  const list = Array.isArray(rawMessage) ? rawMessage : rawMessage && typeof rawMessage === "object" ? [rawMessage] : [];

  let imported = 0;
  for (const item of list) {
    if (!item?.id) continue;
    let variableMap = {};
    try {
      variableMap = typeof item.variable_map === "string" ? JSON.parse(item.variable_map) : item.variable_map || {};
    } catch {
      variableMap = {};
    }

    await pool.query(
      `INSERT INTO whatsapp_templates
       (botsailor_id, meta_template_id, template_name, locale, status, body_content, variable_map, raw, imported_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP)
       ON CONFLICT (botsailor_id)
       DO UPDATE SET
         meta_template_id = EXCLUDED.meta_template_id,
         template_name = EXCLUDED.template_name,
         locale = EXCLUDED.locale,
         status = EXCLUDED.status,
         body_content = EXCLUDED.body_content,
         variable_map = EXCLUDED.variable_map,
         raw = EXCLUDED.raw,
         imported_at = CURRENT_TIMESTAMP`,
      [
        String(item.id),
        String(item.template_id || ""),
        item.template_name || item.name || `Template ${item.id}`,
        item.locale || "",
        item.status || "",
        item.body_content || "",
        JSON.stringify(variableMap),
        JSON.stringify(item),
      ]
    );
    imported += 1;
  }

  return { success: true, status: "imported", imported, response: result.response };
}

async function importBotSailorFlows() {
  const result = await botSailorPost("https://botsailor.com/api/v1/whatsapp/get/bot-flow-list", {
    apiToken: config.botsailorToken,
    phone_number_id: config.botsailorInstanceId,
  });

  if (!result.success) return result;
  const list = Array.isArray(result.response?.message) ? result.response.message : [];
  let imported = 0;

  for (const item of list) {
    if (!item?.unique_id) continue;
    await pool.query(
      `INSERT INTO botsailor_flows
       (botsailor_id, name, unique_id, status, raw, imported_at)
       VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)
       ON CONFLICT (unique_id)
       DO UPDATE SET
         botsailor_id = EXCLUDED.botsailor_id,
         name = EXCLUDED.name,
         status = EXCLUDED.status,
         raw = EXCLUDED.raw,
         imported_at = CURRENT_TIMESTAMP`,
      [String(item.id || ""), item.name || "Bot Flow", String(item.unique_id), String(item.status ?? ""), JSON.stringify(item)]
    );
    imported += 1;
  }

  return { success: true, status: "imported", imported, response: result.response };
}

async function runFollowupAutomation() {
  if (automationRunning) return { skipped: true, reason: "already_running" };
  automationRunning = true;

  const summary = { checked: 0, sent: 0, failed: 0, skipped: 0 };
  try {
    await loadPersistedConfig();

    if (!config.whatsappEnabled || !config.whatsappAutoFollowupEnabled) {
      return { ...summary, skipped: 1, reason: "automation_disabled" };
    }

    const result = await pool.query(
      `SELECT * FROM leads
       WHERE last_customer_message_at IS NOT NULL
         AND COALESCE(automation_paused, FALSE) = FALSE
         AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('converted','closed','not_interested')
       ORDER BY id ASC`
    );

    const current = new Date();
    const quiet = isQuietHours(current);
    const minimumGapMs = Math.max(0, Number(config.minimumAutoMessageGapHours || 3)) * HOUR;

    for (const lead of result.rows) {
      summary.checked += 1;
      if (!hasOpenWhatsappWindow(lead, current)) {
        summary.skipped += 1;
        continue;
      }

      const remaining = hoursUntilWindowClose(lead, current);

      // Special exception: final YES message can go during quiet hours.
      if (
        config.windowClosingEnabled &&
        !lead.window_closing_sent_at &&
        remaining !== null &&
        remaining > 0 &&
        remaining <= Number(config.windowClosingHoursBefore || 3)
      ) {
        const sendResult = await sendAndLogText(
          "leads",
          lead,
          "window_closing",
          config.windowClosingMessage,
          false
        );

        if (sendResult.success) {
          await pool.query(
            `UPDATE leads
             SET window_closing_sent_at = CURRENT_TIMESTAMP,
                 last_auto_message_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [lead.id]
          );
          summary.sent += 1;
        } else {
          summary.failed += 1;
        }
        continue;
      }

      if (quiet) {
        summary.skipped += 1;
        continue;
      }

      const start = new Date(lead.automation_started_at || lead.created_at);
      if (Number.isNaN(start.getTime())) {
        summary.skipped += 1;
        continue;
      }
      const elapsedHours = (current.getTime() - start.getTime()) / HOUR;

      if (lead.last_auto_message_at) {
        const lastAuto = new Date(lead.last_auto_message_at);
        if (!Number.isNaN(lastAuto.getTime()) && current.getTime() - lastAuto.getTime() < minimumGapMs) {
          summary.skipped += 1;
          continue;
        }
      }

      let stage = null;
      if (config.followup3Enabled && !lead.followup_3h_sent_at && elapsedHours >= Number(config.followup3Hours || 3)) {
        stage = {
          column: "followup_3h_sent_at",
          label: "followup_3h",
          message: config.followup3Message,
          callButton: Boolean(config.followup3UseCallButton),
        };
      } else if (config.followup6Enabled && !lead.followup_6h_sent_at && elapsedHours >= Number(config.followup6Hours || 6)) {
        stage = {
          column: "followup_6h_sent_at",
          label: "followup_6h",
          message: config.followup6Message,
          callButton: Boolean(config.followup6UseCallButton),
        };
      } else if (config.followup9Enabled && !lead.followup_9h_sent_at && elapsedHours >= Number(config.followup9Hours || 9)) {
        stage = {
          column: "followup_9h_sent_at",
          label: "followup_9h",
          message: config.followup9Message,
          callButton: Boolean(config.followup9UseCallButton),
        };
      }

      if (!stage) {
        summary.skipped += 1;
        continue;
      }

      const sendResult = await sendAndLogText(
        "leads",
        lead,
        stage.label,
        stage.message,
        stage.callButton
      );

      if (sendResult.success) {
        await pool.query(
          `UPDATE leads
           SET ${stage.column} = CURRENT_TIMESTAMP,
               last_auto_message_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [lead.id]
        );
        summary.sent += 1;
      } else {
        summary.failed += 1;
      }
    }

    return summary;
  } catch (err) {
    console.error("❌ Follow-up automation error:", err.message);
    return { ...summary, error: err.message };
  } finally {
    automationRunning = false;
  }
}

app.get("/health", (req, res) =>
  res.json({ success: true, message: "OK", phase: "3", module: "whatsapp_automation" })
);

// ---------- ADMIN CONFIG ----------
app.get("/api/admin/config", async (req, res) => {
  try {
    await loadPersistedConfig();
    res.json({ success: true, data: config });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/admin/config", async (req, res) => {
  try {
    const saved = await savePersistedConfig(req.body || {});
    await addAlert("config_updated", "Automation config updated", req.body || {});
    res.json({ success: true, message: "Automation settings saved permanently", data: saved });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to save automation settings" });
  }
});

app.post("/api/admin/automation/run-now", async (req, res) => {
  const result = await runFollowupAutomation();
  res.json({ success: !result.error, data: result });
});

app.post("/api/admin/automation/test-mobile", async (req, res) => {
  try {
    await loadPersistedConfig();

    const mobile = cleanMobile(req.body?.mobile || "");
    const stage = String(req.body?.stage || "3h").trim().toLowerCase();

    if (!mobile || mobile.length < 10) {
      return res.status(400).json({ success: false, message: "Valid test mobile number required" });
    }
    if (!config.whatsappEnabled) {
      return res.status(400).json({ success: false, message: "WhatsApp is disabled in Integration Panel" });
    }

    const testRecord = {
      id: 0,
      name: String(req.body?.name || "Test Student").trim() || "Test Student",
      mobile,
      course: String(req.body?.course || "ACCA Complete Course").trim() || "ACCA Complete Course",
      owner: "Test Only"
    };

    let label = "test_followup_3h";
    let message = config.followup3Message;
    let useCallButton = Boolean(config.followup3UseCallButton);

    if (stage === "6h") {
      label = "test_followup_6h";
      message = config.followup6Message;
      useCallButton = Boolean(config.followup6UseCallButton);
    } else if (stage === "9h") {
      label = "test_followup_9h";
      message = config.followup9Message;
      useCallButton = Boolean(config.followup9UseCallButton);
    } else if (stage === "window") {
      label = "test_window_closing";
      message = config.windowClosingMessage;
      useCallButton = false;
    }

    const result = await sendAndLogText("automation_test", testRecord, label, message, useCallButton);

    return res.status(result.success ? 200 : 400).json({
      success: Boolean(result.success),
      message: result.success ? "Test WhatsApp sent successfully" : (result.message || "Test send failed"),
      data: { mobile, stage, usedCallButton: useCallButton, response: result.response || null }
    });
  } catch (err) {
    console.error("❌ Test-only WhatsApp error:", err.message);
    return res.status(500).json({ success: false, message: err.message || "Test send failed" });
  }
});

app.get("/api/admin/pipeline", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM leads ORDER BY id DESC");
    const leads = result.rows;
    const today = new Date().toISOString().slice(0, 10);
    const isToday = (value) => {
      if (!value) return false;
      const d = new Date(value);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === today;
    };

    const converted = leads.filter((l) => normalize(l.status) === "converted");
    const reEnquiry = leads.filter((l) => normalize(l.status) === "re-enquiry" && normalize(l.priority) !== "very hot");
    const followupToday = leads.filter((l) => isToday(l.next_followup) && !["converted", "re-enquiry"].includes(normalize(l.status)));
    const noResponse = leads.filter((l) => normalize(l.status) === "no_response" && !isToday(l.next_followup));
    const excluded = ["converted", "re-enquiry", "no_response", "not_interested", "closed"];
    const veryHotLeads = leads.filter((l) => normalize(l.priority) === "very hot" && !excluded.includes(normalize(l.status)) && !isToday(l.next_followup));
    const hotLeads = leads.filter((l) => normalize(l.priority) === "hot" && !excluded.includes(normalize(l.status)) && !isToday(l.next_followup));
    const newLeads = leads.filter((l) => (normalize(l.lead_stage) === "new" || normalize(l.status) === "new") && !excluded.includes(normalize(l.status)) && !isToday(l.next_followup));

    res.json({
      success: true,
      data: {
        new_leads: newLeads,
        hot_leads: hotLeads,
        very_hot_leads: veryHotLeads,
        re_enquiry: reEnquiry,
        followup_today: followupToday,
        no_response: noResponse,
        converted,
      },
    });
  } catch (err) {
    console.error("❌ Pipeline fetch error:", err.message);
    res.status(500).json({ success: false, message: "Failed to fetch pipeline" });
  }
});

// ---------- INTEGRATION PANEL ----------
app.get("/api/admin/integrations", async (req, res) => {
  try {
    await loadPersistedConfig();
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
        aiMode: config.aiMode,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to load integration settings" });
  }
});

app.post("/api/admin/integrations", async (req, res) => {
  try {
    const saved = await savePersistedConfig(req.body || {});
    await addAlert("integration_updated", "Integration settings updated", req.body || {});
    await addIntegrationLog("settings", "save", "success", req.body || {}, { message: "Settings saved permanently" });
    res.json({ success: true, message: "Integration settings saved", data: saved });
  } catch (err) {
    console.error("❌ Integration settings save error:", err.message);
    res.status(500).json({ success: false, message: "Failed to save integration settings" });
  }
});

app.post("/api/admin/integrations/botsailor/test", async (req, res) => {
  const testRecord = {
    name: req.body.name || "Test Student",
    mobile: req.body.mobile || req.body.phone || "",
    course: req.body.course || "ACCA",
    status: "test",
    owner: "Admin",
  };
  const result = await sendBotSailorText(testRecord, "Guruvidya WhatsApp API test successful.", "test_connection");
  res.json({
    success: result.success,
    message: result.success ? "BotSailor test successful" : "BotSailor test failed",
    data: result,
  });
});

app.post("/api/admin/botsailor/templates/import", async (req, res) => {
  const result = await importBotSailorTemplates();
  res.status(result.success ? 200 : 400).json({
    success: result.success,
    message: result.success ? `${result.imported} template(s) imported` : result.message,
    data: result,
  });
});

app.get("/api/admin/botsailor/templates", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM whatsapp_templates ORDER BY imported_at DESC, template_name ASC");
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to load templates" });
  }
});

app.post("/api/admin/botsailor/flows/import", async (req, res) => {
  const result = await importBotSailorFlows();
  res.status(result.success ? 200 : 400).json({
    success: result.success,
    message: result.success ? `${result.imported} bot flow(s) imported` : result.message,
    data: result,
  });
});

app.get("/api/admin/botsailor/flows", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM botsailor_flows ORDER BY imported_at DESC, name ASC");
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to load bot flows" });
  }
});

app.get("/api/admin/integration-logs", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM integration_logs ORDER BY id DESC");
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch integration logs" });
  }
});

// ---------- COUNSELOR STATS ----------
app.get("/api/admin/counselor-stats", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT owner, priority, status FROM leads
      UNION ALL SELECT owner, priority, status FROM admissions
      UNION ALL SELECT owner, priority, status FROM appointments
      UNION ALL SELECT owner, priority, status FROM support
      UNION ALL SELECT owner, priority, status FROM faculty
    `);

    const all = result.rows;
    const names = Array.from(new Set([...(config.counselors || []), "Unassigned", ...all.map((r) => r.owner || "Unassigned")]));
    const data = names.map((owner) => {
      const rows = all.filter((r) => (r.owner || "Unassigned") === owner);
      return {
        owner,
        total: rows.length,
        hot: rows.filter((r) => normalize(r.priority) === "hot").length,
        warm: rows.filter((r) => normalize(r.priority) === "warm").length,
        cold: rows.filter((r) => normalize(r.priority) === "cold").length,
        converted: rows.filter((r) => ["converted", "completed", "resolved", "selected"].includes(normalize(r.status))).length,
        follow_up: rows.filter((r) => ["follow_up", "contacted", "interested", "confirmed", "in_progress"].includes(normalize(r.status))).length,
      };
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch counselor stats" });
  }
});

// ---------- PUBLIC WEBSITE APIS ----------
app.post("/api/public/enquiry", async (req, res) => {
  try {
    const data = await insertUnique("leads", {
      name: req.body.name || "",
      mobile: req.body.mobile || req.body.phone || req.body.whatsapp || "",
      course: req.body.course || "",
      note: req.body.note || "",
      source: "website_enquiry",
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/public/admission-enquiry", async (req, res) => {
  try {
    const name = req.body.name || "";
    const mobile = req.body.mobile || req.body.phone || req.body.whatsapp || "";
    const email = req.body.email || "";
    const course = req.body.course || "";
    const note = req.body.note || "";

    const lead = await insertUnique("leads", {
      name,
      mobile,
      course,
      note: note ? `${note} | Source: admission_enquiry` : "Source: admission_enquiry",
      source: "admission_enquiry",
    });

    const admission = await insertUnique("admissions", { name, mobile, email, course, note });
    res.json({ success: true, data: admission, lead });
  } catch (err) {
    console.error("❌ Admission enquiry error:", err.message);
    res.status(500).json({ success: false, message: "Failed to process admission enquiry" });
  }
});

app.post("/api/public/appointment-request", async (req, res) => {
  try {
    const name = req.body.name || "";
    const mobile = req.body.mobile || req.body.phone || req.body.whatsapp || "";
    const course = req.body.course || "";
    const datetime = req.body.datetime || req.body.date || "";
    const note = req.body.note || "";

    const lead = await insertUnique("leads", {
      name,
      mobile,
      course,
      note: note ? `${note} | Source: appointment_request` : "Source: appointment_request",
      source: "appointment_request",
    });
    const appointment = await insertUnique("appointments", { name, mobile, course, datetime, note });
    res.json({ success: true, data: appointment, lead });
  } catch (err) {
    console.error("❌ Appointment request error:", err.message);
    res.status(500).json({ success: false, message: "Failed to process appointment request" });
  }
});

app.post("/api/public/support-request", async (req, res) => {
  try {
    const data = await insertUnique("support", {
      name: req.body.name || "",
      mobile: req.body.mobile || req.body.phone || "",
      issue: req.body.issue || "",
      description: req.body.description || req.body.message || "",
      owner: req.body.owner || "Technical",
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/public/faculty-interest", async (req, res) => {
  try {
    const data = await insertUnique("faculty", {
      name: req.body.name || "",
      mobile: req.body.mobile || req.body.phone || "",
      course: req.body.course || "",
      mode: req.body.mode || "",
      owner: req.body.owner || "HR",
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------- ADMIN LISTING ----------
app.get("/api/admin/leads", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM leads ORDER BY id DESC");
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch leads" });
  }
});

for (const t of ["admissions", "appointments", "support", "faculty"]) {
  app.get(`/api/admin/${t}`, async (req, res) => {
    try {
      const result = await pool.query(`SELECT * FROM ${t} ORDER BY id DESC`);
      res.json({ success: true, data: result.rows });
    } catch (err) {
      res.status(500).json({ success: false, message: `Failed to fetch ${t}` });
    }
  });
}

for (const t of ["alerts", "reminders", "whatsapp_logs", "integration_logs"]) {
  app.get(`/api/admin/${t}`, async (req, res) => {
    try {
      const result = await pool.query(`SELECT * FROM ${t} ORDER BY id DESC`);
      res.json({ success: true, data: result.rows });
    } catch (err) {
      res.status(500).json({ success: false, message: `Failed to fetch ${t}` });
    }
  });
}

// ---------- ACTION PANEL ----------
for (const t of ["leads", "admissions", "appointments", "support", "faculty"]) {
  app.post(`/api/admin/${t}/:id/action`, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const currentResult = await pool.query(`SELECT * FROM ${t} WHERE id = $1`, [id]);
      if (!currentResult.rows.length) {
        return res.status(404).json({ success: false, message: "Record not found" });
      }

      const item = currentResult.rows[0];
      const oldStatus = item.status;
      const oldOwner = item.owner;
      const newStatus = req.body.status !== undefined ? req.body.status : item.status || "new";
      const newOwner = req.body.owner !== undefined ? req.body.owner : item.owner || "Unassigned";
      const newPriority = req.body.priority !== undefined ? req.body.priority : item.priority || "cold";
      const newNote = req.body.note !== undefined ? req.body.note : item.note || "";

      let updatedResult;
      if (t === "leads") {
        const newName = req.body.name !== undefined ? req.body.name : item.name || "";
        const newMobile = req.body.mobile !== undefined ? cleanMobile(req.body.mobile) : item.mobile || "";
        const newCourse = req.body.course !== undefined ? req.body.course : item.course || "";
        const newNextFollowup = req.body.next_followup !== undefined
          ? req.body.next_followup === "" ? null : req.body.next_followup
          : item.next_followup;

        updatedResult = await pool.query(
          `UPDATE leads
           SET name=$1, mobile=$2, course=$3, status=$4, owner=$5, priority=$6,
               note=$7, admin_note=$8, next_followup=$9, updated_at=CURRENT_TIMESTAMP
           WHERE id=$10 RETURNING *`,
          [newName, newMobile, newCourse, newStatus, newOwner, newPriority, newNote, newNote, newNextFollowup, id]
        );
      } else {
        updatedResult = await pool.query(
          `UPDATE ${t}
           SET status=$1, owner=$2, priority=$3, note=$4, admin_note=$5, updated_at=CURRENT_TIMESTAMP
           WHERE id=$6 RETURNING *`,
          [newStatus, newOwner, newPriority, newNote, newNote, id]
        );
      }

      const updatedItem = updatedResult.rows[0];
      const index = db[t].findIndex((r) => Number(r.id) === id);
      if (index !== -1) db[t][index] = { ...db[t][index], ...updatedItem };

      if (req.body.sendNotification !== false) {
        await addAlert(`${t}_action`, `${t} updated`, {
          id: updatedItem.id,
          name: updatedItem.name,
          mobile: updatedItem.mobile,
          oldStatus,
          newStatus: updatedItem.status,
          oldOwner,
          newOwner: updatedItem.owner,
          note: updatedItem.note,
        });
      }

      if (req.body.createReminder || ["follow_up", "interested", "contacted"].includes(updatedItem.status)) {
        await addReminder(t, updatedItem, Number(req.body.reminderDays || 2));
      }

      let whatsapp = null;
      if (req.body.sendWhatsapp) {
        const mode = req.body.whatsappMode || "message";

        if (mode === "template") {
          const templateId = Number(req.body.whatsappTemplateId);
          const templateResult = await pool.query("SELECT * FROM whatsapp_templates WHERE id = $1", [templateId]);
          if (!templateResult.rows.length) {
            whatsapp = { success: false, status: "missing_template", message: "Select an imported BotSailor template" };
          } else {
            let variables = {};
            try {
              variables = typeof req.body.templateVariables === "string"
                ? JSON.parse(req.body.templateVariables || "{}")
                : req.body.templateVariables || {};
            } catch {
              variables = {};
            }
            whatsapp = await sendBotSailorTemplate(updatedItem, templateResult.rows[0], variables);
            await logWhatsAppSend(t, updatedItem, `template:${templateResult.rows[0].template_name}`, whatsapp);
          }
        } else {
          if (t === "leads" && !hasOpenWhatsappWindow(updatedItem)) {
            whatsapp = {
              success: false,
              status: "window_closed",
              message: "24-hour WhatsApp window closed. Please send an approved template.",
            };
          } else {
            const customMessage = req.body.whatsappMessage ||
              `Hi {{name}},\n\nDo you need any assistance regarding {{course}}?\n\nGuruvidya Academy`;
            whatsapp = await sendBotSailorText(updatedItem, customMessage, `${t}_manual_action`);
            await logWhatsAppSend(t, updatedItem, `${t}_manual_action`, whatsapp);
          }
        }
      }

      res.json({
        success: true,
        message: whatsapp?.success === false
          ? `${t} updated. WhatsApp: ${whatsapp.message}`
          : `${t} updated${whatsapp?.success ? " + WhatsApp sent" : ""}`,
        data: updatedItem,
        whatsapp,
      });
    } catch (err) {
      console.error(`❌ ${t} action error:`, err.message);
      res.status(500).json({ success: false, message: `Failed to update ${t}: ${err.message}` });
    }
  });
}

// ---------- BOTSAILOR INCOMING WEBHOOK ----------
function extractWebhookMobile(payload = {}) {
  return cleanMobile(
    payload.mobile ||
    payload.phone ||
    payload.phone_number ||
    payload.wa_id ||
    payload.chat_id ||
    payload.contact?.wa_id ||
    payload.contacts?.[0]?.wa_id ||
    payload.message?.from ||
    payload.messages?.[0]?.from ||
    ""
  );
}

function extractButtonReplyId(payload = {}) {
  return String(
    payload.button_id ||
    payload.button_reply_id ||
    payload.postback_id ||
    payload.button?.id ||
    payload.button_reply?.id ||
    payload.interactive?.button_reply?.id ||
    payload.message?.button?.payload ||
    payload.message?.button?.id ||
    payload.message?.interactive?.button_reply?.id ||
    payload.messages?.[0]?.button?.payload ||
    payload.messages?.[0]?.button?.id ||
    payload.messages?.[0]?.interactive?.button_reply?.id ||
    ""
  ).trim();
}

function extractButtonReplyTitle(payload = {}) {
  return String(
    payload.button_title ||
    payload.button_text ||
    payload.postback_title ||
    payload.button?.title ||
    payload.button_reply?.title ||
    payload.interactive?.button_reply?.title ||
    payload.message?.button?.text ||
    payload.message?.button?.title ||
    payload.message?.interactive?.button_reply?.title ||
    payload.messages?.[0]?.button?.text ||
    payload.messages?.[0]?.button?.title ||
    payload.messages?.[0]?.interactive?.button_reply?.title ||
    payload.text ||
    payload.message?.text?.body ||
    payload.messages?.[0]?.text?.body ||
    ""
  ).trim();
}

app.post("/api/webhook/botsailor", async (req, res) => {
  try {
    const payload = req.body || {};

    // Always reload saved Automation/Integration settings so a Render restart
    // cannot lose the selected "Call with Counselor" flow from memory.
    await loadPersistedConfig();

    const mobile = extractWebhookMobile(payload);
    if (!mobile) {
      return res.status(200).json({ status: "ignored", message: "No mobile in payload" });
    }

    // BotSailor can return reply-button data in slightly different fields
    // depending on webhook type. Match both our stable ID and visible title.
    const buttonId = extractButtonReplyId(payload);
    const buttonTitle = extractButtonReplyTitle(payload);
    const normalizedButton = normalize(buttonTitle);

    const isCallForAdmissionClick =
      buttonId === "crm_call_for_admission" ||
      normalize(buttonId) === "call for admission" ||
      normalizedButton === "call for admission";

    if (isCallForAdmissionClick) {
      if (!config.callForAdmissionFlowUniqueId) {
        console.log("⚠️ Call for Admission clicked but no BotSailor flow selected");
        return res.status(200).json({
          status: "ok",
          message: "Call for Admission click received, but flow is not selected in Automation settings"
        });
      }

      // Refresh the WhatsApp customer-service window for the existing lead,
      // but don't count the button click as a re-enquiry.
      await pool.query(
        `UPDATE leads
         SET last_customer_message_at = CURRENT_TIMESTAMP,
             window_closing_sent_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE regexp_replace(COALESCE(mobile, ''), '\\D', '', 'g') = $1`,
        [mobile]
      );

      const flowResult = await triggerBotSailorFlow(
        mobile,
        config.callForAdmissionFlowUniqueId
      );

      console.log("CRM Call for Admission click:", {
        mobile,
        buttonId,
        buttonTitle,
        flow: config.callForAdmissionFlowUniqueId,
        success: flowResult.success
      });

      // Important: return here so the click is not processed again as
      // a normal enquiry/re-enquiry message.
      return res.status(flowResult.success ? 200 : 400).json({
        status: flowResult.success ? "ok" : "failed",
        message: flowResult.success
          ? "Call with Counselor BotSailor flow triggered"
          : (flowResult.message || "BotSailor flow trigger failed"),
        flow: flowResult.response || null
      });
    }

    const duplicateResult = await pool.query(
      `SELECT * FROM leads
       WHERE regexp_replace(COALESCE(mobile, ''), '\\D', '', 'g') = $1
         AND created_at >= CURRENT_TIMESTAMP - INTERVAL '15 days'
       ORDER BY created_at DESC
       LIMIT 1`,
      [mobile]
    );

    if (duplicateResult.rows.length) {
      const existingLead = duplicateResult.rows[0];
      const oldLastCustomer = existingLead.last_customer_message_at
        ? new Date(existingLead.last_customer_message_at)
        : null;
      const isReplyInsideCurrentWindow = oldLastCustomer && !Number.isNaN(oldLastCustomer.getTime()) && (Date.now() - oldLastCustomer.getTime()) < DAY;

      // Normal customer reply inside the active 24h window:
      // refresh window only; do NOT count every chat message as a re-enquiry.
      if (isReplyInsideCurrentWindow) {
        const update = await pool.query(
          `UPDATE leads
           SET name = COALESCE(NULLIF($1, ''), name),
               course = COALESCE(NULLIF($2, ''), course),
               last_customer_message_at = CURRENT_TIMESTAMP,
               window_closing_sent_at = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $3
           RETURNING *`,
          [payload.name || payload.first_name || "", payload.course || "", existingLead.id]
        );
        const updatedLead = update.rows[0];
        return res.status(200).json({ status: "ok", message: "Customer reply recorded; 24h window refreshed", lead: updatedLead });
      }

      // Re-enquiry after previous customer-service window ended, but within 15 days.
      const newEnquiryCount = Number(existingLead.enquiry_count || 1) + 1;
      const newLeadScore = Number(existingLead.lead_score || 50) + 10;
      const newPriority = newEnquiryCount >= 3 ? "very hot" : existingLead.priority || "hot";
      const newStatus = newEnquiryCount >= 3 ? "very_hot" : "re-enquiry";
      const nextFollowup = new Date(Date.now() + DAY);
      let updatedNote = existingLead.note || "";
      let updatedCourse = existingLead.course;
      if (payload.course && payload.course !== existingLead.course) {
        updatedNote += ` | Course changed: ${existingLead.course || ""} → ${payload.course}`;
        updatedCourse = payload.course;
      }
      updatedNote += " | Re-enquiry within 15 days";

      const updateResult = await pool.query(
        `UPDATE leads
         SET name = COALESCE(NULLIF($1, ''), name),
             course = $2,
             status = $3,
             priority = $4,
             note = $5,
             enquiry_count = $6,
             lead_score = $7,
             last_enquiry_at = CURRENT_TIMESTAMP,
             next_followup = $8,
             next_best_action = $9,
             source = 'botsailor_whatsapp',
             last_customer_message_at = CURRENT_TIMESTAMP,
             automation_started_at = CURRENT_TIMESTAMP,
             followup_3h_sent_at = NULL,
             followup_6h_sent_at = NULL,
             followup_9h_sent_at = NULL,
             window_closing_sent_at = NULL,
             last_auto_message_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $10
         RETURNING *`,
        [
          payload.name || payload.first_name || "",
          updatedCourse,
          newStatus,
          newPriority,
          updatedNote,
          newEnquiryCount,
          newLeadScore,
          nextFollowup,
          newEnquiryCount >= 3 ? "Call immediately - very high intent" : "Call again - re-enquiry",
          existingLead.id,
        ]
      );

      return res.status(200).json({
        status: "ok",
        message: newEnquiryCount >= 3 ? "Re-enquiry updated - Very Hot" : "Re-enquiry updated",
        lead: updateResult.rows[0],
      });
    }

    const newLeadResult = await pool.query(
      `INSERT INTO leads
       (name, mobile, course, priority, status, owner, lead_score, lead_stage,
        next_best_action, note, source, last_enquiry_at, last_customer_message_at,
        automation_started_at, created_at, updated_at)
       VALUES ($1,$2,$3,'hot','new','Counselor 1',50,'new',$4,$5,'botsailor_whatsapp',
               CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        payload.name || payload.first_name || "WhatsApp Lead",
        mobile,
        payload.course || "ACCA",
        "CRM follow-up starts after configured delay",
        `Source: botsailor_whatsapp | Subscriber ID: ${payload.subscriber_id || ""}`,
      ]
    );

    const lead = newLeadResult.rows[0];
    db.leads.unshift(lead);
    await addAlert("leads_created", "New WhatsApp lead received", {
      id: lead.id,
      name: lead.name,
      mobile: lead.mobile,
      owner: lead.owner,
      priority: lead.priority,
    });

    console.log("✅ BotSailor Lead Saved:", lead.id, lead.mobile);
    res.status(200).json({ status: "ok", message: "Lead saved from BotSailor", lead });
  } catch (err) {
    console.error("❌ BotSailor webhook error:", err.message);
    res.status(500).json({ status: "error", message: err.message });
  }
});

// Kept for compatibility with any older code paths.
async function sendWhatsAppMessage(phone, message) {
  return sendBotSailorText({ mobile: phone, name: "Student", course: "" }, message, "legacy_send");
}

async function bootstrap() {
  try {
    await pool.query("SELECT NOW()");
    console.log("✅ PostgreSQL connected successfully");
    await initDatabase();
    await loadPersistedConfig();

    app.listen(PORT, () => {
      console.log(`Guruvidya Phase 3 backend running on ${PORT}`);
    });

    // Internal scheduler. Also use /api/admin/automation/run-now for testing.
    const intervalMs = Math.max(1, Number(config.automationCheckMinutes || 5)) * 60 * 1000;
    setInterval(runFollowupAutomation, intervalMs);
    setTimeout(runFollowupAutomation, 30 * 1000);
  } catch (err) {
    console.error("❌ Backend startup failed:", err);
    process.exit(1);
  }
}

bootstrap();

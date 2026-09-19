import express from "express";
import cors from "cors";
import axios from "axios";
import pg from "pg";
import { randomUUID } from "node:crypto";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const app = express();
app.use(cors());
// Bulk BotSailor Flow Data imports can contain many TXT/JSON exports at once.
app.use(express.json({ limit: "25mb" }));

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
  windowClosingUseCallButton: false,
  windowClosingUseSameCtaAs3: false,
  windowClosingCtaActionMode: "off",
  windowClosingCtaTemplateId: "",
  windowClosingCtaTemplateCustomTitle: "Admission Help",
  windowClosingCtaFlowUniqueId: "",
  windowClosingHoursBefore: 3,
  windowClosingMessage:
    "Hi {{name}}, do you need any assistance regarding your {{course}} enquiry?\n\nPlease reply YES if you would like our admission counsellor to assist you.\n\nOur counsellor will contact you during working hours (9:00 AM onwards).\n\nGuruvidya Academy",

  // Call for Admission click action.
  // Supported values:
  //   "off"      -> no secondary action after button click
  //   "flow"     -> trigger selected existing BotSailor flow
  //   "template" -> send selected existing imported BotSailor template
  callForAdmissionActionMode: "template",
  callForAdmissionTemplateId: "",
  // Editable label/title shown with CRM follow-up before the selected template.
  callForAdmissionTemplateCustomTitle: "Call for Admission",

  // Selected existing BotSailor flow unique id.
  // Kept separate from the old field so admin can switch between Flow / Template / Off.
  callForAdmissionFlowUniqueId: "",

  // Stage-specific CTA overrides.
  // 6h/9h default to the same CTA configuration as 3h.
  followup6UseSameCtaAs3: true,
  followup6CtaActionMode: "template",
  followup6CtaTemplateId: "",
  followup6CtaTemplateCustomTitle: "Call for Admission",
  followup6CtaFlowUniqueId: "",

  followup9UseSameCtaAs3: true,
  followup9CtaActionMode: "template",
  followup9CtaTemplateId: "",
  followup9CtaTemplateCustomTitle: "Call for Admission",
  followup9CtaFlowUniqueId: "",

  // Legacy/default BotSailor "Call with Counselor" flow.
  // The 3h/6h WhatsApp message shows a reply button "Call for Admission".
  // When the student taps it, CRM triggers this BotSailor flow, which contains
  // the actual Call Us / phone CTA.
  callWithCounselorFlowUniqueId: "430988",

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

function botSailorPhone(v = "") {
  let mobile = cleanMobile(v);

  // Indian 10-digit mobile -> add country code 91 for BotSailor/WhatsApp API.
  if (mobile.length === 10) {
    mobile = `91${mobile}`;
  }

  // If number is stored as 0XXXXXXXXXX, remove 0 and add India country code.
  if (mobile.length === 11 && mobile.startsWith("0")) {
    mobile = `91${mobile.slice(1)}`;
  }

  return mobile;
}

function normalize(v = "") {
  return String(v || "").trim().toLowerCase();
}

function renderMessage(template, record = {}) {
  return String(template || "")
    .replaceAll("{{name}}", record.name || "Student")
    .replaceAll("{{course}}", record.course || "your course")
    .replaceAll("{{mobile}}", record.mobile || "")
    .replaceAll("{{owner}}", record.owner || "Admission Team")
    .replaceAll("#LEAD_USER_FIRST_NAME#", record.name || "Student")
    .replaceAll("#LEAD_USER_NAME#", record.name || "Student");
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

    CREATE TABLE IF NOT EXISTS whatsapp_window_events (
      mobile TEXT NOT NULL,
      message_id TEXT NOT NULL,
      received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (mobile, message_id)
    );

    CREATE TABLE IF NOT EXISTS manual_whatsapp_requests (
      request_id TEXT PRIMARY KEY,
      target TEXT NOT NULL,
      result JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

    CREATE TABLE IF NOT EXISTS flow_runtime_actions (
      id SERIAL PRIMARY KEY,
      mobile TEXT NOT NULL,
      normalized_title TEXT NOT NULL,
      flow_unique_id TEXT,
      flow_name TEXT,
      action JSONB NOT NULL DEFAULT '{}'::jsonb,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_flow_runtime_actions_lookup
      ON flow_runtime_actions (mobile, normalized_title, created_at DESC);
    CREATE TABLE IF NOT EXISTS cta_sent_buttons (
      button_id TEXT PRIMARY KEY,
      mobile TEXT NOT NULL,
      normalized_title TEXT NOT NULL,
      visible_title TEXT NOT NULL,
      cta_config JSONB NOT NULL,
      message_id TEXT,
      sent BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_cta_sent_buttons_lookup
      ON cta_sent_buttons (mobile, normalized_title, created_at DESC);
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
  console.log("✅ CTA mode: click-based selected BotSailor Flow/Template action ready");
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
    phone_number: botSailorPhone(record.mobile || ""),
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

async function sendBotSailorReplyButtons(
  record,
  message,
  buttons = [],
  action = "send_flow_buttons",
  options = {}
) {
  if (!config.whatsappEnabled) {
    return { success: false, status: "disabled", message: "WhatsApp disabled" };
  }

  const finalMessage = renderMessage(message, record);
  const safeButtons = (Array.isArray(buttons) ? buttons : [])
    .slice(0, 3)
    .map((b, index) => ({
      id: String(b?.id || `flow_button_${index + 1}`),
      // WhatsApp/BotSailor official reply-button limit is 20 chars.
      title: String(b?.title || `Option ${index + 1}`).trim().slice(0, 20),
    }));

  if (!safeButtons.length) {
    return sendBotSailorText(record, finalMessage, `${action}_text_fallback`);
  }

  const payload = {
    apiToken: config.botsailorToken,
    phone_number_id: config.botsailorInstanceId,
    phone_number: botSailorPhone(record.mobile || ""),
    message: finalMessage,
    buttons: safeButtons,
  };

  if (options.headerText) payload.button_header_text = renderMessage(options.headerText, record);
  if (options.footerText) payload.button_footer_text = renderMessage(options.footerText, record);
  if (options.mediaUrl) payload.media_url = String(options.mediaUrl);
  if (options.mediaType) payload.media_type = String(options.mediaType);

  const result = await botSailorPost(
    "https://botsailor.com/api/v1/whatsapp/send/interactive-buttons",
    payload
  );

  await addIntegrationLog(
    "whatsapp",
    action,
    result.success ? "success" : "failed",
    { ...payload, apiToken: "***" },
    result.response || { error: result.error || result.message }
  );

  console.log("BotSailor Interactive Buttons:", {
    success: result.success,
    status: result.status,
    message: result.message,
    buttons: safeButtons,
    response: result.response || {},
  });

  return { ...result, messageText: finalMessage };
}

async function sendBotSailorReplyButton(
  record,
  message,
  action = "send_call_for_admission_button",
  buttonTitle = "Call for Admission",
  buttonId = "call_for_admission"
) {
  return sendBotSailorReplyButtons(
    record,
    message,
    [{ id: buttonId, title: buttonTitle }],
    action
  );
}

async function sendBotSailorInteractiveCall(record, message, action = "send_call_followup") {
  // Single-message mode:
  // Send the editable CRM follow-up as one WhatsApp interactive session message
  // with the reply button "Call for Admission".
  // The actual phone CTA is shown only after the student taps the button and
  // the webhook triggers the BotSailor "Call with Counselor" flow.
  return sendBotSailorReplyButton(record, message, action);
}

async function sendDirectCounselorStep(record) {
  const message =
    "Dear {{name}},\n\n" +
    "*Session with Guruvidya Admission Team*\n" +
    "Upto 10 min\n" +
    "By Phone Call\n" +
    "Get all your queries answered regarding admission process.";

  // This replaces the unreliable BotSailor trigger-bot execution.
  // Student gets the same next step directly from CRM.
  return sendBotSailorReplyButton(
    record,
    message,
    "flow_direct_counselor_step",
    "Instant Call us"
  );
}

async function resetBotSailorUserInputFlow(phone) {
  const payload = {
    apiToken: config.botsailorToken,
    phone_number_id: config.botsailorInstanceId,
    phone_number: botSailorPhone(phone),
  };

  const result = await botSailorPost(
    "https://botsailor.com/api/v1/whatsapp/subscriber/reset/user-input-flow",
    payload
  );

  await addIntegrationLog(
    "whatsapp",
    "reset_user_input_flow",
    result.success ? "success" : "failed",
    { ...payload, apiToken: "***" },
    result.response || { error: result.error || result.message }
  );

  return result;
}

async function triggerBotSailorFlow(phone, uniqueId, options = {}) {
  if (!uniqueId) {
    console.log("CTA DEBUG | triggerBotSailorFlow blocked: missing uniqueId");
    return { success: false, status: "missing_flow", message: "BotSailor Call us flow not selected" };
  }

  const payload = {
    apiToken: config.botsailorToken,
    phone_number_id: config.botsailorInstanceId,
    bot_flow_unique_id: uniqueId,
    phone_number: botSailorPhone(phone),
  };

  console.log("CTA DEBUG | triggering BotSailor flow", {
    phone_number_id: config.botsailorInstanceId,
    bot_flow_unique_id: uniqueId,
    phone_number: payload.phone_number,
  });

  // A button reply can arrive while the subscriber is still attached to an
  // older BotSailor input-flow state. Clear that state before deliberately
  // starting the newly selected flow. A reset failure must not block trigger.
  let resetResult = null;
  if (options.resetUserInput === true) {
    resetResult = await resetBotSailorUserInputFlow(phone);
    console.log("CTA DEBUG | reset user input flow result", {
      success: resetResult.success,
      status: resetResult.status,
      message: resetResult.message,
      phone_number: payload.phone_number,
    });
  }

  const result = await botSailorPost("https://botsailor.com/api/v1/whatsapp/trigger-bot", payload);

  console.log("CTA DEBUG | BotSailor trigger-bot raw result", {
    success: result.success,
    status: result.status,
    httpStatus: result.httpStatus,
    message: result.message,
    response: result.response || {},
  });

  await addIntegrationLog(
    "whatsapp",
    "trigger_bot_flow",
    result.success ? "success" : "failed",
    { ...payload, apiToken: "***" },
    result.response || { error: result.error || result.message }
  );
  return { ...result, resetResult };
}



function getFlowExportData(flowRecord) {
  let raw = flowRecord?.raw || {};
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { raw = {}; }
  }
  const candidate = raw?.flow_export || raw?.flowData || raw?.export_data || raw;
  return candidate && candidate.nodes && typeof candidate.nodes === "object" ? candidate : null;
}

function firstConnection(node, outputName) {
  const list = node?.outputs?.[outputName]?.connections;
  return Array.isArray(list) && list.length ? list[0] : null;
}

function allConnections(node, outputName) {
  const list = node?.outputs?.[outputName]?.connections;
  return Array.isArray(list) ? list : [];
}

function inferMediaType(url = "") {
  const clean = String(url || "").split("?")[0].toLowerCase();
  if (/\.(mp4|mov|webm)$/.test(clean)) return "video";
  if (/\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt)$/.test(clean)) return "document";
  return "image";
}

async function saveFlowRuntimeActions(record, flowRecord, buttonActions = []) {
  const mobile = botSailorPhone(record.mobile || "");
  if (!mobile || !buttonActions.length) return;

  await pool.query(
    `DELETE FROM flow_runtime_actions
     WHERE mobile = $1 OR expires_at < CURRENT_TIMESTAMP`,
    [mobile]
  );

  for (const item of buttonActions) {
    const normalizedTitle = normalizeLooseText(String(item.title || "").slice(0, 20));
    if (!normalizedTitle) continue;
    await pool.query(
      `INSERT INTO flow_runtime_actions
       (mobile, normalized_title, flow_unique_id, flow_name, action, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP + INTERVAL '24 hours',CURRENT_TIMESTAMP)`,
      [
        mobile,
        normalizedTitle,
        String(flowRecord?.unique_id || ""),
        String(flowRecord?.name || ""),
        JSON.stringify(item.action || {}),
      ]
    );
  }
}

async function findFlowRuntimeAction(mobile, incomingTitle) {
  const phone = botSailorPhone(mobile || "");
  const title = normalizeLooseText(incomingTitle || "");
  if (!phone || !title) return null;
  const result = await pool.query(
    `SELECT * FROM flow_runtime_actions
     WHERE mobile = $1
       AND normalized_title = $2
       AND expires_at > CURRENT_TIMESTAMP
     ORDER BY created_at DESC
     LIMIT 1`,
    [phone, title]
  );
  return result.rows[0] || null;
}

async function importBotSailorFlowExport(flowDataInput, sourceFileName = "") {
  let flowData = flowDataInput;
  if (typeof flowData === "string") {
    try { flowData = JSON.parse(flowData); }
    catch { return { success: false, message: "Flow Data is not valid JSON" }; }
  }
  if (!flowData?.nodes || typeof flowData.nodes !== "object") {
    return { success: false, message: "Flow Data does not contain nodes" };
  }

  const startNode = Object.values(flowData.nodes).find((n) => n?.name === "Start Bot Flow") || flowData.nodes["1"];
  const title = String(startNode?.data?.title || "").trim();
  if (!title) return { success: false, message: "Flow title not found in Start Bot Flow node" };

  let existing = await pool.query(
    `SELECT * FROM botsailor_flows WHERE raw->>'crm_sync_missing' IS DISTINCT FROM 'true' AND LOWER(TRIM(name)) = LOWER(TRIM($1)) ORDER BY imported_at DESC LIMIT 1`,
    [title]
  );
  if (!existing.rows.length) {
    const allFlows = await pool.query(
      `SELECT * FROM botsailor_flows WHERE raw->>'crm_sync_missing' IS DISTINCT FROM 'true' ORDER BY imported_at DESC, name ASC`
    );
    const normalizedTitle = normalizeLooseText(title);
    const relaxedMatch = allFlows.rows.find(
      (item) => normalizeLooseText(item.name || "") === normalizedTitle
    );
    if (relaxedMatch) existing = { rows: [relaxedMatch] };
  }
  if (!existing.rows.length) {
    return { success: false, message: `Flow '${title}' is not in imported BotSailor Flow List. Refresh CTA Flows first.` };
  }

  const flow = existing.rows[0];
  let raw = flow.raw || {};
  if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { raw = {}; } }
  raw = {
    ...raw,
    flow_export: flowData,
    flow_export_imported_at: new Date().toISOString(),
    flow_export_source_file: String(sourceFileName || ""),
  };

  const updated = await pool.query(
    `UPDATE botsailor_flows SET raw = $1::jsonb, imported_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
    [JSON.stringify(raw), flow.id]
  );
  return {
    success: true,
    flow: updated.rows[0],
    title,
    sourceFileName: String(sourceFileName || ""),
    nodeCount: Object.keys(flowData.nodes).length,
  };
}

async function executeDirectFlowNode(record, flowRecord, flowData, nodeId, depth = 0) {
  if (depth > 20) return { success: false, status: "flow_depth_limit", message: "Flow depth limit reached" };
  const node = flowData?.nodes?.[String(nodeId)] || flowData?.nodes?.[nodeId];
  if (!node) return { success: false, status: "missing_node", message: `Flow node ${nodeId} not found` };

  console.log("DIRECT FLOW DEBUG | executing node", { flow: flowRecord?.name, nodeId, nodeName: node.name });

  if (node.name === "Text") {
    const result = await sendBotSailorText(record, node.data?.textMessage || "", `direct_flow:${flowRecord.name}:text`);
    const next = firstConnection(node, "textOutput");
    if (result.success && next?.node) return executeDirectFlowNode(record, flowRecord, flowData, next.node, depth + 1);
    return result;
  }

  if (node.name === "Interactive") {
    const buttonConnections = allConnections(node, "interactiveOutputButton");
    const buttons = [];
    const runtimeActions = [];

    for (const conn of buttonConnections.slice(0, 3)) {
      const buttonNode = flowData.nodes?.[String(conn.node)] || flowData.nodes?.[conn.node];
      if (!buttonNode) continue;
      const title = String(buttonNode.data?.buttonText || buttonNode.data?.postback_text || "Option").trim();
      const next = firstConnection(buttonNode, "buttonOutput");
      let action = null;

      if (next?.node) {
        action = { type: "node", nodeId: next.node };
      } else if (String(buttonNode.data?.text || "").toLowerCase() === "start a flow" && buttonNode.data?.value) {
        action = {
          type: "start_flow",
          flowValue: String(buttonNode.data.value),
          postbackText: String(buttonNode.data?.postback_text || ""),
        };
      } else {
        action = { type: "noop" };
      }

      buttons.push({ id: `direct_flow_${flowRecord.id}_${buttonNode.id}`, title });
      runtimeActions.push({ title, action });
    }

    const mediaUrl = String(node.data?.headerMediaUrl || "").trim();
    const result = await sendBotSailorReplyButtons(
      record,
      node.data?.textMessage || "Please choose an option.",
      buttons,
      `direct_flow:${flowRecord.name}:interactive`,
      {
        headerText: node.data?.headerType === "text" ? node.data?.headerText || "" : "",
        footerText: node.data?.footerText || "",
        mediaUrl,
        mediaType: mediaUrl ? inferMediaType(mediaUrl) : "",
      }
    );
    if (result.success) await saveFlowRuntimeActions(record, flowRecord, runtimeActions);
    return result;
  }

  if (node.name === "CTA URL Button") {
    const text = [
      node.data?.headerMessage || "",
      node.data?.bodyMessage || "",
      node.data?.footerMessage || "",
      node.data?.buttonText ? `*${node.data.buttonText}*` : "",
      node.data?.buttonUrl || "",
    ].filter(Boolean).join("\n\n");
    const result = await sendBotSailorText(record, text, `direct_flow:${flowRecord.name}:cta_url`);
    const next = firstConnection(node, "ctaUrlOutput");
    if (result.success && next?.node) return executeDirectFlowNode(record, flowRecord, flowData, next.node, depth + 1);
    return result;
  }

  // Unknown node: try the first connected output so simple future node types do not dead-end.
  for (const output of Object.values(node.outputs || {})) {
    const next = Array.isArray(output?.connections) ? output.connections[0] : null;
    if (next?.node) return executeDirectFlowNode(record, flowRecord, flowData, next.node, depth + 1);
  }

  return { success: true, status: "flow_node_skipped", message: `Unsupported terminal node: ${node.name}` };
}

async function executeDirectBotSailorFlow(record, flowRecord) {
  const flowData = getFlowExportData(flowRecord);
  if (!flowData) {
    return { success: false, status: "missing_flow_export", message: "Flow Data export is not imported for this flow" };
  }
  const startNode = Object.values(flowData.nodes).find((n) => n?.name === "Start Bot Flow") || flowData.nodes["1"];
  const first = firstConnection(startNode, "referenceOutput");
  if (!first?.node) return { success: false, status: "empty_flow", message: "Start node has no connected message" };
  return executeDirectFlowNode(record, flowRecord, flowData, first.node, 0);
}

async function executeRuntimeFlowAction(record, runtimeRow) {
  let action = runtimeRow?.action || {};
  if (typeof action === "string") { try { action = JSON.parse(action); } catch { action = {}; } }
  const sourceFlow = runtimeRow?.flow_unique_id ? await getSelectedFlowRecord(runtimeRow.flow_unique_id) : null;
  const sourceData = sourceFlow ? getFlowExportData(sourceFlow) : null;

  if (action.type === "node" && sourceFlow && sourceData) {
    return executeDirectFlowNode(record, sourceFlow, sourceData, action.nodeId, 0);
  }

  if (action.type === "start_flow") {
    // Existing Call-us branch is known to work reliably as the approved template.
    if (normalizeLooseText(action.postbackText || "") === "call us") {
      const templateRecord = await findCallUsTemplate(true);
      if (!templateRecord) return { success: false, status: "missing_template", message: "call_us template not found" };
      return sendBotSailorTemplate(record, templateRecord, buildTemplateVariables(templateRecord, record));
    }

    let target = await getSelectedFlowRecord(action.flowValue || "");
    if (!target && config.botsailorToken && config.botsailorInstanceId) {
      await importBotSailorFlows();
      target = await getSelectedFlowRecord(action.flowValue || "");
    }

    // Exported Flow Data is the proven delivery path. BotSailor's live trigger
    // may acknowledge success without sending the actual flow message.
    if (target && getFlowExportData(target)) {
      return executeDirectBotSailorFlow(record, target);
    }
    return triggerBotSailorFlow(
      record.mobile,
      target?.unique_id || action.flowValue || "",
      { resetUserInput: false }
    );
  }

  return { success: true, status: "noop", message: "No next action configured" };
}

async function findSelectedCtaTemplate(autoImport = true, templateIdOverride = "") {
  const selectedId = String(
    templateIdOverride ||
    config.callForAdmissionTemplateId ||
    config.botsailorTemplateId ||
    ""
  ).trim();

  const lookup = async () => {
    if (selectedId) {
      const selected = await pool.query(
        `SELECT * FROM whatsapp_templates
         WHERE raw->>'crm_sync_missing' IS DISTINCT FROM 'true' AND (id::text = $1 OR botsailor_id = $1)
         ORDER BY imported_at DESC
         LIMIT 1`,
        [selectedId]
      );
      if (selected.rows.length) return selected.rows[0];
    }

    return null;
  };

  let record = await lookup();
  if (record || !autoImport) return record;

  const importResult = await importBotSailorTemplates();
  if (!importResult.success) return null;

  record = await lookup();
  return record;
}

async function findCallUsTemplate(autoImport = true) {
  const lookup = async () => {
    // Prefer a specifically saved template id when available.
    if (config.botsailorTemplateId) {
      const selected = await pool.query(
        `SELECT * FROM whatsapp_templates
         WHERE raw->>'crm_sync_missing' IS DISTINCT FROM 'true' AND (id::text = $1 OR botsailor_id = $1)
         ORDER BY imported_at DESC
         LIMIT 1`,
        [String(config.botsailorTemplateId)]
      );
      if (selected.rows.length) return selected.rows[0];
    }

    // Fallback to the approved Call Us template imported from BotSailor.
    const fallback = await pool.query(
      `SELECT * FROM whatsapp_templates
       WHERE raw->>'crm_sync_missing' IS DISTINCT FROM 'true' AND (LOWER(REPLACE(REPLACE(COALESCE(template_name,''), ' ', '_'), '-', '_'))
             IN ('call_us','callus')
          OR LOWER(COALESCE(template_name,'')) LIKE '%call%us%')
       ORDER BY
         CASE
           WHEN LOWER(REPLACE(REPLACE(COALESCE(template_name,''), ' ', '_'), '-', '_')) = 'call_us' THEN 0
           ELSE 1
         END,
         imported_at DESC
       LIMIT 1`
    );

    return fallback.rows[0] || null;
  };

  let templateRecord = await lookup();
  if (templateRecord || !autoImport) return templateRecord;

  console.log("CTA TEMPLATE DEBUG | call_us template missing locally, importing BotSailor templates");

  const importResult = await importBotSailorTemplates();

  console.log("CTA TEMPLATE DEBUG | auto import result", {
    success: importResult.success,
    status: importResult.status,
    imported: importResult.imported || 0,
    message: importResult.message || "",
  });

  if (!importResult.success) {
    return null;
  }

  templateRecord = await lookup();

  if (templateRecord) {
    console.log("CTA TEMPLATE DEBUG | call_us template found after auto import", {
      id: templateRecord.id,
      botsailor_id: templateRecord.botsailor_id,
      template_name: templateRecord.template_name,
    });
  } else {
    console.log("CTA TEMPLATE DEBUG | call_us template still not found after auto import");
  }

  return templateRecord;
}

function buildTemplateVariables(templateRecord, record = {}) {
  const vars = {};
  let variableMap = templateRecord?.variable_map || {};

  if (typeof variableMap === "string") {
    try {
      variableMap = JSON.parse(variableMap);
    } catch {
      variableMap = {};
    }
  }

  const nameValue = record.name || "Student";
  const courseValue = record.course || "your course";
  const mobileValue = botSailorPhone(record.mobile || "");

  // BotSailor generated template endpoints use keys such as:
  // templateVariable-Name-1, templateVariable-User-Name-1, etc.
  const rawText = JSON.stringify(variableMap || {});
  const keys = new Set();

  const regex = /templateVariable-[A-Za-z0-9_-]+-\d+/g;
  for (const match of rawText.match(regex) || []) keys.add(match);

  for (const key of keys) {
    const k = key.toLowerCase();
    if (k.includes("course")) vars[key] = courseValue;
    else if (k.includes("mobile") || k.includes("phone")) vars[key] = mobileValue;
    else vars[key] = nameValue;
  }

  // The approved Call Us template shown in BotSailor contains User-Name.
  // If BotSailor's imported variable_map does not expose the generated API key,
  // supply the common generated key used by its template endpoint.
  if (
    Object.keys(vars).length === 0 &&
    /user[-_ ]?name/i.test(
      `${templateRecord?.body_content || ""} ${templateRecord?.template_name || ""} ${rawText}`
    )
  ) {
    vars["templateVariable-User-Name-1"] = nameValue;
  }

  return vars;
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
    sendToPhoneNumber: botSailorPhone(record.mobile || ""),
    ...variables,
  };

  const result = await botSailorPost("https://botsailor.com/api/v1/whatsapp/send/template", fields);
  await addIntegrationLog(
    "whatsapp",
    "send_template",
    result.success ? "success" : "failed",
    {
      phone: botSailorPhone(record.mobile || ""),
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

async function getSelectedFlowRecord(flowValue) {
  if (!flowValue) return null;

  const value = String(flowValue).trim();

  // Accept either the imported BotSailor unique_id or its numeric botsailor_id.
  // This prevents an older/admin-saved numeric flow id (e.g. 430988) from being
  // passed directly as bot_flow_unique_id when the API actually needs unique_id.
  const result = await pool.query(
    `SELECT * FROM botsailor_flows
     WHERE raw->>'crm_sync_missing' IS DISTINCT FROM 'true' AND (unique_id = $1 OR botsailor_id = $1)
     ORDER BY
       CASE WHEN unique_id = $1 THEN 0 ELSE 1 END,
       imported_at DESC
     LIMIT 1`,
    [value]
  );

  return result.rows[0] || null;
}

function withCtaTitle(message, title) {
  const body = String(message || "").trim();
  const heading = String(title || "").trim();
  if (!heading) return body;
  return `${body}\n\n*${heading}*`;
}

function getStageCtaConfig(label = "", stageConfig = config) {
  const config = stageConfig;
  const stage = String(label || "").toLowerCase();

  const base = {
    stage: "3h",
    mode: normalize(config.callForAdmissionActionMode || "template"),
    templateId: String(config.callForAdmissionTemplateId || config.botsailorTemplateId || "").trim(),
    templateTitle: String(config.callForAdmissionTemplateCustomTitle || "Call for Admission").trim() || "Call for Admission",
    flowUniqueId: String(config.callForAdmissionFlowUniqueId || config.callWithCounselorFlowUniqueId || "").trim(),
  };

  if (stage.includes("window") || stage === "24h") {
    if (config.windowClosingUseSameCtaAs3 === true) return { ...base, stage: "window" };
    return {
      stage: "window",
      mode: normalize(config.windowClosingCtaActionMode || "off"),
      templateId: String(config.windowClosingCtaTemplateId || "").trim(),
      templateTitle: String(config.windowClosingCtaTemplateCustomTitle || "Admission Help").trim(),
      flowUniqueId: String(config.windowClosingCtaFlowUniqueId || "").trim(),
    };
  }
  if (stage.includes("6h") && !Boolean(config.followup6UseSameCtaAs3 ?? true)) {
    return {
      stage: "6h",
      mode: normalize(config.followup6CtaActionMode || base.mode),
      templateId: String(config.followup6CtaTemplateId || "").trim(),
      templateTitle: String(config.followup6CtaTemplateCustomTitle || "Call for Admission").trim() || "Call for Admission",
      flowUniqueId: String(config.followup6CtaFlowUniqueId || "").trim(),
    };
  }

  if (stage.includes("9h") && !Boolean(config.followup9UseSameCtaAs3 ?? true)) {
    return {
      stage: "9h",
      mode: normalize(config.followup9CtaActionMode || base.mode),
      templateId: String(config.followup9CtaTemplateId || "").trim(),
      templateTitle: String(config.followup9CtaTemplateCustomTitle || "Call for Admission").trim() || "Call for Admission",
      flowUniqueId: String(config.followup9CtaFlowUniqueId || "").trim(),
    };
  }

  return { ...base, stage: stage.includes("9h") ? "9h" : stage.includes("6h") ? "6h" : "3h" };
}

function ctaContextMessageId(payload = {}) {
  return String(payload.context?.id || payload.message?.context?.id ||
    payload.messages?.[0]?.context?.id || payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.context?.id || payload.reply_to_message_id ||
    payload.replied_to_message_id || payload.reply_message_id || "").trim();
}

function ctaSnapshotKey(cta) {
  return JSON.stringify([cta.stage, cta.mode, cta.templateId, cta.flowUniqueId]);
}

async function resolveSentCta(mobile, payload, title) {
  const id = extractButtonReplyId(payload);
  const phone = botSailorPhone(mobile);
  const contextId = ctaContextMessageId(payload);
  if (id.startsWith("gvcta_")) {
    const found = await pool.query(
      "SELECT * FROM cta_sent_buttons WHERE mobile = $1 AND button_id = $2", [phone, id]);
    return { exact: true, cta: found.rows[0]?.cta_config || null, candidates: [] };
  }
  if (contextId) {
    const found = await pool.query(
      "SELECT * FROM cta_sent_buttons WHERE mobile = $1 AND message_id = $2", [phone, contextId]);
    if (found.rows.length === 1) return { exact: true, cta: found.rows[0].cta_config, candidates: [] };
  }
  const stageMatch = normalizeLooseText(id).match(/^call for admission (3h|6h|9h)$/);
  if (stageMatch) return { exact: true, cta: getStageCtaConfig(stageMatch[1]), candidates: [] };
  if (!title) return { exact: false, cta: null, candidates: [] };
  const found = await pool.query(
    `SELECT * FROM cta_sent_buttons WHERE mobile = $1 AND normalized_title = $2 AND sent = TRUE
     ORDER BY created_at DESC`, [phone, title]);
  const candidates = [...new Map(found.rows.map(row => [ctaSnapshotKey(row.cta_config), row])).values()];
  return { exact: false, cta: candidates.length === 1 ? candidates[0].cta_config : null, candidates };
}

async function getAllEffectiveCtaConfigs() {
  const items = [
    getStageCtaConfig("3h"),
    getStageCtaConfig("6h"),
    getStageCtaConfig("9h"),
    getStageCtaConfig("window"),
  ];

  const resolved = [];
  for (const item of items) {
    let title = item.templateTitle || "Call for Admission";

    if (item.mode === "flow") {
      const flowRecord = item.flowUniqueId
        ? await getSelectedFlowRecord(item.flowUniqueId)
        : null;
      title = String(flowRecord?.name || "Call for Admission").trim() || "Call for Admission";
    }

    resolved.push({
      ...item,
      visibleTitle: String(title).slice(0, 20),
      normalizedTitle: normalizeLooseText(String(title).slice(0, 20)),
    });
  }
  return resolved;
}

async function sendAndLogText(table, record, label, message, useCallButton = false, stageConfig = config) {
  // CTA-enabled stages always send ONE interactive CRM follow-up first.
  // Flow/Template is executed only after the student taps the button and
  // /api/webhook/botsailor receives "Call for Admission".
  if (useCallButton) {
    const stageCta = getStageCtaConfig(label, stageConfig);
    const mode = stageCta.mode;

    console.log("STAGE CTA DEBUG", {
      label,
      stage: stageCta.stage,
      useCallButton,
      mode,
      templateId: stageCta.templateId,
      templateTitle: stageCta.templateTitle,
      flowUniqueId: stageCta.flowUniqueId,
      followup6UseSameCtaAs3: config.followup6UseSameCtaAs3,
      followup9UseSameCtaAs3: config.followup9UseSameCtaAs3,
    });

    // OFF = plain follow-up only; no clickable CTA.
    if (mode === "off") {
      const result = await sendBotSailorText(record, message, `${label}_plain`);
      await logWhatsAppSend(table, record, `${label}:plain`, result);
      return result;
    }

    // Template gets the admin-editable custom title on the reply button.
    // Flow gets the imported BotSailor flow name on the reply button.
    let buttonTitle = "Call for Admission";

    if (mode === "template") {
      buttonTitle = stageCta.templateTitle;
    } else if (mode === "flow") {
      const selectedFlowId = stageCta.flowUniqueId;
      const flowRecord = selectedFlowId
        ? await getSelectedFlowRecord(selectedFlowId)
        : null;
      buttonTitle = String(flowRecord?.name || "Call for Admission").trim();
    }

    // WhatsApp reply-button title max is 20 characters.
    buttonTitle = buttonTitle.slice(0, 20);

    const buttonId = `gvcta_${randomUUID().replaceAll("-", "")}`;
    console.log("CTA ROUTING v2 | sending", { stage: stageCta.stage, templateId: stageCta.templateId, buttonId });
    // Persist the selected action before sending, so a fast click can resolve it.
    await pool.query(
      `INSERT INTO cta_sent_buttons (button_id, mobile, normalized_title, visible_title, cta_config)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [buttonId, botSailorPhone(record.mobile), normalizeLooseText(buttonTitle), buttonTitle, JSON.stringify(stageCta)]
    );
    const result = await sendBotSailorReplyButton(
      record,
      message,
      `${label}_cta_button`,
      buttonTitle,
      buttonId
    );
    if (result.success) {
      const messageId = result.response?.wa_message_id || result.response?.message_id ||
        result.response?.messages?.[0]?.id || result.response?.data?.wa_message_id || null;
      await pool.query("UPDATE cta_sent_buttons SET sent = TRUE, message_id = $2 WHERE button_id = $1", [buttonId, messageId]);
    } else {
      await pool.query("DELETE FROM cta_sent_buttons WHERE button_id = $1", [buttonId]);
    }
    await logWhatsAppSend(table, record, `${label}:cta_button:${mode}`, result);
    return result;
  }

  const result = await sendBotSailorText(record, message, label);
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
    const webhookMobile = cleanMobile(mobile);
    const webhookMobile10 =
      webhookMobile.length === 12 && webhookMobile.startsWith("91")
        ? webhookMobile.slice(2)
        : webhookMobile;

    const duplicateResult = await pool.query(
      `SELECT * FROM leads
       WHERE regexp_replace(COALESCE(mobile, ''), '\\D', '', 'g') IN ($1, $2)
         AND created_at >= CURRENT_TIMESTAMP - INTERVAL '15 days'
       ORDER BY created_at DESC
       LIMIT 1`,
      [webhookMobile, webhookMobile10]
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

// Serialize each catalog refresh and atomically preserve the old snapshot on failure.
async function syncBotSailorCatalog(table, key, run) {
  let db;
  try {
    db = await pool.connect();
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [table]);
    const result = await run(db);
    if (!result.success) { await db.query("ROLLBACK"); return result; }
    await db.query(`UPDATE ${table} SET raw = COALESCE(raw, '{}'::jsonb) ||
      jsonb_build_object('crm_sync_missing', NOT (${key} = ANY($1::text[])))`, [result.ids]);
    await db.query("COMMIT");
    const { ids, ...response } = result;
    return response;
  } catch (err) {
    if (db) await db.query("ROLLBACK").catch(() => {});
    console.error("BotSailor catalog sync failed:", err.message);
    return { success: false, message: "Catalog sync failed; saved list was preserved. " + err.message };
  } finally { if (db) db.release(); }
}

function completeBotSailorList(response, key) {
  const message = response?.message;
  const list = Array.isArray(message) ? message : message && typeof message === "object" && message[key] ? [message] : null;
  if (!list || list.some(item => !item || !String(item[key] || "").trim())) {
    throw new Error("Invalid catalog response");
  }
  // Reject advertised partial pages instead of hiding unseen records.
  for (const meta of [response, response?.pagination, response?.meta].filter(Boolean)) {
    if (meta.next_page_url || meta.next_page || meta.next_cursor || meta.has_more === true ||
        (Number(meta.last_page) > 1) || (Number(meta.total_pages) > 1) ||
        (meta.total != null && Number(meta.total) !== list.length)) {
      throw new Error("Incomplete catalog response");
    }
  }
  return [...new Map(list.map(item => [String(item[key]), item])).values()];
}

async function importBotSailorTemplates() {
  return syncBotSailorCatalog("whatsapp_templates", "botsailor_id", async (db) => {
  const result = await botSailorPost("https://botsailor.com/api/v1/whatsapp/get/template/list", {
    apiToken: config.botsailorToken,
    phone_number_id: config.botsailorInstanceId,
  });

  if (!result.success) return result;

  const list = completeBotSailorList(result.response, "id");

  let imported = 0;
  for (const item of list) {
    if (!item?.id) continue;
    let variableMap = {};
    try {
      variableMap = typeof item.variable_map === "string" ? JSON.parse(item.variable_map) : item.variable_map || {};
    } catch {
      variableMap = {};
    }

    await db.query(
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

  return { success: true, status: "imported", imported, ids: list.map(item => String(item.id)), response: result.response };
  });
}

async function importBotSailorFlows() {
  return syncBotSailorCatalog("botsailor_flows", "unique_id", async (db) => {
  const result = await botSailorPost("https://botsailor.com/api/v1/whatsapp/get/bot-flow-list", {
    apiToken: config.botsailorToken,
    phone_number_id: config.botsailorInstanceId,
  });

  if (!result.success) return result;
  const list = completeBotSailorList(result.response, "unique_id");
  let imported = 0;

  for (const item of list) {
    if (!item?.unique_id) continue;
    await db.query(
      `INSERT INTO botsailor_flows
       (botsailor_id, name, unique_id, status, raw, imported_at)
       VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)
       ON CONFLICT (unique_id)
       DO UPDATE SET
         botsailor_id = EXCLUDED.botsailor_id,
         name = EXCLUDED.name,
         status = EXCLUDED.status,
         -- Refresh live BotSailor metadata without deleting an older local
         -- Export Flow Data snapshot that may be needed as a fallback.
         raw = COALESCE(botsailor_flows.raw, '{}'::jsonb) || EXCLUDED.raw,
         imported_at = CURRENT_TIMESTAMP`,
      [String(item.id || ""), item.name || "Bot Flow", String(item.unique_id), String(item.status ?? ""), JSON.stringify(item)]
    );
    imported += 1;
  }

  return { success: true, status: "imported", imported, ids: list.map(item => String(item.unique_id)), response: result.response };
  });
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
      if (!config.whatsappEnabled || !config.whatsappAutoFollowupEnabled) {
        summary.reason = "automation_disabled";
        break;
      }
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
          Boolean(config.windowClosingUseCallButton)
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

function buildTestAutomationConfig(saved, draft = {}) {
  const result = { ...saved };
  // Only copy message/CTA fields. Credentials and live automation switches
  // always remain server-owned; this object is never persisted or made global.
  for (const key of Object.keys(saved)) {
    if (!/^(followup[369](Message|UseCallButton|UseSameCtaAs3|CtaActionMode|CtaTemplateId|CtaTemplateCustomTitle|CtaFlowUniqueId)|windowClosing(Message|UseCallButton|UseSameCtaAs3|CtaActionMode|CtaTemplateId|CtaTemplateCustomTitle|CtaFlowUniqueId)|callForAdmission(ActionMode|TemplateId|TemplateCustomTitle|FlowUniqueId))$/.test(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(draft, key)) continue;
    if (typeof saved[key] === "boolean" && typeof draft[key] === "boolean") result[key] = draft[key];
    else if (typeof draft[key] === "string" || typeof draft[key] === "number") {
      if (typeof saved[key] !== "boolean") result[key] = String(draft[key]);
    }
  }
  return result;
}

app.post("/api/admin/automation/test-mobile", async (req, res) => {
  try {
    await loadPersistedConfig();
    const testConfig = buildTestAutomationConfig(config, req.body?.settings || {});

    const mobile = cleanMobile(req.body?.mobile || "");
    const stage = String(req.body?.stage || "3h").trim().toLowerCase();
    if (!["3h", "6h", "9h", "window"].includes(stage)) return res.status(400).json({ success: false, message: "Invalid test stage" });

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
    let message = testConfig.followup3Message;
    let useCallButton = Boolean(testConfig.followup3UseCallButton);

    console.log("CTA DEBUG | automation test config", {
      stage,
      mobile: botSailorPhone(mobile),
      followup3UseCallButton: Boolean(config.followup3UseCallButton),
      followup6UseCallButton: Boolean(config.followup6UseCallButton),
      callForAdmissionFlowUniqueId: config.callForAdmissionFlowUniqueId || "",
    });

    if (stage === "6h") {
      label = "test_followup_6h";
      message = testConfig.followup6Message;
      useCallButton = Boolean(testConfig.followup6UseCallButton);
    } else if (stage === "9h") {
      label = "test_followup_9h";
      message = testConfig.followup9Message;
      useCallButton = Boolean(testConfig.followup9UseCallButton);
    } else if (stage === "window") {
      label = "test_window_closing";
      message = testConfig.windowClosingMessage;
      useCallButton = Boolean(testConfig.windowClosingUseCallButton);
    }

    const result = await sendAndLogText("automation_test", testRecord, label, message, useCallButton, testConfig);

    return res.status(result.success ? 200 : 400).json({
      success: Boolean(result.success),
      message: result.success ? "Test WhatsApp/CTA sent successfully" : (result.message || "Test send failed"),
      data: { mobile, stage, usedCallButton: useCallButton, response: result.response || null }
    });
  } catch (err) {
    console.error("❌ Test-only WhatsApp error:", err.message);
    return res.status(500).json({ success: false, message: err.message || "Test send failed" });
  }
});

app.post("/api/admin/automation/test-cta-only", async (req, res) => {
  try {
    await loadPersistedConfig();

    const mobile = cleanMobile(req.body?.mobile || "");
    if (!mobile || mobile.length < 10) {
      return res.status(400).json({ success: false, message: "Valid test mobile number required" });
    }

    const testRecord = {
      id: 0,
      name: String(req.body?.name || "Test Student").trim() || "Test Student",
      mobile,
      course: String(req.body?.course || "ACCA Complete Course").trim() || "ACCA Complete Course",
      owner: "Test Only",
    };

    const message =
      req.body?.message ||
      config.followup3Message ||
      "Hi {{name}},\n\nDo you need any assistance regarding {{course}}?";

    const result = await sendBotSailorReplyButton(
      testRecord,
      message,
      "test_call_for_admission_button"
    );

    return res.status(result.success ? 200 : 400).json({
      success: Boolean(result.success),
      message: result.success
        ? "Single WhatsApp message sent with Call for Admission button"
        : (result.message || "Interactive button test failed"),
      data: {
        mobile: botSailorPhone(mobile),
        buttonId: "call_for_admission",
        buttonTitle: "Call for Admission",
        ctaActionMode: config.callForAdmissionActionMode || "template",
        selectedFlowUniqueId: config.callForAdmissionFlowUniqueId || "",
        selectedTemplateId: config.callForAdmissionTemplateId || "",
        response: result.response || null,
      },
    });
  } catch (err) {
    console.error("❌ CTA-only interactive test error:", err.message);
    return res.status(500).json({
      success: false,
      message: err.message || "CTA-only interactive test failed",
    });
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
        callForAdmissionActionMode: config.callForAdmissionActionMode,
        callForAdmissionTemplateId: config.callForAdmissionTemplateId,
        callForAdmissionTemplateCustomTitle: config.callForAdmissionTemplateCustomTitle,
        callForAdmissionFlowUniqueId: config.callForAdmissionFlowUniqueId,
        callWithCounselorFlowUniqueId: config.callWithCounselorFlowUniqueId,
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
    const result = await pool.query("SELECT * FROM whatsapp_templates WHERE raw->>'crm_sync_missing' IS DISTINCT FROM 'true' ORDER BY imported_at DESC, template_name ASC");
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
    const result = await pool.query("SELECT * FROM botsailor_flows WHERE raw->>'crm_sync_missing' IS DISTINCT FROM 'true' ORDER BY imported_at DESC, name ASC");
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to load bot flows" });
  }
});

app.get("/api/admin/call-for-admission-options", async (req, res) => {
  try {
    await loadPersistedConfig();

    // Opening the options panel should discover newly created BotSailor flows
    // automatically. If BotSailor is temporarily unavailable, retain and show
    // the last successfully imported list instead of breaking the Admin page.
    if (config.botsailorToken && config.botsailorInstanceId) {
      try {
        const refreshResult = await importBotSailorFlows();
        if (!refreshResult.success) {
          console.error("Flow auto-refresh failed:", refreshResult.message);
        }
      } catch (refreshError) {
        console.error("Flow auto-refresh error:", refreshError.message);
      }
    }

    const [flowsResult, templatesResult] = await Promise.all([
      pool.query(
        "SELECT id, botsailor_id, name, unique_id, status, imported_at FROM botsailor_flows WHERE raw->>'crm_sync_missing' IS DISTINCT FROM 'true' ORDER BY imported_at DESC, name ASC"
      ),
      pool.query(
        "SELECT id, botsailor_id, template_name, locale, status, imported_at FROM whatsapp_templates WHERE raw->>'crm_sync_missing' IS DISTINCT FROM 'true' ORDER BY imported_at DESC, template_name ASC"
      ),
    ]);

    res.json({
      success: true,
      data: {
        mode: config.callForAdmissionActionMode || "template",
        selectedFlowUniqueId: config.callForAdmissionFlowUniqueId || "",
        selectedTemplateId: config.callForAdmissionTemplateId || "",
        templateCustomTitle: config.callForAdmissionTemplateCustomTitle || "Call for Admission",
        modes: [
          { value: "off", label: "Off" },
          { value: "flow", label: "Use Existing Flow" },
          { value: "template", label: "Use Existing Template" },
        ],
        flows: flowsResult.rows,
        templates: templatesResult.rows,
      },
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: `Failed to load Call for Admission options: ${err.message}`,
    });
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
      if (req.body.sendWhatsapp) {
        return res.status(400).json({ success: false, message: "Use Send WhatsApp Now separately. No changes were saved." });
      }
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
          const templateResult = await pool.query("SELECT * FROM whatsapp_templates WHERE id = $1 AND raw->>'crm_sync_missing' IS DISTINCT FROM 'true'", [templateId]);
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
// Manual sends do not update records, reminders, or automation timestamps.
for (const t of ["leads", "admissions", "appointments", "support", "faculty"]) {
  app.post(`/api/admin/${t}/:id/whatsapp`, async (req, res) => {
    let reserved = false;
    const requestId = String(req.body.requestId || "");
    const target = `${t}:${req.params.id}`;
    const fail = (message) => res.status(400).json({ success: false, message });
    try {
      if (!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId)) return fail("A valid send request ID is required.");
      const previous = await pool.query("SELECT * FROM manual_whatsapp_requests WHERE request_id=$1", [requestId]);
      if (previous.rows.length) {
        const prior = previous.rows[0];
        return res.status(prior.result && prior.target === target ? 200 : 409).json(
          prior.target === target && prior.result ? prior.result :
          { success: false, message: "This send is already processing or has an unknown outcome. Check WhatsApp logs before sending again." }
        );
      }
      const found = await pool.query(`SELECT * FROM ${t} WHERE id=$1`, [Number(req.params.id)]);
      const record = found.rows[0];
      if (!record) return res.status(404).json({ success: false, message: "Record not found" });
      if (!config.whatsappEnabled) return fail("WhatsApp integration is OFF.");
      if (!/^\d{10,15}$/.test(botSailorPhone(record.mobile))) return fail("Valid mobile number required.");
      const mode = req.body.whatsappMode;
      if (!["message", "template", "flow", "message_flow"].includes(mode)) return fail("Invalid WhatsApp send type.");
      // For other modules, use the newest known customer message for this phone.
      let windowRecord = record;
      if (t !== "leads") {
        const matched = await pool.query(
          `SELECT last_customer_message_at FROM leads
           WHERE RIGHT(regexp_replace(COALESCE(mobile,''), '[^0-9]', '', 'g'),10)=$1
           ORDER BY last_customer_message_at DESC NULLS LAST LIMIT 1`,
          [botSailorPhone(record.mobile).slice(-10)]
        );
        windowRecord = matched.rows[0] || {};
      }
      if (mode !== "template" && !hasOpenWhatsappWindow(windowRecord)) {
        return fail("24-hour WhatsApp window closed or unknown. Select an approved template.");
      }
      const message = String(req.body.whatsappMessage || "").trim();
      if (["message", "message_flow"].includes(mode) && !message) return fail("Message is required.");
      let template, variables = {}, flow;
      if (mode === "template") {
        const selected = await pool.query("SELECT * FROM whatsapp_templates WHERE id=$1 AND raw->>'crm_sync_missing' IS DISTINCT FROM 'true'", [Number(req.body.whatsappTemplateId)]);
        template = selected.rows[0];
        if (!template || String(template.status).trim().toLowerCase() !== "approved") return fail("Select an approved, active template. Archived templates cannot be sent.");
        try { variables = typeof req.body.templateVariables === "string" ? JSON.parse(req.body.templateVariables) : req.body.templateVariables || {}; }
        catch { return fail("Template variables must be valid JSON."); }
        if (!variables || Array.isArray(variables) || typeof variables !== "object") return fail("Template variables must be a JSON object.");
        if (["apiToken", "phoneNumberID", "botTemplateID", "sendToPhoneNumber"].some((key) => Object.hasOwn(variables, key))) {
          return fail("Template variables cannot override the recipient, template, or API credentials.");
        }
      }
      if (["flow", "message_flow"].includes(mode)) {
        flow = await getSelectedFlowRecord(String(req.body.whatsappFlowId || ""));
        if (!flow?.unique_id) return fail("Select an available imported BotSailor flow.");
      }
      const claim = await pool.query(
        "INSERT INTO manual_whatsapp_requests(request_id,target) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING request_id",
        [requestId, target]
      );
      if (!claim.rows.length) return res.status(409).json({ success: false, message: "Send already submitted. Check WhatsApp logs." });
      reserved = true;
      let result;
      if (mode === "message_flow") {
        result = await sendAndLogText(t, record, "manual_flow", message, true, {
          ...config, callForAdmissionActionMode: "flow", callForAdmissionFlowUniqueId: flow.unique_id,
        });
      } else {
        if (mode === "template") result = await sendBotSailorTemplate(record, template, variables);
        else if (mode === "flow") result = getFlowExportData(flow)
          ? await executeDirectBotSailorFlow(record, flow)
          : await triggerBotSailorFlow(record.mobile, flow.unique_id, { resetUserInput: false });
        else result = await sendBotSailorText(record, message, "manual_message");
        await logWhatsAppSend(t, record, `manual:${mode}`, result);
      }
      const response = { success: Boolean(result.success), message: result.success
        ? (mode === "flow" ? "Flow started successfully." : "WhatsApp sent successfully.")
        : (result.message || "Sending failed. Check logs before trying again."), whatsapp: result };
      await pool.query("UPDATE manual_whatsapp_requests SET result=$2::jsonb WHERE request_id=$1", [requestId, JSON.stringify(response)]);
      return res.json(response);
    } catch (err) {
      console.error("Manual WhatsApp error:", err.message);
      return res.status(500).json({ success: false, message: reserved
        ? "Send outcome could not be confirmed. Check WhatsApp logs; do not resend blindly."
        : "Could not validate send. No message was sent." });
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
    payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.interactive?.button_reply?.id ||
    payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.button?.payload ||
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

function collectWebhookStrings(value, out = [], depth = 0) {
  if (depth > 8 || value === null || value === undefined) return out;

  if (typeof value === "string" || typeof value === "number") {
    const str = String(value).trim();
    if (str) out.push(str);
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectWebhookStrings(item, out, depth + 1);
    return out;
  }

  if (typeof value === "object") {
    for (const item of Object.values(value)) {
      collectWebhookStrings(item, out, depth + 1);
    }
  }

  return out;
}

function normalizeLooseText(v = "") {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function payloadHasCallForAdmission(payload = {}) {
  const values = collectWebhookStrings(payload);

  return values.some((value) => {
    const txt = normalizeLooseText(value);
    return (
      txt === "call for admission" ||
      txt === "call admission" ||
      txt === "call for admissions" ||
      txt.includes("call for admission")
    );
  });
}

function extractWebhookMobileRobust(payload = {}) {
  const direct = extractWebhookMobile(payload);
  if (direct) return direct;

  const likelyPhoneKeys = new Set([
    "from",
    "mobile",
    "phone",
    "phone_number",
    "phonenumber",
    "wa_id",
    "waid",
    "contact",
    "contact_id",
    "contactid",
    "sender",
    "sender_id",
    "senderid",
    "whatsapp_number",
    "whatsappnumber",
  ]);

  const found = [];

  function walk(value, key = "", depth = 0) {
    if (depth > 8 || value === null || value === undefined) return;

    if (typeof value === "object") {
      if (Array.isArray(value)) {
        for (const item of value) walk(item, key, depth + 1);
      } else {
        for (const [k, v] of Object.entries(value)) {
          walk(v, String(k).toLowerCase(), depth + 1);
        }
      }
      return;
    }

    if (!likelyPhoneKeys.has(key)) return;

    const digits = cleanMobile(value);
    if (digits.length >= 10 && digits.length <= 15) {
      found.push(digits);
    }
  }

  walk(payload);
  return found[0] || "";
}

app.post("/api/admin/botsailor-flow-data/import", async (req, res) => {
  try {
    const flowData = req.body?.flowData ?? req.body?.data ?? req.body;
    const result = await importBotSailorFlowExport(flowData, req.body?.fileName || "");
    return res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/admin/botsailor-flow-data/import-bulk", async (req, res) => {
  try {
    await loadPersistedConfig();
    const items = Array.isArray(req.body?.flows)
      ? req.body.flows
      : Array.isArray(req.body?.exports)
        ? req.body.exports
        : [];

    if (!items.length) {
      return res.status(400).json({
        success: false,
        message: "Select at least one BotSailor Flow Data TXT/JSON file",
      });
    }
    if (items.length > 100) {
      return res.status(400).json({
        success: false,
        message: "Maximum 100 flow files can be imported at once",
      });
    }

    let flowListRefresh = null;
    if (config.botsailorToken && config.botsailorInstanceId) {
      try { flowListRefresh = await importBotSailorFlows(); }
      catch (refreshError) {
        flowListRefresh = { success: false, message: refreshError.message };
      }
    }

    const results = [];
    for (const item of items) {
      const fileName = String(item?.fileName || item?.name || "Flow Data file");
      const flowData = item?.flowData ?? item?.data ?? item;
      try {
        const result = await importBotSailorFlowExport(flowData, fileName);
        results.push({
          fileName,
          success: result.success,
          title: result.title || "",
          nodeCount: result.nodeCount || 0,
          message: result.message || (result.success ? "Imported" : "Import failed"),
        });
      } catch (itemError) {
        results.push({
          fileName,
          success: false,
          title: "",
          nodeCount: 0,
          message: itemError.message,
        });
      }
    }

    const imported = results.filter((item) => item.success).length;
    const failed = results.length - imported;
    return res.status(imported ? 200 : 400).json({
      success: failed === 0,
      imported,
      failed,
      total: results.length,
      message: `${imported} flow file(s) imported${failed ? `, ${failed} failed` : " successfully"}`,
      flowListRefresh,
      results,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/admin/botsailor-flow-data/status", async (req, res) => {
  try {
  const result = await pool.query(
    `SELECT id, botsailor_id, name, unique_id, status,
            CASE WHEN raw ? 'flow_export' THEN TRUE ELSE FALSE END AS flow_data_imported,
            raw->>'flow_export_imported_at' AS flow_data_imported_at,
            raw->>'flow_export_source_file' AS flow_data_source_file,
            CASE
              WHEN raw ? 'flow_export'
               AND jsonb_typeof(raw->'flow_export'->'nodes') = 'object'
              THEN (SELECT COUNT(*)::int FROM jsonb_object_keys(raw->'flow_export'->'nodes'))
              ELSE 0
            END AS flow_node_count,
            imported_at
     FROM botsailor_flows
     WHERE raw->>'crm_sync_missing' IS DISTINCT FROM 'true'
     ORDER BY name ASC`
  );
  const imported = result.rows.filter((item) => item.flow_data_imported).length;
  res.json({
    success: true,
    total: result.rows.length,
    imported,
    pending: result.rows.length - imported,
    flows: result.rows,
  });
  } catch (err) {
    console.error("Flow data status failed:", err.message);
    res.status(500).json({ success: false, message: "Flow data status could not be loaded. Please retry." });
  }
});

app.post("/api/webhook/botsailor", async (req, res) => {
  try {
    const payload = req.body || {};

    // Always reload saved Automation/Integration settings so a Render restart
    // cannot lose the selected BotSailor "Call us" flow from memory.
    await loadPersistedConfig();

    const mobile = extractWebhookMobileRobust(payload);

    const buttonReplyId = normalizeLooseText(extractButtonReplyId(payload));
    const buttonReplyTitle = normalizeLooseText(extractButtonReplyTitle(payload));

    // BotSailor can deliver a button tap as a normal user_message.
    const webhookUserMessageRaw = normalizeLooseText(
      payload.user_message ||
      payload.userMessage ||
      payload.message_text ||
      payload.messageText ||
      payload.reply_text ||
      payload.replyText ||
      ""
    );

    // BotSailor incoming webhook encodes interactive replies like:
    // "#button_reply#Call us". Strip that transport marker before matching.
    const webhookUserMessage = webhookUserMessageRaw
      // BotSailor currently sends "#button reply#<title>" (space),
      // while some payload variants may use "#button_reply#<title>".
      .replace(/^#button[ _-]*reply#/i, "")
      .trim();

    const payloadCallForAdmission = payloadHasCallForAdmission(payload);

    const effectiveCtas = await getAllEffectiveCtaConfigs();
    const incomingCtaTitle = webhookUserMessage || buttonReplyTitle;
    const titleMatches = effectiveCtas.filter(
      (item) =>
        item.mode !== "off" &&
        item.normalizedTitle &&
        incomingCtaTitle === item.normalizedTitle
    );
    const sentCta = mobile ? await resolveSentCta(mobile, payload, incomingCtaTitle) : { exact: false, cta: null, candidates: [] };
    console.log("CTA ROUTING v2 | resolving", { contextMessageId: ctaContextMessageId(payload), exact: sentCta.exact, stage: sentCta.cta?.stage || null, templateId: sentCta.cta?.templateId || null, candidates: sentCta.candidates.length });
    const matchedStageCta = sentCta.cta || (!sentCta.exact && !sentCta.candidates.length && titleMatches.length === 1 ? titleMatches[0] : null);

    const selectedFlowForClick = String(
      config.callForAdmissionFlowUniqueId ||
      config.callWithCounselorFlowUniqueId ||
      ""
    ).trim();
    const selectedFlowRecordForClick = selectedFlowForClick
      ? await getSelectedFlowRecord(selectedFlowForClick)
      : null;
    const configuredTemplateTitle = normalizeLooseText(
      config.callForAdmissionTemplateCustomTitle || "Call for Admission"
    );
    const configuredFlowTitle = normalizeLooseText(
      selectedFlowRecordForClick?.name || ""
    );

    const isCallForAdmissionClick =
      sentCta.exact || sentCta.candidates.length > 0 || titleMatches.length > 0 ||
      buttonReplyId === "call for admission" ||
      buttonReplyId === "call_for_admission" ||
      buttonReplyId === "call for admission 3h" ||
      buttonReplyId === "call for admission 6h" ||
      buttonReplyId === "call for admission 9h" ||
      buttonReplyId === "call_for_admission_3h" ||
      buttonReplyId === "call_for_admission_6h" ||
      buttonReplyId === "call_for_admission_9h" ||
      buttonReplyTitle === "call for admission" ||
      webhookUserMessage === "call for admission" ||
      (configuredTemplateTitle &&
        (buttonReplyTitle === configuredTemplateTitle ||
         webhookUserMessage === configuredTemplateTitle)) ||
      (configuredFlowTitle &&
        (buttonReplyTitle === configuredFlowTitle ||
         webhookUserMessage === configuredFlowTitle)) ||
      Boolean(matchedStageCta) ||
      payloadCallForAdmission;

    console.log("BOTSAILOR WEBHOOK DEBUG", {
      mobile: mobile ? botSailorPhone(mobile) : "",
      buttonReplyId,
      buttonReplyTitle,
      webhookUserMessageRaw,
      webhookUserMessage,
      payloadCallForAdmission,
      topLevelKeys: Object.keys(payload || {}),
    });

    if (!mobile) {
      return res.status(200).json({
        status: "ignored",
        message: "No mobile in payload",
        detectedCallForAdmission: isCallForAdmissionClick,
      });
    }

    // Global incoming webhook is a chat event, separate from the course HTTP API.
    // Update every existing record for this phone, regardless of lead age.
    // Never create a lead or increment enquiry_count just because someone chats.
    const direction = String(payload.direction || payload.message_direction || "").toLowerCase();
    const isCustomerEvent = !["outgoing", "outbound", "sent"].includes(direction) &&
      Boolean(webhookUserMessageRaw || buttonReplyId || buttonReplyTitle);
    let refreshedLeadIds = [];
    if (isCustomerEvent) {
      const canonical = botSailorPhone(mobile);
      const national = canonical.startsWith("91") && canonical.length === 12 ? canonical.slice(2) : canonical;
      // A real message ID prevents repeated webhook deliveries extending the window.
      const messageId = String(payload.wa_message_id || payload.message_id || "").trim() || `unidentified_${randomUUID()}`;
      const refreshed = await pool.query(
        `WITH accepted AS (
           INSERT INTO whatsapp_window_events(mobile,message_id) VALUES($1,$3)
           ON CONFLICT DO NOTHING RETURNING received_at
         )
         UPDATE leads SET last_customer_message_at = GREATEST(last_customer_message_at, accepted.received_at),
           window_closing_sent_at = NULL, updated_at = CURRENT_TIMESTAMP
         FROM accepted
         WHERE regexp_replace(COALESCE(leads.mobile,''), '[^0-9]', '', 'g') IN ($1,$2)
         RETURNING leads.*`, [canonical, national, messageId]
      );
      refreshedLeadIds = refreshed.rows.map((lead) => lead.id);
      for (const lead of refreshed.rows) {
        const index = db.leads.findIndex((item) => Number(item.id) === Number(lead.id));
        if (index !== -1) db.leads[index] = { ...db.leads[index], ...lead };
      }
      console.log("WHATSAPP WINDOW REFRESH", { mobile: canonical, leadIds: refreshedLeadIds, messageId });
    }


    // Dynamic exported-flow buttons are resolved before the generic CTA gate.
    // BotSailor commonly sends them as user_message "#button_reply#<button title>".
    if (sentCta.exact && !sentCta.cta) {
      return res.status(200).json({ status: "ignored", message: "Unknown CTA button for this mobile" });
    }
    if (!sentCta.exact && (sentCta.candidates.length > 1 || (!sentCta.candidates.length && titleMatches.length > 1))) {
      // Title-only webhooks cannot identify which identical button was clicked.
      // Ask explicitly instead of silently choosing the first or latest stage.
      const choices = sentCta.candidates.length ? sentCta.candidates.map(row => row.cta_config) : titleMatches;
      const uniqueChoices = [...new Map(choices.map(cta => [ctaSnapshotKey(cta), cta])).values()];
      if (uniqueChoices.length > 12) return res.status(200).json({ status: "ignored", message: "Too many historical CTA choices; original button ID required" });
      const buttons = [];
      for (const [index, cta] of uniqueChoices.entries()) {
        const id = `gvcta_${randomUUID().replaceAll("-", "")}`;
        const title = `${cta.stage} option ${index + 1}`;
        await pool.query(
          `INSERT INTO cta_sent_buttons (button_id, mobile, normalized_title, visible_title, cta_config)
           VALUES ($1,$2,$3,$4,$5::jsonb)`,
          [id, botSailorPhone(mobile), normalizeLooseText(title), title, JSON.stringify(cta)]
        );
        buttons.push({ id, title });
      }
      let result = { success: true };
      for (let offset = 0; offset < buttons.length; offset += 3) {
        const batch = buttons.slice(offset, offset + 3);
        result = await sendBotSailorReplyButtons({ mobile }, "Kaunsa follow-up kholna hai? Apna message select karein.", batch, "resolve_same_title_cta");
        for (const button of batch) {
        if (result.success) await pool.query("UPDATE cta_sent_buttons SET sent = TRUE WHERE button_id = $1", [button.id]);
        else await pool.query("DELETE FROM cta_sent_buttons WHERE button_id = $1", [button.id]);
        }
        if (!result.success) break;
      }
      return res.status(result.success ? 200 : 400).json({ status: result.success ? "choose_stage" : "error" });
    }
    const runtimeAction = sentCta.exact || sentCta.cta ? null : await findFlowRuntimeAction(mobile, webhookUserMessage || buttonReplyTitle);
    if (runtimeAction) {
      const clean = cleanMobile(mobile);
      const clean10 = clean.length === 12 && clean.startsWith("91") ? clean.slice(2) : clean;
      const leadResult = await pool.query(
        `SELECT * FROM leads
         WHERE regexp_replace(COALESCE(mobile, ''), '\\D', '', 'g') IN ($1, $2)
         ORDER BY updated_at DESC NULLS LAST, created_at DESC
         LIMIT 1`,
        [clean, clean10]
      );
      const record = leadResult.rows[0] || {
        id: 0, mobile, name: payload.name || payload.first_name || "Student", course: payload.course || "",
      };

      const result = await executeRuntimeFlowAction(record, runtimeAction);
      console.log("DIRECT FLOW DEBUG | runtime button action", {
        title: webhookUserMessage || buttonReplyTitle,
        flow: runtimeAction.flow_name,
        success: result.success,
        status: result.status,
      });
      return res.status(result.success ? 200 : 400).json({
        status: result.success ? "ok" : "error",
        action: "direct_flow_button",
        flow: runtimeAction.flow_name,
        result: result.response || result.message || null,
      });
    }

    // CRM-direct Flow step 2 MUST be handled before the generic CTA gate.
    // BotSailor sends this reply as user_message "#button_reply#instant call us".
    if (
      !sentCta.cta && (webhookUserMessage === "instant call us" ||
      buttonReplyTitle === "instant call us")
    ) {
      console.log("CTA CLICK DEBUG | Instant Call us detected before generic CTA gate", {
        mobile,
        webhookUserMessageRaw,
        webhookUserMessage,
        buttonReplyTitle,
      });

      const templateRecord = await findCallUsTemplate(true);

      if (!templateRecord) {
        console.error("CTA CLICK DEBUG | call_us template not found");
        return res.status(400).json({
          status: "error",
          action: "flow_direct_send_call_us_template",
          message: "Approved call_us template was not found/imported",
        });
      }

      const clean = cleanMobile(mobile);
      const clean10 =
        clean.length === 12 && clean.startsWith("91") ? clean.slice(2) : clean;

      const leadResult = await pool.query(
        `SELECT * FROM leads
         WHERE regexp_replace(COALESCE(mobile, ''), '\\D', '', 'g') IN ($1, $2)
         ORDER BY updated_at DESC NULLS LAST, created_at DESC
         LIMIT 1`,
        [clean, clean10]
      );

      const record = leadResult.rows[0] || {
        id: 0,
        mobile,
        name: payload.name || payload.first_name || "Student",
        course: payload.course || "",
      };

      const variables = buildTemplateVariables(templateRecord, record);
      const templateResult = await sendBotSailorTemplate(
        record,
        templateRecord,
        variables
      );

      await logWhatsAppSend(
        "leads",
        record,
        `flow_direct:template:${templateRecord.template_name}`,
        templateResult
      );

      console.log("CTA CLICK DEBUG | Instant Call us -> call_us template", {
        success: templateResult.success,
        status: templateResult.status,
        templateId: templateRecord.botsailor_id,
        templateName: templateRecord.template_name,
        message: templateResult.message,
      });

      return res.status(templateResult.success ? 200 : 400).json({
        status: templateResult.success ? "ok" : "error",
        action: "flow_direct_send_call_us_template",
        message: templateResult.success
          ? "call_us template sent after Instant Call us click"
          : (templateResult.message || "Failed to send call_us template"),
        template: templateRecord.template_name,
        template_id: templateRecord.botsailor_id,
        result: templateResult.response || null,
      });
    }

    if (isCallForAdmissionClick) {
      const clickedStage = matchedStageCta?.stage ||
        (buttonReplyId.includes("6h") ? "6h" :
         buttonReplyId.includes("9h") ? "9h" : "3h");
      const clickCta = matchedStageCta || getStageCtaConfig(clickedStage);
      const actionMode = clickCta.mode;

      console.log("CTA CLICK DEBUG | Call for Admission detected", {
        mobile: botSailorPhone(mobile),
        buttonReplyId,
        buttonReplyTitle,
        payloadCallForAdmission,
        actionMode,
        clickedStage,
        selectedFlow: clickCta.flowUniqueId || "",
        selectedTemplate: clickCta.templateId || "",
      });

      // Refresh the customer's 24-hour window if this mobile already exists.
      await pool.query(
        `UPDATE leads
         SET last_customer_message_at = CURRENT_TIMESTAMP,
             window_closing_sent_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE regexp_replace(COALESCE(mobile, ''), '\\D', '', 'g')
               IN ($1, $2)`,
        [
          cleanMobile(mobile),
          cleanMobile(mobile).length === 12 && cleanMobile(mobile).startsWith("91")
            ? cleanMobile(mobile).slice(2)
            : cleanMobile(mobile),
        ]
      );

      // OFF mode: keep the reply recorded, but do not send/trigger anything else.
      if (actionMode === "off") {
        return res.status(200).json({
          status: "ok",
          action: "cta_off",
          message: "Call for Admission click recorded; CTA action mode is OFF",
        });
      }

      // FLOW mode:
      // Keep the proven CRM-direct workaround ONLY for the legacy
      // "Call with Counselor" flow. Every other selected imported flow
      // must execute its own BotSailor flow instead of receiving
      // the hard-coded "Instant Call us" counselor step.
      if (actionMode === "flow") {
        const clean = cleanMobile(mobile);
        const clean10 =
          clean.length === 12 && clean.startsWith("91") ? clean.slice(2) : clean;

        const leadResult = await pool.query(
          `SELECT * FROM leads
           WHERE regexp_replace(COALESCE(mobile, ''), '\\D', '', 'g') IN ($1, $2)
           ORDER BY updated_at DESC NULLS LAST, created_at DESC
           LIMIT 1`,
          [clean, clean10]
        );

        const record = leadResult.rows[0] || {
          id: 0,
          mobile,
          name: payload.name || payload.first_name || "Student",
          course: payload.course || "",
        };

        let selectedFlowRecord = clickCta.flowUniqueId
          ? await getSelectedFlowRecord(clickCta.flowUniqueId)
          : null;

        // A newly created flow may not yet exist in the local cache. Refresh
        // once from BotSailor and retry before treating the selection as bad.
        if (!selectedFlowRecord?.unique_id && clickCta.flowUniqueId) {
          await importBotSailorFlows();
          selectedFlowRecord = await getSelectedFlowRecord(clickCta.flowUniqueId);
        }

        if (!selectedFlowRecord?.unique_id) {
          console.error("CTA CLICK DEBUG | selected flow not found", {
            selectedFlow: clickCta.flowUniqueId || "",
            clickedStage,
          });
          return res.status(400).json({
            status: "error",
            action: "trigger_selected_flow",
            message: "Selected BotSailor flow was not found/imported",
          });
        }

        // Imported TXT/JSON is the confirmed working route. Use BotSailor's
        // live trigger only when this flow has no stored Flow Data yet.
        let flowResult;
        if (getFlowExportData(selectedFlowRecord)) {
          flowResult = await executeDirectBotSailorFlow(record, selectedFlowRecord);
        } else {
          flowResult = await triggerBotSailorFlow(
            mobile,
            selectedFlowRecord.unique_id,
            { resetUserInput: false }
          );
        }

        await logWhatsAppSend(
          "leads",
          record,
          `flow:${selectedFlowRecord.name || selectedFlowRecord.unique_id}`,
          flowResult
        );

        console.log("CTA CLICK DEBUG | selected BotSailor flow result", {
          success: flowResult.success,
          status: flowResult.status,
          message: flowResult.message,
          selectedFlowName: selectedFlowRecord.name,
          selectedFlowBotsailorId: selectedFlowRecord.botsailor_id,
          selectedFlowUniqueId: selectedFlowRecord.unique_id,
          mobile: botSailorPhone(mobile),
        });

        return res.status(flowResult.success ? 200 : 400).json({
          status: flowResult.success ? "ok" : "error",
          action: "execute_selected_flow",
          message: flowResult.success
            ? "Selected flow executed"
            : (flowResult.message || "Failed to trigger selected BotSailor flow"),
          flow: selectedFlowRecord.name,
          flow_unique_id: selectedFlowRecord.unique_id,
          result: flowResult.response || null,
        });
      }

      // TEMPLATE mode: send the imported template selected in Admin.
      if (actionMode === "template") {
        const templateRecord = await findSelectedCtaTemplate(true, clickCta.templateId);

        if (!templateRecord) {
          return res.status(400).json({
            status: "error",
            action: "send_selected_template",
            message: "CTA mode is Template but selected BotSailor template was not found/imported",
          });
        }

        const clean = cleanMobile(mobile);
        const clean10 =
          clean.length === 12 && clean.startsWith("91") ? clean.slice(2) : clean;

        const leadResult = await pool.query(
          `SELECT * FROM leads
           WHERE regexp_replace(COALESCE(mobile, ''), '\\D', '', 'g') IN ($1, $2)
           ORDER BY updated_at DESC NULLS LAST, created_at DESC
           LIMIT 1`,
          [clean, clean10]
        );

        const record = leadResult.rows[0] || {
          id: 0,
          mobile,
          name: payload.name || payload.first_name || "Student",
          course: payload.course || "",
        };

        const variables = buildTemplateVariables(templateRecord, record);
        const templateResult = await sendBotSailorTemplate(
          record,
          templateRecord,
          variables
        );

        await logWhatsAppSend(
          "leads",
          record,
          `template:${templateRecord.template_name}`,
          templateResult
        );

        console.log("CTA CLICK DEBUG | selected template result", {
          success: templateResult.success,
          status: templateResult.status,
          message: templateResult.message,
          templateId: templateRecord.botsailor_id,
          templateName: templateRecord.template_name,
        });

        return res.status(templateResult.success ? 200 : 400).json({
          status: templateResult.success ? "ok" : "error",
          action: "send_selected_template",
          message: templateResult.success
            ? "Selected BotSailor template sent"
            : (templateResult.message || "Failed to send selected BotSailor template"),
          template: templateRecord.template_name,
          template_id: templateRecord.botsailor_id,
          result: templateResult.response || null,
        });
      }

      return res.status(400).json({
        status: "error",
        action: "invalid_cta_mode",
        message: `Invalid Call for Admission action mode: ${config.callForAdmissionActionMode}`,
      });
    }

    // Chat events finish here; only the course-selection HTTP request is an enquiry.
    if (isCustomerEvent) {
      return res.status(200).json({ status: "ok", message: "Customer message recorded; existing lead windows refreshed", leadIds: refreshedLeadIds });
    }
    if (!String(payload.course || "").trim()) {
      return res.status(200).json({ status: "ignored", message: "No course enquiry or customer message in payload" });
    }

    // Course-selection enquiry keeps the existing 15-day business rule.
    const duplicateResult = await pool.query(
      `SELECT * FROM leads
       WHERE regexp_replace(COALESCE(mobile, ''), '\\D', '', 'g') IN ($1, $2)
         AND created_at >= CURRENT_TIMESTAMP - INTERVAL '15 days'
       ORDER BY created_at DESC
       LIMIT 1`,
      [botSailorPhone(mobile), botSailorPhone(mobile).startsWith("91") && botSailorPhone(mobile).length === 12 ? botSailorPhone(mobile).slice(2) : botSailorPhone(mobile)]
    );

    if (duplicateResult.rows.length) {
      const existingLead = duplicateResult.rows[0];
      // Chat-window updates must not suppress an actual later course enquiry.
      const oldLastCustomer = existingLead.last_enquiry_at
        ? new Date(existingLead.last_enquiry_at)
        : null;
      const isReplyInsideCurrentWindow = oldLastCustomer && !Number.isNaN(oldLastCustomer.getTime()) && (Date.now() - oldLastCustomer.getTime()) < DAY;

      // Repeat course submissions within a day of the last enquiry are one enquiry.
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
    // Refresh BotSailor flow list first so exported Flow Data can attach by exact flow title.
    if (config.botsailorToken && config.botsailorInstanceId) {
      try { await importBotSailorFlows(); } catch (err) { console.error("Flow list refresh before seed failed:", err.message); }
    }
    await seedBuiltinFlowExports();

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

bootstrap()
const BUILTIN_FLOW_EXPORTS = [{"id":"xitFB@0.0.1","nodes":{"1":{"id":1,"data":{"title":"Interview Address","postbackId":"6aabdebe80c39","xitFbpostbackId":"6aabdebe80c3b","buttonWebhookUrl":"","labelIds":[],"labelIdTextsArray":[],"labelIdsRemove":[],"labelIdTextsArrayRemove":[],"googleSheets":[],"googleSheetsArray":[],"sequenceIdValue":"","sequenceIdText":"Select a Sequence","sequenceIdValueRemove":"","sequenceIdTextRemove":"Select a Sequence","conversationGroupId":"","conversationGroupText":"Select Team Role","conversationUserId":"","conversationUserText":"Select Team Member","triggerKeyword":"Interview Address","triggerMatchingType":"exact"},"inputs":{"referenceInputActionButton":{"connections":[]}},"outputs":{"referenceOutput":{"connections":[{"node":3,"input":"textInput","data":[]}]},"referenceOutputSequence":{"connections":[]}},"position":[-450,-50],"name":"Start Bot Flow"},"3":{"id":3,"data":{"uniqueId":"6aabdebe80c46","textMessage":"\ud83c\udfdb *Interview Address : - Head Office*\n\n*Guruvidya Academy Pvt. Ltd.*\nWZ-49, Near Tagore Garden Metro Gate No. 2, Opp. Metro Pillar No. 433, New Delhi - 110027.\n\n\ud83d\udccd Map-  https://g.co/kgs/L2JRtK\n\n\ud83d\udc4d*Wait for MSG* *\"Your Interview is confirmed or not\"*\n\n\ud83d\udce3 *MSG send by HR Team if your selected date and time slot is avilable or not*","delayReplyFor":"0"},"inputs":{"textInput":{"connections":[{"node":1,"output":"referenceOutput","data":[]}]}},"outputs":{"textOutput":{"connections":[]}},"position":[-50.52569580078125,-73.35858154296875],"name":"Text"}}},{"id":"xitFB@0.0.1","nodes":{"1":{"id":1,"data":{"title":"Call with Counselor","postbackId":"6aabdfae453a3","xitFbpostbackId":"6aabdfae453aa","buttonWebhookUrl":"","labelIds":["80125"],"labelIdTextsArray":["Call with Counselor"],"labelIdsRemove":[],"labelIdTextsArrayRemove":[],"sequenceIdValue":"","sequenceIdText":"Select a Sequence","sequenceIdValueRemove":"","sequenceIdTextRemove":"Select a Sequence","conversationGroupId":"","conversationGroupText":"Select Team Role","conversationUserId":"","conversationUserText":"Select Team Member","triggerKeyword":"call, call me, call us, Call with Counselor","triggerMatchingType":"exact","googleSheets":[],"googleSheetsArray":[],"listIds":[],"listIdTextsArray":[],"listIdsRemove":[],"listIdTextsArrayRemove":[],"customFieldId":"","customFieldSelectedOptionText":"Select"},"inputs":{"referenceInputActionButton":{"connections":[]}},"outputs":{"referenceOutput":{"connections":[{"node":416,"input":"interactiveInput","data":[]}]},"referenceOutputSequence":{"connections":[]}},"position":[-450,-138.5],"name":"Start Bot Flow"},"415":{"id":415,"data":{"postbackId":"6aabdfae453c0","buttonText":"Instant Call us","buttonWebhookUrl":"","buttonType":"post_back","text":"Start a Flow","value":"3H8bBS-ach-2ruj","postback_text":"Call us","labelIds":[],"labelIdTextsArray":[],"labelIdsRemove":[],"labelIdTextsArrayRemove":[],"googleSheets":[],"googleSheetsArray":[],"sequenceIdValue":"","sequenceIdText":"Select a Sequence","sequenceIdValueRemove":"","sequenceIdTextRemove":"Select a Sequence","conversationGroupId":"","conversationGroupText":"Select Team Role","conversationUserId":"","conversationUserText":"Select Team Member","rowType":"static","customFieldIndex":"","customFieldIndexTitle":"","listIds":[],"listIdTextsArray":[],"listIdsRemove":[],"listIdTextsArrayRemove":[],"customFieldId":"","customFieldSelectedOptionText":"Select","appointment_id":"","appointment_text":"Select","googleCalendar":"","saveGoogleMeetToCustomField":false,"googleMeetCustomField":"","googleMeetCustomFieldSelectedOptionText":"Select"},"inputs":{"buttonInput":{"connections":[{"node":416,"output":"interactiveOutputButton","data":[]}]}},"outputs":{"buttonOutput":{"connections":[]},"buttonOutputSequence":{"connections":[]}},"position":[198,-133.5],"name":"Inline Button"},"416":{"id":416,"data":{"uniqueId":"6aabdfae453d0","headerType":"text","headerText":"","mediaType":"","headerMediaUrl":"","headerMediaID":"","textMessage":"*Dear #LEAD_USER_FIRST_NAME#,*\n\n*Session with Guruvidya Admission Team*\n\n\ud83d\udd57 *Upto 10 min*\n\n\ud83d\udcde *By Phone Call*\n\nGet all your queries answered regarding admission process.","footerText":"","original_file_name":"","delayReplyFor":0,"delaySec":0,"delayMin":0,"delayHour":0,"IsTypingOnDisplayChecked":false},"inputs":{"interactiveInput":{"connections":[{"node":1,"output":"referenceOutput","data":[]}]}},"outputs":{"interactiveOutput":{"connections":[]},"interactiveOutputButton":{"connections":[{"node":415,"input":"buttonInput","data":[]}]},"interactiveOutputListMessage":{"connections":[]},"interactiveOutputEcommerce":{"connections":[]}},"position":[-136,-170],"name":"Interactive"}}},{"id":"xitFB@0.0.1","nodes":{"1":{"id":1,"data":{"title":"New Batch Offer -MSG","postbackId":"6aabdfe3273d4","xitFbpostbackId":"6aabdfe3273d7","buttonWebhookUrl":"","labelIds":[],"labelIdTextsArray":[],"labelIdsRemove":[],"labelIdTextsArrayRemove":[],"googleSheets":[],"googleSheetsArray":[],"sequenceIdValue":"","sequenceIdText":"Select a Sequence","sequenceIdValueRemove":"","sequenceIdTextRemove":"Select a Sequence","conversationGroupId":"","conversationGroupText":"Select Team Role","conversationUserId":"","conversationUserText":"Select Team Member","triggerKeyword":"discount offer","triggerMatchingType":"exact","customFieldId":"","customFieldSelectedOptionText":"Select"},"inputs":{"referenceInputActionButton":{"connections":[]}},"outputs":{"referenceOutput":{"connections":[{"node":3,"input":"interactiveInput","data":[]}]},"referenceOutputSequence":{"connections":[]}},"position":[-450,-118.5],"name":"Start Bot Flow"},"3":{"id":3,"data":{"uniqueId":"6aabdfe3273e4","headerType":"media","headerText":"","mediaType":"","headerMediaUrl":"https://bot-data.s3.ap-southeast-1.wasabisys.com/upload/2025/7/flowbuilder/flowbuilder-98425-1751357615.png","headerMediaID":"616088480950581","textMessage":"*Dear #LEAD_USER_FIRST_NAME#,*\n\n\ud83d\udcc5 Batch Starting from 21st July 2026 \n\n\ud83c\udf89 Special Discount Valid Till 20th July 2026\n\n\u26a0 After 20th July 2026, regular fees will apply.\n\n\u2705 Expert Faculty\n\u2705 Complete Study Material\n\u2705 Mock Tests & Mentorship\n\u2705 Flexible Learning Options\n\u2705 Easy EMI Facility\n\n\u23f3 Limited Seats Available!\n\n\ud83d\udcde Reply to this message or call now to reserve your seat.\n","footerText":"By - Guruvidya Academy (P) Ltd. Team","original_file_name":"","delayReplyFor":0,"IsTypingOnDisplayChecked":false,"delaySec":0,"delayMin":0,"delayHour":0},"inputs":{"interactiveInput":{"connections":[{"node":1,"output":"referenceOutput","data":[]}]}},"outputs":{"interactiveOutput":{"connections":[]},"interactiveOutputButton":{"connections":[{"node":4,"input":"buttonInput","data":[]},{"node":7,"input":"buttonInput","data":[]},{"node":8,"input":"buttonInput","data":[]}]},"interactiveOutputListMessage":{"connections":[]},"interactiveOutputEcommerce":{"connections":[]}},"position":[-18.82509487349842,-212.45949539485042],"name":"Interactive"},"4":{"id":4,"data":{"postbackId":"6aabdfe3273f0","buttonText":"Enroll! - By Partial","buttonWebhookUrl":"","buttonType":"new_post_back","text":"Send Message","labelIds":[],"labelIdTextsArray":[],"labelIdsRemove":[],"labelIdTextsArrayRemove":[],"googleSheets":[],"googleSheetsArray":[],"sequenceIdValue":"","sequenceIdText":"Select a Sequence","sequenceIdValueRemove":"","sequenceIdTextRemove":"Select a Sequence","conversationGroupId":"","conversationGroupText":"Select Team Role","conversationUserId":"","conversationUserText":"Select Team Member","customFieldId":"","customFieldSelectedOptionText":"Select","newPostbackId":"6aabdfe3273f5"},"inputs":{"buttonInput":{"connections":[{"node":3,"output":"interactiveOutputButton","data":[]}]}},"outputs":{"buttonOutput":{"connections":[{"node":6,"input":"ctaUrlInput","data":[]}]},"buttonOutputSequence":{"connections":[]}},"position":[507,-412],"name":"Inline Button"},"6":{"id":6,"data":{"uniqueId":"6aabdfe3273fc","headerMessage":"Welcome to Guruvidya Payment Panel","bodyMessage":"Book your offline seat by partial payment Rs.5000.\n\nThis fee will be deducted from your total fee.","footerMessage":"","buttonText":"Partial Payment","buttonUrl":"https://rzp.io/rzp/batchbookingpartialfees","delayReplyFor":"0"},"inputs":{"ctaUrlInput":{"connections":[{"node":4,"output":"buttonOutput","data":[]}]}},"outputs":{"ctaUrlOutput":{"connections":[]}},"position":[819,-187],"name":"CTA URL Button"},"7":{"id":7,"data":{"postbackId":"6aabdfe327402","buttonText":"Enroll ! - By Visit","buttonWebhookUrl":"","buttonType":"post_back","text":"Start a Flow","value":"66fbb3b55f8b2","postback_text":"Visit Institute","labelIds":[],"labelIdTextsArray":[],"labelIdsRemove":[],"labelIdTextsArrayRemove":[],"googleSheets":[],"googleSheetsArray":[],"sequenceIdValue":"","sequenceIdText":"Select a Sequence","sequenceIdValueRemove":"","sequenceIdTextRemove":"Select a Sequence","conversationGroupId":"","conversationGroupText":"Select Team Role","conversationUserId":"","conversationUserText":"Select Team Member","customFieldId":"","customFieldSelectedOptionText":"Select"},"inputs":{"buttonInput":{"connections":[{"node":3,"output":"interactiveOutputButton","data":[]}]}},"outputs":{"buttonOutput":{"connections":[]},"buttonOutputSequence":{"connections":[]}},"position":[507,-164],"name":"Inline Button"},"8":{"id":8,"data":{"postbackId":"6aabdfe32740d","buttonText":"Call for Admission","buttonWebhookUrl":"","buttonType":"post_back","text":"Start a Flow","value":"3H8bBS-ach-2ruj","postback_text":"Call us","labelIds":[],"labelIdTextsArray":[],"labelIdsRemove":[],"labelIdTextsArrayRemove":[],"googleSheets":[],"googleSheetsArray":[],"sequenceIdValue":"","sequenceIdText":"Select a Sequence","sequenceIdValueRemove":"","sequenceIdTextRemove":"Select a Sequence","conversationGroupId":"","conversationGroupText":"Select Team Role","conversationUserId":"","conversationUserText":"Select Team Member","customFieldId":"","customFieldSelectedOptionText":"Select"},"inputs":{"buttonInput":{"connections":[{"node":3,"output":"interactiveOutputButton","data":[]}]}},"outputs":{"buttonOutput":{"connections":[]},"buttonOutputSequence":{"connections":[]}},"position":[507,124],"name":"Inline Button"}}}];

async function seedBuiltinFlowExports() {
  for (const flowData of BUILTIN_FLOW_EXPORTS) {
    try {
      const start = Object.values(flowData.nodes || {}).find(node => node.name === "Start Bot Flow");
      const existing = await pool.query(
        "SELECT raw FROM botsailor_flows WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))",
        [start?.data?.title || ""]
      );
      if (existing.rows.some(row => row.raw?.flow_export || row.raw?.crm_sync_missing === true)) continue;
      const result = await importBotSailorFlowExport(flowData);
      console.log("DIRECT FLOW DATA SEED", { title: result.title || "", success: result.success, nodeCount: result.nodeCount || 0, message: result.message || "" });
    } catch (err) {
      console.error("DIRECT FLOW DATA SEED ERROR", err.message);
    }
  }
}

;

import { reconcileStaleBookingAttempts } from './booking/booking-stale-attempts.js';
import { dispatchBookingReminders } from './booking/booking-delivery.js';
import { reconcileBookingQueue } from './booking/booking-queue-maintenance.js';
import { runBookingReminderQueue } from './booking/booking-reminders.js';
import { initBooking, installBookingRoutes, hasBookingSuppression } from "./booking/booking.js";
import express from "express";
import cors from "cors";
import axios from "axios";
import pg from "pg";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";

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

  // Compatibility fix for databases where integration_settings was created
  // previously without a PRIMARY KEY / UNIQUE constraint on id.
  // We intentionally keep this table as a single-row settings store, so no
  // ON CONFLICT constraint is required.
  await pool.query("BEGIN");
  try {
    await pool.query("DELETE FROM integration_settings WHERE id = 1");
    await pool.query(
      `INSERT INTO integration_settings (id, config, updated_at)
       VALUES (1, $1::jsonb, CURRENT_TIMESTAMP)`,
      [JSON.stringify(config)]
    );
    await pool.query("COMMIT");
  } catch (err) {
    await pool.query("ROLLBACK");
    throw err;
  }

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

    const templateValues = [
      String(item.id),
      String(item.template_id || ""),
      item.template_name || item.name || `Template ${item.id}`,
      item.locale || "",
      item.status || "",
      item.body_content || "",
      JSON.stringify(variableMap),
      JSON.stringify(item),
    ];
    // Compatibility with older databases where botsailor_id may not have a UNIQUE constraint.
    // Update first; insert only when this BotSailor template does not already exist.
    const updatedTemplate = await db.query(
      `UPDATE whatsapp_templates SET
         meta_template_id=$2, template_name=$3, locale=$4, status=$5,
         body_content=$6, variable_map=$7, raw=$8, imported_at=CURRENT_TIMESTAMP
       WHERE botsailor_id=$1`,
      templateValues
    );
    if (!updatedTemplate.rowCount) {
      await db.query(
        `INSERT INTO whatsapp_templates
         (botsailor_id, meta_template_id, template_name, locale, status, body_content, variable_map, raw, imported_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP)`,
        templateValues
      );
    }
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
    const flowValues = [
      String(item.id || ""),
      item.name || "Bot Flow",
      String(item.unique_id),
      String(item.status ?? ""),
      JSON.stringify(item),
    ];
    // Compatibility with older databases where unique_id may not have a UNIQUE constraint.
    // Keep any locally imported/exported flow data while refreshing live BotSailor metadata.
    const updatedFlow = await db.query(
      `UPDATE botsailor_flows SET
         botsailor_id=$1, name=$2, status=$4,
         raw=COALESCE(raw, '{}'::jsonb) || $5::jsonb,
         imported_at=CURRENT_TIMESTAMP
       WHERE unique_id=$3`,
      flowValues
    );
    if (!updatedFlow.rowCount) {
      await db.query(
        `INSERT INTO botsailor_flows
         (botsailor_id, name, unique_id, status, raw, imported_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,CURRENT_TIMESTAMP)`,
        flowValues
      );
    }
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
      // Booking suppression is checked on each run before window-closing and staged sends.
      if (await hasBookingSuppression(pool, lead.id)) { summary.skipped += 1; continue; }
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


    // FINAL APPROVED booking confirmation action buttons.
    const bookingAction = [buttonReplyId, buttonReplyTitle, webhookUserMessage]
      .map(v => normalizeLooseText(v));
    const bookingActionType = bookingAction.includes('booking_manage') || bookingAction.includes('manage appointment') ? 'manage'
      : bookingAction.includes('booking_maps') || bookingAction.includes('view on google maps') ? 'maps'
      : bookingAction.includes('booking_help') || bookingAction.includes('call / whatsapp us') || bookingAction.includes('call whatsapp us') ? 'help'
      : '';
    if (bookingActionType) {
      const canonical=botSailorPhone(mobile);
      const national=canonical.startsWith('91')&&canonical.length===12?canonical.slice(2):canonical;
      const br=await pool.query(`SELECT b.booking_ref FROM student_bookings b
        WHERE regexp_replace(COALESCE(b.student_mobile,''),'[^0-9]','','g') IN ($1,$2)
          AND b.status IN ('requested','approved','confirmed','rescheduled')
        ORDER BY b.created_at DESC LIMIT 1`,[canonical,national]);
      if(!br.rows[0]) return res.status(200).json({status:'ignored',message:'No active booking found for this mobile'});
      const booking=await loadBookingWhatsAppContext(br.rows[0].booking_ref);
      if(!booking) return res.status(200).json({status:'ignored',message:'Booking not found'});
      let reply='';
      if(bookingActionType==='manage') {
        // Rotate the private token each time the customer requests the manage link.
        const token=randomBytes(32).toString('hex');
        const tokenHash=createHash('sha256').update(token).digest('hex');
        await pool.query(`UPDATE student_bookings SET token_hash=$1,updated_at=NOW() WHERE id=$2`,[tokenHash,booking.id]);
        reply=`🔗 *Manage Appointment*\n${bookingManageUrl(booking,token)}\n\nUse this secure link to reschedule or cancel your appointment.`;
      } else if(bookingActionType==='maps') {
        reply=booking.mode==='offline'
          ? `📍 *Head Office Location*\n${booking.offline_location_name||'Head Office - Tagore Garden'}\n${booking.offline_address||''}\n\n${booking.offline_map_url||'Google Maps link is not configured yet.'}`
          : `🎥 *Online Counselling*\n${booking.meeting_link||'Your meeting link will be shared here.'}`;
      } else {
        reply=`☎️ *Need Help?*\nCall / WhatsApp GuruVidya\n+91 98216 27725\nhttps://wa.me/919821627725`;
      }
      const actionResult=await sendBotSailorText({mobile:booking.student_mobile,name:booking.student_name,course:booking.course},reply,`booking_action_${bookingActionType}`);
      return res.status(actionResult.success?200:400).json({status:actionResult.success?'ok':'error',action:`booking_action_${bookingActionType}`});
    }

    // Booking gate template: once the student taps Confirm Appointment, the inbound
    // reply itself opens/refreshes the 24-hour session. Rotate the private manage token
    // and immediately send the full session confirmation with actionable links.
    const bookingReplyText = normalizeLooseText(webhookUserMessage);
    const isBookingConfirmClick = [buttonReplyTitle, buttonReplyId, webhookUserMessage]
      .some(v => normalizeLooseText(v) === 'confirm appointment') ||
      bookingReplyText.startsWith('my appointment is confirmed');
    if (isBookingConfirmClick) {
      const canonical=botSailorPhone(mobile);
      const national=canonical.startsWith('91')&&canonical.length===12?canonical.slice(2):canonical;
      const br=await pool.query(`SELECT b.booking_ref FROM student_bookings b
        WHERE regexp_replace(COALESCE(b.student_mobile,''),'[^0-9]','','g') IN ($1,$2)
          AND b.status IN ('requested','approved','confirmed','rescheduled')
        ORDER BY b.created_at DESC LIMIT 1`,[canonical,national]);
      if(!br.rows[0]) return res.status(200).json({status:'ignored',message:'No active booking found for this mobile'});
      const token=randomBytes(32).toString('hex');
      const tokenHash=createHash('sha256').update(token).digest('hex');
      await pool.query(`UPDATE student_bookings SET token_hash=$1,customer_response='confirmed',response_at=NOW(),
        status=CASE WHEN status='requested' THEN 'confirmed' ELSE status END,updated_at=NOW() WHERE booking_ref=$2`,[tokenHash,br.rows[0].booking_ref]);
      const booking=await loadBookingWhatsAppContext(br.rows[0].booking_ref);
      const result=await sendBookingSessionConfirmation(booking,token,'booking_confirmation_after_gate');
      return res.status(result.success?200:400).json({status:result.success?'ok':'error',action:'booking_confirmation_after_gate'});
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


async function loadBookingWhatsAppContext(bookingRef) {
  // Booking may not have lead_id populated even though the same student's WhatsApp
  // conversation is already inside Meta's 24-hour customer-service window. Resolve
  // the newest inbound timestamp by BOTH linked lead and normalized student mobile.
  const r = await pool.query(`SELECT b.*, c.name AS counsellor_name, c.meeting_link,
    GREATEST(
      l.last_customer_message_at,
      (SELECT MAX(lm.last_customer_message_at) FROM leads lm
       WHERE RIGHT(REGEXP_REPLACE(COALESCE(lm.mobile,''),'[^0-9]','','g'),10)
           = RIGHT(REGEXP_REPLACE(COALESCE(b.student_mobile,''),'[^0-9]','','g'),10))
    ) AS last_customer_message_at,
    loc.name AS offline_location_name, loc.address AS offline_address, loc.map_url AS offline_map_url
    FROM student_bookings b
    LEFT JOIN booking_counsellors c ON c.id=b.counsellor_id
    LEFT JOIN leads l ON l.id=b.lead_id
    LEFT JOIN booking_locations loc ON loc.id=c.location_id
    WHERE b.booking_ref=$1 LIMIT 1`, [bookingRef]);
  return r.rows[0] || null;
}

function bookingIstParts(startsAt) {
  const d = new Date(startsAt);
  return {
    date: new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',day:'2-digit',month:'long',year:'numeric',weekday:'long'}).format(d),
    time: new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',hour:'numeric',minute:'2-digit',hour12:true}).format(d).replace(/am|pm/i,m=>m.toUpperCase())
  };
}

function bookingManageUrl(b, token) {
  const base = String(process.env.PUBLIC_BOOKING_URL || 'https://guruvidya-backend.onrender.com/booking').replace(/#.*$/,'');
  return `${base}#${new URLSearchParams({ref:b.booking_ref,token}).toString()}`;
}

async function findBookingConfirmationFlow() {
  // The imported BotSailor flow is the professional within-24h design with buttons.
  // Keep name matching tolerant so an existing imported catalogue continues to work.
  const q = await pool.query(`SELECT * FROM botsailor_flows
    WHERE raw->>'crm_sync_missing' IS DISTINCT FROM 'true'
      AND LOWER(TRIM(name)) IN ('booking confirmation','booking_confirmation')
      AND COALESCE(unique_id,'') <> ''
    ORDER BY imported_at DESC LIMIT 1`);
  if (q.rows[0]) return q.rows[0];
  try { await importBotSailorFlows(); } catch (e) { console.error('Booking Confirmation flow refresh failed:', e.message); }
  const q2 = await pool.query(`SELECT * FROM botsailor_flows
    WHERE raw->>'crm_sync_missing' IS DISTINCT FROM 'true'
      AND LOWER(TRIM(name)) IN ('booking confirmation','booking_confirmation')
      AND COALESCE(unique_id,'') <> ''
    ORDER BY imported_at DESC LIMIT 1`);
  return q2.rows[0] || null;
}

function xmlEsc(v='') { return String(v).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c])); }
function svgWrap(text, x, y, maxChars=38, line=34, attrs='') {
  const words=String(text||'').split(/\s+/); let cur='', out=[], yy=y;
  for (const w of words) { const t=cur?cur+' '+w:w; if(t.length>maxChars&&cur){out.push(cur);cur=w}else cur=t; }
  if(cur)out.push(cur);
  return out.map(v=>`<text x="${x}" y="${yy+=line}" ${attrs}>${xmlEsc(v)}</text>`).join('');
}
async function bookingCardPng(b) {
  // SERVER 46 FINAL MASTER GRAPHIC: Server 45 delivery/send/buttons untouched; only renderer header/detail layout changed.
  const {date,time}=bookingIstParts(b.starts_at);
  const place=b.mode==='offline'?(b.offline_location_name||'Head Office - Tagore Garden'):'Online Counselling';
  const address=b.mode==='offline'?(b.offline_address||'GuruVidya Academy, New Delhi'):'Online counselling appointment';
  const finalHeaderJpeg = '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';
  const rows=[
    ['doc','Booking Reference',b.booking_ref],
    ['person','Student Name',b.student_name],
    ['cap','Course',b.course],
    ['calendar','Date & Time (IST)',`${date} ${time}`],
    ['person','Counsellor',b.counsellor_name||'GuruVidya Admission Counsellor'],
    ['screen','Mode',b.mode==='offline'?`Offline - ${place}`:'Online'],
    ['pin','Location',address]
  ];
  const icon=(type,cx,cy)=>{
    const s='#083d9b', sw='7';
    if(type==='person') return `<circle cx="${cx}" cy="${cy-13}" r="13" fill="${s}"/><path d="M${cx-24} ${cy+23}c2-20 13-30 24-30s22 10 24 30z" fill="${s}"/>`;
    if(type==='cap') return `<path d="M${cx-28} ${cy-8}l28-15 28 15-28 15z" fill="${s}"/><path d="M${cx-18} ${cy+1}v15c10 8 26 8 36 0V1" fill="${s}"/><circle cx="${cx+27}" cy="${cy-7}" r="3" fill="${s}"/>`;
    if(type==='calendar') return `<rect x="${cx-24}" y="${cy-21}" width="48" height="45" rx="5" fill="none" stroke="${s}" stroke-width="6"/><path d="M${cx-24} ${cy-7}h48M${cx-13} ${cy-27}v12M${cx+13} ${cy-27}v12" stroke="${s}" stroke-width="6" stroke-linecap="round"/><rect x="${cx-12}" y="${cy+2}" width="8" height="8" fill="${s}"/><rect x="${cx+5}" y="${cy+2}" width="8" height="8" fill="${s}"/>`;
    if(type==='screen') return `<rect x="${cx-27}" y="${cy-20}" width="54" height="38" rx="4" fill="none" stroke="${s}" stroke-width="6"/><path d="M${cx} ${cy+18}v13M${cx-15} ${cy+31}h30" stroke="${s}" stroke-width="6" stroke-linecap="round"/>`;
    if(type==='pin') return `<path d="M${cx} ${cy+28}s-24-27-24-45a24 24 0 1148 0c0 18-24 45-24 45z" fill="${s}"/><circle cx="${cx}" cy="${cy-17}" r="8" fill="white"/>`;
    return `<path d="M${cx-20} ${cy-26}h29l13 13v39h-42z" fill="none" stroke="${s}" stroke-width="6" stroke-linejoin="round"/><path d="M${cx+9} ${cy-26}v13h13M${cx-11} ${cy}h24M${cx-11} ${cy+11}h24" stroke="${s}" stroke-width="5"/>`;
  };
  let rowSvg='', y=625;
  for(const [ic,k,v] of rows){
    rowSvg+=`${icon(ic,155,y-5)}<text x="215" y="${y}" class="key">${xmlEsc(k)}</text><text x="465" y="${y}" class="key">:</text>${svgWrap(v,515,y-36,34,30,'class="val"')}<line x1="115" y1="${y+39}" x2="955" y2="${y+39}" class="sep"/>`;
    y += ic==='pin'?118:82;
  }
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1420" viewBox="0 0 1080 1420">
  <defs>
    <linearGradient id="blue" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#072a79"/><stop offset=".55" stop-color="#0758c9"/><stop offset="1" stop-color="#08a7ed"/></linearGradient>
    <linearGradient id="cyan" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#0878e8"/><stop offset="1" stop-color="#09b9ed"/></linearGradient>
    <style>.key{font:700 27px Arial;fill:#092f83}.val{font:500 26px Arial;fill:#102f78}.sep{stroke:#d4e4ef;stroke-width:1.5}</style>
  </defs>
  <rect width="1080" height="1420" fill="#f8f3eb"/>
  <g opacity=".10" stroke="#cdbfae" fill="none"><circle cx="65" cy="110" r="18"/><circle cx="1015" cy="180" r="23"/><path d="M30 1320q40-35 80 0t80 0M900 70q35-30 70 0t70 0"/></g>
  <rect x="28" y="35" width="1024" height="1330" rx="42" fill="#fff"/>
  <!-- Exact approved final reference header, rasterized small to avoid the old SVG artefacts. -->
  <image href="data:image/jpeg;base64,${finalHeaderJpeg}" x="60" y="55" width="960" height="473" preserveAspectRatio="xMidYMid meet"/>
  <!-- details panel -->
  <rect x="62" y="550" width="956" height="770" rx="40" fill="#f5faff" stroke="#dbeaf5" stroke-width="2"/>
  ${rowSvg}
  </svg>`;
  return sharp(Buffer.from(svg)).png({quality:95}).toBuffer();
}

app.get('/api/public/booking/whatsapp-card/:ref.png', async (req,res)=>{
  try{
    const token=String(req.query.token||''); if(!/^[a-f0-9]{64}$/i.test(token)) return res.status(404).end();
    const r=await pool.query(`SELECT b.*,c.name AS counsellor_name,c.meeting_link,l.name AS offline_location_name,l.address AS offline_address,l.map_url AS offline_map_url FROM student_bookings b LEFT JOIN booking_counsellors c ON c.id=b.counsellor_id LEFT JOIN booking_locations l ON l.id=c.location_id WHERE b.booking_ref=$1 AND b.token_hash=$2 LIMIT 1`,[req.params.ref,createHash('sha256').update(token).digest('hex')]);
    if(!r.rowCount)return res.status(404).end();
    const png=await bookingCardPng(r.rows[0]); res.set({'Content-Type':'image/png','Cache-Control':'no-store, no-cache, must-revalidate, max-age=0','Pragma':'no-cache','Expires':'0','X-Content-Type-Options':'nosniff'}).send(png);
  }catch(e){console.error('WhatsApp booking card error:',e.message);res.status(500).end();}
});

async function sendBookingSessionConfirmation(b, token, action='booking_confirmation_24h') {
  // FINAL APPROVED 28-Sep within-24h WhatsApp design.
  // Use one native WhatsApp interactive card with three clean action buttons.
  // WhatsApp itself controls the exact button radius/colour; CRM controls the
  // content, order, icons/titles and booking-specific data.
  const {date,time}=bookingIstParts(b.starts_at);
  const place=b.mode==='offline'?(b.offline_location_name||'Head Office - Tagore Garden'):'Online Counselling';
  const address=b.mode==='offline'?(b.offline_address||'GuruVidya Academy, New Delhi'):'Meeting link is available in your booking.';
  // Keep the interactive message body visually empty: all booking content is in the image.
  // U+2063 is an invisible separator, used so BotSailor still receives a non-empty body.
  const msg='Appointment confirmed.';
  const result=await sendBotSailorReplyButtons(
    {mobile:b.student_mobile,name:b.student_name,course:b.course},
    msg,
    [
      {id:'booking_manage',title:'Manage Appointment'},
      {id:'booking_maps',title:'View on Google Maps'},
      {id:'booking_help',title:'Call / WhatsApp Us'}
    ],
    action,
    {
      mediaUrl:`${String(process.env.PUBLIC_API_URL || 'https://guruvidya-backend.onrender.com').replace(/\/$/,'')}/api/public/booking/whatsapp-card/${encodeURIComponent(b.booking_ref)}.png?token=${encodeURIComponent(token)}`,
      mediaType:'image',
    }
  );
  await pool.query(`INSERT INTO booking_delivery_logs(booking_id,event,recipient,channel,status,detail)
    VALUES($1,$2,'student','whatsapp',$3,$4) ON CONFLICT(booking_id,event,recipient,channel) DO UPDATE SET status=EXCLUDED.status,detail=EXCLUDED.detail,created_at=NOW()`,
    [b.id,action,result.success?'sent':'failed',result.message||result.status||'']);
  return { ...result, mode:'interactive_final_design' };
}

async function findBookingConfirmationTemplate() {
  const q=await pool.query(`SELECT * FROM whatsapp_templates WHERE raw->>'crm_sync_missing' IS DISTINCT FROM 'true'
    AND LOWER(template_name)=LOWER('booking_confirmation_fifteen_min') AND LOWER(COALESCE(status,'')) IN ('approved','active - quality pending','active') ORDER BY imported_at DESC LIMIT 1`);
  if(q.rows[0]) return q.rows[0];
  await importBotSailorTemplates();
  const q2=await pool.query(`SELECT * FROM whatsapp_templates WHERE raw->>'crm_sync_missing' IS DISTINCT FROM 'true'
    AND LOWER(template_name)=LOWER('booking_confirmation_fifteen_min') ORDER BY imported_at DESC LIMIT 1`);
  return q2.rows[0]||null;
}

function bookingTemplateVariables(t,b) {
  let map=t?.variable_map||{}; if(typeof map==='string'){try{map=JSON.parse(map)}catch{map={}}}
  const raw=JSON.stringify(map), keys=[...new Set(raw.match(/templateVariable-[A-Za-z0-9_-]+-\d+/g)||[])];
  const {date,time}=bookingIstParts(b.starts_at); const vals=[b.student_name,b.booking_ref,b.course,date,time];
  const out={};
  keys.sort((a,z)=>{const an=Number(a.match(/(\d+)$/)?.[1]||999),zn=Number(z.match(/(\d+)$/)?.[1]||999);return an-zn});
  keys.forEach((k,i)=>{const x=k.toLowerCase();out[k]=x.includes('student')||x.includes('name')?b.student_name:x.includes('ref')?b.booking_ref:x.includes('course')?b.course:x.includes('date')?date:x.includes('time')?time:(vals[i]||b.student_name)});
  // Common BotSailor numeric-variable generated keys; harmless extras are accepted by its endpoint.
  vals.forEach((v,i)=>{out[`templateVariable-${i+1}-${i+1}`]=v});
  return out;
}

async function sendBookingGateTemplate(b) {
  const t=await findBookingConfirmationTemplate();
  if(!t) return {success:false,status:'missing_template',message:'booking_confirmation_fifteen_min not imported'};
  const result=await sendBotSailorTemplate({mobile:b.student_mobile,name:b.student_name,course:b.course},t,bookingTemplateVariables(t,b));
  await pool.query(`INSERT INTO booking_delivery_logs(booking_id,event,recipient,channel,status,detail)
    VALUES($1,'booking_confirmation_gate','student','whatsapp',$2,$3) ON CONFLICT(booking_id,event,recipient,channel) DO UPDATE SET status=EXCLUDED.status,detail=EXCLUDED.detail,created_at=NOW()`,
    [b.id,result.success?'sent':'failed',result.message||result.status||'']);
  return result;
}

async function onBookingCreatedWhatsApp(created) {
  const b=await loadBookingWhatsAppContext(created.booking_ref);
  if(!b||!b.student_mobile) return {success:false,status:'no_student_mobile'};

  // Do not depend only on CRM's cached last_customer_message_at. BotSailor/Meta may
  // already have an open customer-service window even when the CRM timestamp is stale.
  // First try the professional Booking Confirmation flow. If BotSailor rejects it,
  // fall back to the approved outside-24h gate template.
  const sessionResult=await sendBookingSessionConfirmation(b,created.manage_token,'booking_confirmation_24h');
  if(sessionResult?.success) return sessionResult;
  return sendBookingGateTemplate(b);
}

// Kept for compatibility with any older code paths.
async function sendWhatsAppMessage(phone, message) {
  return sendBotSailorText({ mobile: phone, name: "Student", course: "" }, message, "legacy_send");
}

installBookingRoutes(app, pool, { onBookingCreated: onBookingCreatedWhatsApp });

async function bootstrap() {
  try {
    await pool.query("SELECT NOW()");
    console.log("✅ PostgreSQL connected successfully");
    await initDatabase();
    await initBooking(pool);
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
    // Build 5: persist pending booking reminders and internal unanswered alerts only.
    // No outbound WhatsApp/email is sent by this scheduler.
    const queueBooking = () => reconcileStaleBookingAttempts(pool).then(() => reconcileBookingQueue(pool)).then(() => runBookingReminderQueue(pool)).then(() => dispatchBookingReminders(pool, sendBotSailorTemplate)).catch(e => console.error('Booking queue error:', e.message));
    setInterval(queueBooking, 60 * 1000);
    setTimeout(queueBooking, 15 * 1000);
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

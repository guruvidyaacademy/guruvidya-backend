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

// Render free instance has a 512 MB RAM ceiling. Sharp/libvips keeps a
// process-wide cache and may use multiple worker threads by default; repeated
// WhatsApp card fetches can therefore push the service over that limit. Keep
// the approved card design/output unchanged, but use a small predictable
// memory footprint for image rendering.
sharp.cache(false);
sharp.concurrency(1);

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

    CREATE TABLE IF NOT EXISTS booking_whatsapp_states (
      mobile TEXT PRIMARY KEY,
      booking_id INTEGER,
      booking_ref TEXT,
      state TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
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
      : bookingAction.includes('booking_join') || bookingAction.includes('join online meeting') ? 'join'
      : bookingAction.includes('booking_maps') || bookingAction.includes('view on google maps') ? 'maps'
      : bookingAction.includes('booking_help') || bookingAction.includes('call / whatsapp us') || bookingAction.includes('call whatsapp us') ? 'help'
      : bookingAction.includes('booking_cancel_yes') || bookingAction.includes('yes, cancel') ? 'cancel_yes'
      : bookingAction.includes('booking_cancel') || bookingAction.includes('cancel') ? 'cancel'
      : bookingAction.includes('booking_reschedule') || bookingAction.includes('reschedule') ? 'reschedule'
      : '';
    if (bookingActionType) {
      const canonical=botSailorPhone(mobile);
      const national=canonical.startsWith('91')&&canonical.length===12?canonical.slice(2):canonical;
      // Cancel/Reschedule buttons must stay tied to the booking that created them.
      // Never fall through to another active booking on the same mobile number.
      let bookingRef='';
      if(['cancel','cancel_yes','reschedule'].includes(bookingActionType)){
        const stateQ=await pool.query(`SELECT booking_ref FROM booking_whatsapp_states WHERE mobile=$1 LIMIT 1`,[canonical]);
        bookingRef=String(stateQ.rows[0]?.booking_ref||'').trim();
      }
      if(!bookingRef){
        const br=await pool.query(`SELECT b.booking_ref FROM student_bookings b
          WHERE regexp_replace(COALESCE(b.student_mobile,''),'[^0-9]','','g') IN ($1,$2)
            AND b.status IN ('requested','approved','confirmed','rescheduled')
          ORDER BY b.created_at DESC LIMIT 1`,[canonical,national]);
        bookingRef=String(br.rows[0]?.booking_ref||'').trim();
      }
      if(!bookingRef) return res.status(200).json({status:'ignored',message:'No booking found for this action'});
      const booking=await loadBookingWhatsAppContext(bookingRef);
      if(!booking) return res.status(200).json({status:'ignored',message:'Booking not found'});
      if(bookingActionType==='reschedule' && String(booking.status||'').toLowerCase()==='cancelled'){
        const closed=await sendBotSailorText(
          {mobile:booking.student_mobile,name:booking.student_name,course:booking.course},
          `ℹ️ *This appointment is already cancelled.*\n\nBooking: *${booking.booking_ref}*\n\nPlease book a new appointment if you would like to schedule counselling again.`,
          'booking_cancelled_reschedule_blocked'
        );
        return res.status(closed.success?200:400).json({status:closed.success?'ok':'error',action:'booking_cancelled_reschedule_blocked'});
      }
      let reply='';
      if(bookingActionType==='cancel') {
        const confirmResult=await sendBotSailorReplyButtons(
          {mobile:booking.student_mobile,name:booking.student_name,course:booking.course},
          `⚠️ *Cancel this appointment?*\n\nBooking: *${booking.booking_ref}*\n\nPlease confirm your choice below.`,
          [
            {id:'booking_cancel_yes',title:'Yes, Cancel'},
            {id:'booking_reschedule',title:'Reschedule'}
          ],
          'booking_cancel_confirm'
        );
        return res.status(confirmResult.success?200:400).json({status:confirmResult.success?'ok':'error',action:'booking_cancel_confirm'});
      } else if(bookingActionType==='cancel_yes') {
        await pool.query(`UPDATE student_bookings SET status='cancelled',customer_response='cancelled',response_at=NOW(),updated_at=NOW() WHERE id=$1`,[booking.id]);
        // Keep the cancelled booking bound to this WhatsApp action set so an old
        // Reschedule button can never jump to a different booking on the same mobile.
        await pool.query(`INSERT INTO booking_whatsapp_states(mobile,booking_id,booking_ref,state,payload,updated_at)
          VALUES($1,$2,$3,'cancelled','{}'::jsonb,NOW())
          ON CONFLICT(mobile) DO UPDATE SET booking_id=EXCLUDED.booking_id,booking_ref=EXCLUDED.booking_ref,state='cancelled',payload='{}'::jsonb,updated_at=NOW()`,
          [canonical,booking.id,booking.booking_ref]);
        reply=`✅ *Appointment Cancelled*\n\nYour appointment *${booking.booking_ref}* has been cancelled successfully.\n\nIf you need counselling later, please book a new appointment.`;
      } else if(bookingActionType==='reschedule') {
        await pool.query(`INSERT INTO booking_whatsapp_states(mobile,booking_id,booking_ref,state,payload,updated_at)
          VALUES($1,$2,$3,'awaiting_reschedule_preference','{}'::jsonb,NOW())
          ON CONFLICT(mobile) DO UPDATE SET booking_id=EXCLUDED.booking_id,booking_ref=EXCLUDED.booking_ref,state=EXCLUDED.state,payload='{}'::jsonb,updated_at=NOW()`,
          [canonical,booking.id,booking.booking_ref]);
        reply=`📅 *Reschedule Appointment*\n\nPlease reply with your preferred new *date and time*.\n\nExample: *05 October 2026, 4:30 PM*\n\nYour request will stay linked to booking *${booking.booking_ref}*.`;
      } else if(bookingActionType==='manage') {
        // Rotate the private token each time the customer requests the manage link.
        const token=randomBytes(32).toString('hex');
        const tokenHash=createHash('sha256').update(token).digest('hex');
        await pool.query(`UPDATE student_bookings SET token_hash=$1,updated_at=NOW() WHERE id=$2`,[tokenHash,booking.id]);
        reply=`🔗 *Manage Appointment*\n${bookingManageUrl(booking,token)}\n\nUse this secure link to reschedule or cancel your appointment.`;
      } else if(bookingActionType==='maps') {
        reply=booking.mode==='offline'
          ? `📍 *Head Office Location*\n${booking.offline_location_name||'Head Office - Tagore Garden'}\n${booking.offline_address||''}\n\n${booking.offline_map_url||'Google Maps link is not configured yet.'}`
          : `🎥 *Online Counselling*\n${booking.meeting_link||'Your meeting link will be shared here.'}`;
      } else if(bookingActionType==='join') {
        reply=`🎥 *Join Online Meeting*\n${booking.meeting_link||'Your meeting link will be shared here.'}`;
      } else {
        reply=`☎️ *Need Help?*\nCall / WhatsApp GuruVidya\n+91 98216 27725\nhttps://wa.me/919821627725`;
      }
      const actionResult=await sendBotSailorText({mobile:booking.student_mobile,name:booking.student_name,course:booking.course},reply,`booking_action_${bookingActionType}`);
      return res.status(actionResult.success?200:400).json({status:actionResult.success?'ok':'error',action:`booking_action_${bookingActionType}`});
    }

    // WhatsApp-only reschedule continuation. Keep the current booking unchanged until
    // the requested date/time is validated/confirmed by the booking team.
    if (isCustomerEvent && webhookUserMessageRaw && !buttonReplyId && !buttonReplyTitle) {
      const canonical=botSailorPhone(mobile);
      const stateQ=await pool.query(`SELECT * FROM booking_whatsapp_states WHERE mobile=$1 AND state='awaiting_reschedule_preference' LIMIT 1`,[canonical]);
      const state=stateQ.rows[0];
      if(state){
        const preference=String(webhookUserMessageRaw||'').trim();
        if(preference){
          await pool.query(`UPDATE booking_whatsapp_states SET state='reschedule_requested',payload=jsonb_build_object('preference',$2),updated_at=NOW() WHERE mobile=$1`,[canonical,preference]);
          const br=await pool.query(`SELECT student_mobile,student_name,course,booking_ref FROM student_bookings WHERE id=$1 LIMIT 1`,[state.booking_id]);
          const b=br.rows[0];
          if(b){
            const rr=await sendBotSailorText({mobile:b.student_mobile,name:b.student_name,course:b.course},
              `📅 *Reschedule Request Received*\n\nPreferred date/time: *${preference}*\n\nBooking: *${b.booking_ref}*\n\nOur team will confirm the available slot here on WhatsApp.`,
              'booking_reschedule_preference_received');
            return res.status(rr.success?200:400).json({status:rr.success?'ok':'error',action:'booking_reschedule_preference_received'});
          }
        }
      }
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
  // SERVER 50: fixed actual vertical-line source in Course graduation-cap SVG (absolute V1 -> local row Y). WhatsApp send/buttons untouched.
  const {date,time}=bookingIstParts(b.starts_at);
  const place=b.mode==='offline'?(b.offline_location_name||'Head Office - Tagore Garden'):'Online Counselling';
  const address=b.mode==='offline'?(b.offline_address||'GuruVidya Academy, New Delhi'):'Online counselling appointment';
  const finalHeaderJpeg = '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';
  const rows=[
    ['doc','Booking Reference',b.booking_ref],
    ['person','Student Name',b.student_name],
    ['cap','Course',b.course],
    ['calendar','Date',date],
    ['clock','Time (IST)',time],
    ['person','Counsellor',b.counsellor_name||'GuruVidya Admission Counsellor'],
    ['screen','Mode',b.mode==='offline'?'Offline (Head Office Tagore Garden)':'Online'],
    ['pin',b.mode==='offline'?'Location':'Online Session',address]
  ];
  const icon=(type,cx,cy)=>{
    const s='#083d9b', sw='7';
    if(type==='person') return `<circle cx="${cx}" cy="${cy-13}" r="13" fill="${s}"/><path d="M${cx-24} ${cy+23}c2-20 13-30 24-30s22 10 24 30z" fill="${s}"/>`;
    if(type==='cap') return `<path d="M${cx-28} ${cy-8}l28-15 28 15-28 15z" fill="${s}"/><path d="M${cx-18} ${cy+1}v15c10 8 26 8 36 0V${cy+1}z" fill="${s}"/><circle cx="${cx+27}" cy="${cy-7}" r="3" fill="${s}"/>`;
    if(type==='calendar') return `<rect x="${cx-24}" y="${cy-21}" width="48" height="45" rx="5" fill="none" stroke="${s}" stroke-width="6"/><path d="M${cx-24} ${cy-7}h48M${cx-13} ${cy-27}v12M${cx+13} ${cy-27}v12" stroke="${s}" stroke-width="6" stroke-linecap="round"/><rect x="${cx-12}" y="${cy+2}" width="8" height="8" fill="${s}"/><rect x="${cx+5}" y="${cy+2}" width="8" height="8" fill="${s}"/>`;
    if(type==='clock') return `<circle cx="${cx}" cy="${cy}" r="24" fill="none" stroke="${s}" stroke-width="6"/><path d="M${cx} ${cy-13}v15l12 8" fill="none" stroke="${s}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`;
    if(type==='screen') return `<rect x="${cx-27}" y="${cy-20}" width="54" height="38" rx="4" fill="none" stroke="${s}" stroke-width="6"/><path d="M${cx} ${cy+18}v13M${cx-15} ${cy+31}h30" stroke="${s}" stroke-width="6" stroke-linecap="round"/>`;
    if(type==='meeting') return `<rect x="${cx-27}" y="${cy-21}" width="54" height="38" rx="5" fill="none" stroke="${s}" stroke-width="6"/><circle cx="${cx}" cy="${cy-9}" r="6" fill="${s}"/><circle cx="${cx-13}" cy="${cy-6}" r="5" fill="${s}"/><circle cx="${cx+13}" cy="${cy-6}" r="5" fill="${s}"/><path d="M${cx-21} ${cy+10}c2-8 7-12 13-12 3 0 6 1 8 3 2-2 5-3 8-3 6 0 11 4 13 12z" fill="${s}"/><path d="M${cx} ${cy+17}v13M${cx-15} ${cy+30}h30" stroke="${s}" stroke-width="6" stroke-linecap="round"/>`;
    if(type==='pin') return `<path d="M${cx} ${cy+28}s-24-27-24-45a24 24 0 1148 0c0 18-24 45-24 45z" fill="${s}"/><circle cx="${cx}" cy="${cy-17}" r="8" fill="white"/>`;
    // Document icon intentionally uses filled rectangles only (no SVG <line>,
    // stroke or compound path). On the deployed Sharp/libvips build, the old
    // document stroke could render as a long vertical blue artefact.
    return `<rect x="${cx-20}" y="${cy-25}" width="40" height="50" rx="4" fill="${s}"/><rect x="${cx-11}" y="${cy-10}" width="22" height="4" rx="2" fill="white"/><rect x="${cx-11}" y="${cy+2}" width="22" height="4" rx="2" fill="white"/><rect x="${cx-11}" y="${cy+14}" width="17" height="4" rx="2" fill="white"/>`;
  };
  let rowSvg='', y=625;
  for(const [ic,k,v] of rows){
    const valueSvg = (ic==='screen' && b.mode==='offline')
      ? `<rect x="505" y="${y-35}" width="430" height="52" rx="18" fill="#f97316"/><path d="M535 ${y+7}s-13-15-13-25a13 13 0 1126 0c0 10-13 25-13 25z" fill="#fff"/><circle cx="535" cy="${y-18}" r="4" fill="#f97316"/><text x="558" y="${y}" font-family="Arial, sans-serif" font-size="20" font-weight="700" fill="#fff">Offline (Head Office Tagore Garden)</text>`
      : (ic==='screen' && b.mode!=='offline')
        ? `<rect x="505" y="${y-35}" width="190" height="52" rx="18" fill="#0878e8"/><rect x="527" y="${y-20}" width="24" height="18" rx="3" fill="#fff"/><path d="M551 ${y-16}l14-8v26l-14-8z" fill="#fff"/><text x="578" y="${y}" font-family="Arial, sans-serif" font-size="23" font-weight="700" fill="#fff">Online</text>`
      : (ic==='pin' && b.mode==='offline')
        ? `<text x="515" y="${y-14}" font-family="Arial, sans-serif" font-size="27" font-weight="700" fill="#102f78">Guruvidya Academy Pvt. Ltd.</text>${svgWrap(v,515,y-12,38,28,'class="val"')}`
      : (ic==='pin' && b.mode!=='offline')
        ? `<rect x="505" y="${y-39}" width="430" height="58" rx="18" fill="#0878e8"/><g fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"><path d="M535 ${y-18}l10-10a12 12 0 0117 17l-9 9"/><path d="M555 ${y-10}l-10 10a12 12 0 01-17-17l9-9"/></g><text x="586" y="${y-1}" font-family="Arial, sans-serif" font-size="23" font-weight="700" fill="#fff">Join Online Meeting</text><rect x="505" y="${y+30}" width="430" height="100" rx="18" fill="#e9f7ff" stroke="#9bdcff" stroke-width="2"/><circle cx="535" cy="${y+59}" r="15" fill="none" stroke="#0878e8" stroke-width="4"/><path d="M535 ${y+49}v11l9 5" fill="none" stroke="#0878e8" stroke-width="4" stroke-linecap="round"/><text x="565" y="${y+66}" font-family="Arial, sans-serif" font-size="20" font-weight="600" fill="#102f78">Your appointment is at <tspan font-weight="700">${xmlEsc(time)} (IST)</tspan></text><circle cx="535" cy="${y+101}" r="15" fill="#0878e8"/><text x="535" y="${y+108}" text-anchor="middle" font-family="Arial, sans-serif" font-size="20" font-weight="700" fill="#fff">i</text><text x="565" y="${y+98}" font-family="Arial, sans-serif" font-size="18" font-weight="500" fill="#4b6488">Please join 5 minutes early and wait</text><text x="565" y="${y+120}" font-family="Arial, sans-serif" font-size="18" font-weight="500" fill="#4b6488">for your counsellor.</text>`
        : svgWrap(v,515,y-36,34,30,'class="val"');
    const isLastRow = ic==='pin';
    rowSvg+=`${icon((ic==='pin' && b.mode!=='offline')?'meeting':ic,155,y-5)}<text x="215" y="${y}" class="key">${xmlEsc(k)}</text><text x="465" y="${y}" class="key">:</text>${valueSvg}${isLastRow?'':`<line x1="115" y1="${y+39}" x2="955" y2="${y+39}" class="sep"/>`}`;
    y += ic==='pin'?150:82;
  }
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1530" viewBox="0 0 1080 1530">
  <defs>
    <linearGradient id="blue" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#072a79"/><stop offset=".55" stop-color="#0758c9"/><stop offset="1" stop-color="#08a7ed"/></linearGradient>
    <linearGradient id="cyan" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#0878e8"/><stop offset="1" stop-color="#09b9ed"/></linearGradient>
    <style>.key{font:700 27px Arial;fill:#092f83}.val{font:500 26px Arial;fill:#102f78}.sep{stroke:#d4e4ef;stroke-width:1.5}</style>
  </defs>
  <rect width="1080" height="1530" fill="#f8f3eb"/>
  <g opacity=".10" stroke="#cdbfae" fill="none"><circle cx="65" cy="110" r="18"/><circle cx="1015" cy="180" r="23"/><path d="M30 1320q40-35 80 0t80 0M900 70q35-30 70 0t70 0"/></g>
  <rect x="28" y="35" width="1024" height="1440" rx="42" fill="#fff"/>
  <!-- Exact approved final reference header, rasterized small to avoid the old SVG artefacts. -->
  <image href="data:image/jpeg;base64,${finalHeaderJpeg}" x="60" y="55" width="960" height="473" preserveAspectRatio="xMidYMid meet"/>
  <!-- details panel -->
  <rect x="62" y="550" width="956" height="785" rx="40" fill="#f5faff" stroke="#dbeaf5" stroke-width="2"/>
  ${rowSvg}
  <!-- Premium green status banner: visual only; WhatsApp delivery body remains unchanged. -->
  <defs>
    <linearGradient id="confirmGreen" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#08b84f"/><stop offset="0.48" stop-color="#068f3f"/><stop offset="1" stop-color="#045f32"/>
    </linearGradient>
  </defs>
  <rect x="62" y="1350" width="956" height="110" rx="28" fill="url(#confirmGreen)"/>
  <path d="M62 1418 Q290 1368 520 1416 T1018 1392 V1460 H62 Z" fill="#034f2b" opacity=".38"/><path d="M62 1442 Q300 1400 560 1436 T1018 1410 V1460 H62 Z" fill="#0bb45a" opacity=".22"/>
  <circle cx="132" cy="1405" r="40" fill="#fff"/>
  <path d="M112 1405l14 14 28-31" fill="none" stroke="#07883f" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="195" y1="1368" x2="195" y2="1442" stroke="#e8fff1" stroke-width="4"/>
  <path d="M88 1375l-17-13M82 1405H62M90 1435l-17 12" stroke="#d5ed42" stroke-width="6" stroke-linecap="round" opacity=".95"/>
  <path d="M982 1375l16-13M988 1405h18M982 1435l16 12" stroke="#d5ed42" stroke-width="6" stroke-linecap="round" opacity=".95"/>
  <text x="610" y="1422" text-anchor="middle" font-family="Arial, sans-serif" font-size="46" font-weight="700" fill="#fff">Booking Slot Reserved</text>
  </svg>`;
  // sequentialRead + disabled libvips cache/concurrency above prevents repeated
  // BotSailor/Meta media fetches from building up large native-memory spikes.
  return sharp(Buffer.from(svg), { sequentialRead: true })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
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
  // Preserve the exact Server51 working BotSailor message body.
  // Do not replace this with blank/invisible/emoji-only content: delivery regressed in testing.
  const msg='Appointment confirmed.';
  const result=await sendBotSailorReplyButtons(
    {mobile:b.student_mobile,name:b.student_name,course:b.course},
    msg,
    [
      {id:'booking_manage',title:'Manage Appointment'},
      String(b.mode || '').trim().toLowerCase() === 'offline'
        ? {id:'booking_maps',title:'View on Google Maps'}
        // Keep the proven booking_maps postback id for BotSailor/Meta delivery compatibility.
        // The visible online title changes, and the webhook already routes booking_maps
        // to the meeting link whenever the latest booking mode is online.
        : {id:'booking_maps',title:'Join Online Meeting'},
      {id:'booking_help',title:'Call / WhatsApp Us'}
    ],
    action,
    {
      mediaUrl:`${String(process.env.PUBLIC_API_URL || 'https://guruvidya-backend.onrender.com').replace(/\/$/,'')}/api/public/booking/whatsapp-card/${encodeURIComponent(b.booking_ref)}.png?token=${encodeURIComponent(token)}`,
      mediaType:'image',
    }
  );
  // Keep the proven three-button confirmation untouched. Send Cancel/Reschedule as
  // a separate native WhatsApp interactive message immediately after the first send.
  // IMPORTANT: do this BEFORE delivery-log persistence. Some older databases do not
  // yet have the unique constraint required by the legacy ON CONFLICT statement; that
  // logging error must never block a customer-facing WhatsApp action message.
  let manageResult=null;
  if(result.success){
    // Media cards can take a moment to render on WhatsApp even after Meta accepts
    // the send. A short pause keeps the change-options card visually after the
    // booking graphic instead of racing ahead of it.
    await new Promise(resolve=>setTimeout(resolve,3500));
    manageResult=await sendBotSailorReplyButtons(
      {mobile:b.student_mobile,name:b.student_name,course:b.course},
      `🗓️ *Need to make a change to your appointment?*\nUse the options below to cancel or reschedule.`,
      [
        {id:'booking_cancel',title:'Cancel'},
        {id:'booking_reschedule',title:'Reschedule'}
      ],
      `${action}_change_options`
    );
    console.log('BOOKING CHANGE ACTION BUTTONS:', {
      success:manageResult.success,
      status:manageResult.status,
      message:manageResult.message,
      buttons:['Cancel','Reschedule']
    });
    if(manageResult.success){
      const canonical=botSailorPhone(b.student_mobile);
      await pool.query(`INSERT INTO booking_whatsapp_states(mobile,booking_id,booking_ref,state,payload,updated_at)
        VALUES($1,$2,$3,'change_options','{}'::jsonb,NOW())
        ON CONFLICT(mobile) DO UPDATE SET booking_id=EXCLUDED.booking_id,booking_ref=EXCLUDED.booking_ref,state='change_options',payload='{}'::jsonb,updated_at=NOW()`,
        [canonical,b.id,b.booking_ref]);
    }
  }

  // Delivery logging is non-critical. Never let a schema/ON CONFLICT mismatch stop
  // either WhatsApp message or make a successful booking confirmation look failed.
  try{
    await pool.query(`INSERT INTO booking_delivery_logs(booking_id,event,recipient,channel,status,detail)
      VALUES($1,$2,'student','whatsapp',$3,$4) ON CONFLICT(booking_id,event,recipient,channel) DO UPDATE SET status=EXCLUDED.status,detail=EXCLUDED.detail,created_at=NOW()`,
      [b.id,action,result.success?'sent':'failed',result.message||result.status||'']);
  }catch(logErr){
    console.warn('BOOKING DELIVERY LOG SKIPPED:',logErr.message);
  }

  if(result.success){
    return { ...result, changeOptions:manageResult, mode:'interactive_final_design_plus_change_options' };
  }
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

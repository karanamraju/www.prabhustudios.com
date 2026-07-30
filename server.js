"use strict";

// Minimal dependency-free server for the studio website. It intentionally keeps
// authentication and billing data on the server; browser storage is never used
// for passwords, sessions, or invoices.
const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const dns = require("node:dns/promises");
const nodemailer = require("nodemailer");
const { buildInvoicePdf } = require("./invoice-pdf");

const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const ROOT = __dirname;
// This project keeps the browser files beside this server, rather than in a
// separate public/ directory. Serve only this explicit list so server code and
// private billing data can never be requested as static files.
const PUBLIC_DIR = ROOT;
const STATIC_FILES = new Set(["index.html", "styles.css", "billing.css", "portfolio.css", "studio-assets.css", "hero-carousel.css", "service-enhancements.css", "founder-watermark.css", "app.js", "logo.png", "PS LOGO.png", "raj.jpg", "JAMES.JPG", "organizer.jpg", "dji-mavic-3.jpg", "BANNER.jpg", "MY cameras.jpg", "CNAME"]);
const DATA_DIR = path.resolve(process.env.STUDIO_DATA_DIR || path.join(ROOT, "data"));
const USERS_FILE = path.join(DATA_DIR, "users.json");
const INVOICES_FILE = path.join(DATA_DIR, "invoices.json");
const sessions = new Map();
const loginAttempts = new Map();
const ownerPasswordResets = new Map();
const ownerPasswordResetAttempts = new Map();
const ownerPasswordOtpSendAttempts = new Map();
const ownerPasswordOtpCheckAttempts = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const OWNER_RESET_TTL_MS = 15 * 60 * 1000;
const OWNER_RESET_WINDOW_MS = 15 * 60 * 1000;
const MAX_OWNER_RESET_ATTEMPTS = 3;
const OWNER_OTP_SEND_WINDOW_MS = 15 * 60 * 1000;
const MAX_OWNER_OTP_SEND_ATTEMPTS = 3;
const OWNER_OTP_CHECK_WINDOW_MS = 10 * 60 * 1000;
const MAX_OWNER_OTP_CHECK_ATTEMPTS = 5;
const SMTP_HOST = String(process.env.SMTP_HOST || "").trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = String(process.env.SMTP_USER || "").trim();
const SMTP_PASS = String(process.env.SMTP_PASS || "");
const SMTP_FROM = String(process.env.SMTP_FROM || SMTP_USER).trim();
const SMTP_SECURE = String(process.env.SMTP_SECURE || "true").toLowerCase() !== "false";
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
const TWILIO_ACCOUNT_SID = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
const TWILIO_AUTH_TOKEN = String(process.env.TWILIO_AUTH_TOKEN || "");
const TWILIO_SMS_FROM = String(process.env.TWILIO_SMS_FROM || "").trim();
const TWILIO_WHATSAPP_FROM = String(process.env.TWILIO_WHATSAPP_FROM || "").trim();
const TWILIO_VERIFY_SERVICE_SID = String(process.env.TWILIO_VERIFY_SERVICE_SID || "").trim();
const OWNER_RESET_PHONE = String(process.env.OWNER_RESET_PHONE || "").trim();

function invoiceEmailConfigured() {
  return Boolean(SMTP_HOST && Number.isInteger(SMTP_PORT) && SMTP_PORT > 0 && SMTP_USER && SMTP_PASS && SMTP_FROM);
}

// Some hosting networks expose a local IPv6 interface but do not provide an
// IPv6 route to Gmail. Resolve Gmail to IPv4 first, while preserving the
// original hostname for TLS certificate verification.
async function createSmtpTransport() {
  let host = SMTP_HOST;
  let tls;
  try {
    const ipv4Addresses = await dns.resolve4(SMTP_HOST);
    if (ipv4Addresses.length) {
      host = ipv4Addresses[0];
      tls = { servername: SMTP_HOST };
    }
  } catch (error) {
    console.warn(`SMTP IPv4 lookup failed for ${SMTP_HOST}: ${error.code || error.message}`);
  }

  return nodemailer.createTransport({
    host,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 45_000,
  });
}

async function sendInvoiceEmail(invoice, fallbackRecipient) {
  if (!invoiceEmailConfigured()) throw new Error("Invoice email is not configured");
  const recipient = String(process.env.BILLING_NOTIFICATION_EMAIL || fallbackRecipient || "").trim();
  if (!recipient) throw new Error("Invoice email recipient is not configured");

  const invoicePdf = await buildInvoicePdf(invoice);
  const transporter = await createSmtpTransport();
  const result = await transporter.sendMail({
    from: SMTP_FROM,
    to: recipient,
    subject: `New invoice ${invoice.id} - PRABHU STUDIO`,
    text: `Invoice ${invoice.id} for ${invoice.clientName} has been created. Amount: INR ${Number(invoice.amount).toFixed(2)}. The invoice PDF is attached.`,
    attachments: [{ filename: `${invoice.id}.pdf`, content: invoicePdf, contentType: "application/pdf" }],
  });
  if (!result.accepted.includes(recipient)) throw new Error("Mail server did not accept the invoice email");
  return recipient;
}

function ownerPasswordResetUrl(token, smsOtpRequired) {
  const baseUrl = PUBLIC_BASE_URL || `http://localhost:${PORT}`;
  const smsOtp = smsOtpRequired ? "&sms=1" : "";
  return `${baseUrl}/?reset=${encodeURIComponent(token)}${smsOtp}`;
}

async function sendOwnerPasswordResetEmail(user, token, smsOtpRequired) {
  if (!invoiceEmailConfigured()) throw new Error("Email delivery is not configured");
  const transporter = await createSmtpTransport();
  const result = await transporter.sendMail({
    from: SMTP_FROM,
    to: user.email,
    subject: "Reset your PRABHU STUDIO owner password",
    text: `A password reset was requested for your PRABHU STUDIO owner account. Open this one-time link within 15 minutes to set a new password${smsOtpRequired ? " and confirm the SMS OTP" : ""}:\n\n${ownerPasswordResetUrl(token, smsOtpRequired)}\n\nIf you did not request this reset, ignore this email.`,
  });
  if (!result.accepted.includes(user.email)) throw new Error("Mail server did not accept the password reset email");
}

function normaliseClientPhone(value) {
  const compact = String(value || "").trim().replace(/[\s().-]/g, "");
  if (/^\d{10}$/.test(compact)) return `+91${compact}`;
  if (/^\+\d{8,15}$/.test(compact)) return compact;
  return "";
}

function ownerResetOtpConfigured() {
  return Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_VERIFY_SERVICE_SID && normaliseClientPhone(OWNER_RESET_PHONE));
}

function maskedOwnerResetPhone() {
  const phone = normaliseClientPhone(OWNER_RESET_PHONE);
  return phone ? `${phone.slice(0, 3)} ••••• ${phone.slice(-4)}` : "the registered owner mobile number";
}

function asWhatsAppAddress(value) {
  return value.startsWith("whatsapp:") ? value : `whatsapp:${value}`;
}

function publicInvoiceUrl(invoice) {
  if (!PUBLIC_BASE_URL || !invoice.publicToken) return "";
  return `${PUBLIC_BASE_URL}/api/public/invoices/${encodeURIComponent(invoice.id)}?token=${encodeURIComponent(invoice.publicToken)}`;
}

async function sendTwilioText({ from, to, body }) {
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Messages.json`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ From: from, To: to, Body: body }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || `Twilio request failed with ${response.status}`);
  return result.sid;
}

async function twilioVerifyRequest(pathname, parameters) {
  const response = await fetch(`https://verify.twilio.com/v2${pathname}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(parameters),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || `Twilio Verify request failed with ${response.status}`);
  return result;
}

async function sendOwnerPasswordResetOtp() {
  const result = await twilioVerifyRequest(
    `/Services/${encodeURIComponent(TWILIO_VERIFY_SERVICE_SID)}/Verifications`,
    { To: normaliseClientPhone(OWNER_RESET_PHONE), Channel: "sms" },
  );
  if (result.status !== "pending") throw new Error("The SMS verification could not be started");
}

async function ownerPasswordOtpIsValid(code) {
  const result = await twilioVerifyRequest(
    `/Services/${encodeURIComponent(TWILIO_VERIFY_SERVICE_SID)}/VerificationCheck`,
    { To: normaliseClientPhone(OWNER_RESET_PHONE), Code: code },
  );
  return result.status === "approved";
}

async function sendClientNotifications(invoice) {
  if (!invoice.clientPhone) return [];
  const channels = ["sms", "whatsapp"];
  const invoiceUrl = publicInvoiceUrl(invoice);
  if (!invoiceUrl) return channels.map((channel) => ({ channel, status: "skipped", reason: "Public invoice URL is not configured" }));
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return channels.map((channel) => ({ channel, status: "skipped", reason: "Twilio is not configured" }));

  const text = `PRABHU STUDIO: Your invoice ${invoice.id} for INR ${Number(invoice.amount).toFixed(2)} is ready. View it securely within 30 days: ${invoiceUrl}`;
  const requests = [
    { channel: "sms", from: TWILIO_SMS_FROM, to: invoice.clientPhone },
    { channel: "whatsapp", from: TWILIO_WHATSAPP_FROM, to: asWhatsAppAddress(invoice.clientPhone) },
  ];
  const outcomes = [];
  for (const request of requests) {
    if (!request.from) {
      outcomes.push({ channel: request.channel, status: "skipped", reason: "Sender is not configured" });
      continue;
    }
    try {
      await sendTwilioText({ ...request, from: request.channel === "whatsapp" ? asWhatsAppAddress(request.from) : request.from, body: text });
      outcomes.push({ channel: request.channel, status: "sent" });
    } catch (error) {
      console.error(`Client ${request.channel} notification failed for ${invoice.id}: ${error.message}`);
      outcomes.push({ channel: request.channel, status: "failed" });
    }
  }
  return outcomes;
}

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function pdf(res, filename, content) {
  res.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="${filename}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(content);
}

function publicTokenMatches(providedToken, storedToken) {
  const provided = Buffer.from(String(providedToken || ""));
  const stored = Buffer.from(String(storedToken || ""));
  return provided.length === stored.length && provided.length > 0 && crypto.timingSafeEqual(provided, stored);
}

function secureHeaders(res) {
  res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src https://www.youtube-nocookie.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function passwordHash(password, salt = crypto.randomBytes(16).toString("base64url")) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) return reject(error);
      resolve(`${salt}:${derivedKey.toString("base64url")}`);
    });
  });
}

async function passwordMatches(password, encodedHash) {
  const [salt, stored] = String(encodedHash).split(":");
  if (!salt || !stored) return false;
  const candidate = await passwordHash(password, salt);
  const candidateValue = Buffer.from(candidate.split(":")[1]);
  const storedValue = Buffer.from(stored);
  return candidateValue.length === storedValue.length && crypto.timingSafeEqual(candidateValue, storedValue);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fsp.rename(temporary, file);
}

function validBootstrapPassword(value) {
  return typeof value === "string" && value.length >= 12 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);
}

function isOwner(user) {
  return user && user.role === "owner";
}

function publicStaffUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, status: user.status, createdAt: user.createdAt };
}

async function initialiseData() {
  await fsp.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const users = await readJson(USERS_FILE, []);
  if (!users.length) {
    const email = String(process.env.STUDIO_ADMIN_EMAIL || "").trim().toLowerCase();
    const password = process.env.STUDIO_ADMIN_PASSWORD;
    if (!email || !validBootstrapPassword(password)) {
      throw new Error("First run requires STUDIO_ADMIN_EMAIL and a 12+ character STUDIO_ADMIN_PASSWORD containing upper, lower, and number characters.");
    }
    await writeJson(USERS_FILE, [{ id: crypto.randomUUID(), name: "Studio owner", email, role: "owner", status: "active", createdAt: new Date().toISOString(), passwordHash: await passwordHash(password) }]);
  } else {
    let changed = false;
    for (const user of users) {
      if (user.role !== "owner" && user.role !== "billing") {
        user.role = "billing";
        changed = true;
      }
      if (user.status !== "active" && user.status !== "disabled") {
        user.status = "active";
        changed = true;
      }
      if (!user.name) {
        user.name = user.role === "owner" ? "Studio owner" : user.email.split("@")[0];
        changed = true;
      }
      if (!user.createdAt) {
        user.createdAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) await writeJson(USERS_FILE, users);
  }
  if (!fs.existsSync(INVOICES_FILE)) await writeJson(INVOICES_FILE, []);
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map((part) => {
    const index = part.indexOf("=");
    return index === -1 ? [] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter((pair) => pair.length));
}

function setSessionCookie(res, token) {
  const bits = [`studio_session=${encodeURIComponent(token)}`, "HttpOnly", "SameSite=Strict", "Path=/", `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (IS_PRODUCTION) bits.push("Secure");
  res.setHeader("Set-Cookie", bits.join("; "));
}

function clearSessionCookie(res) {
  const bits = ["studio_session=", "HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=0"];
  if (IS_PRODUCTION) bits.push("Secure");
  res.setHeader("Set-Cookie", bits.join("; "));
}

function revokeUserSessions(userId) {
  for (const [token, session] of sessions) {
    if (session.userId === userId) sessions.delete(token);
  }
}

function authenticatedSession(req) {
  const token = parseCookies(req).studio_session;
  const session = token && sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function requireAuth(req, res, { csrf = false } = {}) {
  const session = authenticatedSession(req);
  if (!session) {
    json(res, 401, { error: "Please sign in to continue." });
    return null;
  }
  if (csrf && req.headers["x-csrf-token"] !== session.csrfToken) {
    json(res, 403, { error: "Your security token is invalid. Refresh and try again." });
    return null;
  }
  return session;
}

async function requireActiveUser(req, res, { csrf = false, owner = false } = {}) {
  const session = requireAuth(req, res, { csrf });
  if (!session) return null;
  const users = await readJson(USERS_FILE, []);
  const user = users.find((item) => item.id === session.userId && item.status === "active");
  if (!user) {
    sessions.delete(session.token);
    clearSessionCookie(res);
    json(res, 403, { error: "This staff account is no longer active." });
    return null;
  }
  if (owner && !isOwner(user)) {
    json(res, 403, { error: "Only the studio owner can manage staff or payment status." });
    return null;
  }
  return { ...session, user };
}

async function bodyJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20_000) throw new Error("Request too large");
  }
  try { return JSON.parse(raw || "{}"); } catch { throw new Error("Invalid JSON"); }
}

function clientIp(req) {
  return String(req.socket.remoteAddress || "unknown");
}

function loginAllowed(ip) {
  const now = Date.now();
  const attempts = (loginAttempts.get(ip) || []).filter((time) => time > now - LOGIN_WINDOW_MS);
  loginAttempts.set(ip, attempts);
  return attempts.length < MAX_LOGIN_ATTEMPTS;
}

function failedLogin(ip) {
  const attempts = (loginAttempts.get(ip) || []).filter((time) => time > Date.now() - LOGIN_WINDOW_MS);
  attempts.push(Date.now());
  loginAttempts.set(ip, attempts);
}

function ownerPasswordResetAllowed(ip) {
  const now = Date.now();
  const attempts = (ownerPasswordResetAttempts.get(ip) || []).filter((time) => time > now - OWNER_RESET_WINDOW_MS);
  ownerPasswordResetAttempts.set(ip, attempts);
  return attempts.length < MAX_OWNER_RESET_ATTEMPTS;
}

function recordOwnerPasswordResetRequest(ip) {
  const attempts = (ownerPasswordResetAttempts.get(ip) || []).filter((time) => time > Date.now() - OWNER_RESET_WINDOW_MS);
  attempts.push(Date.now());
  ownerPasswordResetAttempts.set(ip, attempts);
}

function attemptAllowed(attemptStore, key, windowMs, maximum) {
  const now = Date.now();
  const attempts = (attemptStore.get(key) || []).filter((time) => time > now - windowMs);
  attemptStore.set(key, attempts);
  return attempts.length < maximum;
}

function recordAttempt(attemptStore, key, windowMs) {
  const attempts = (attemptStore.get(key) || []).filter((time) => time > Date.now() - windowMs);
  attempts.push(Date.now());
  attemptStore.set(key, attempts);
}

function pruneOwnerPasswordResets() {
  const now = Date.now();
  for (const [token, reset] of ownerPasswordResets) {
    if (reset.expiresAt <= now) ownerPasswordResets.delete(token);
  }
}

function createOwnerPasswordReset(user) {
  pruneOwnerPasswordResets();
  const token = randomToken();
  const smsOtpRequired = ownerResetOtpConfigured();
  ownerPasswordResets.set(token, { userId: user.id, smsOtpRequired, expiresAt: Date.now() + OWNER_RESET_TTL_MS });
  return { token, smsOtpRequired };
}

function cleanText(value, max) {
  return typeof value === "string" ? value.trim().replace(/[<>]/g, "").slice(0, max) : "";
}

function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function createInvoiceId(invoices) {
  const year = new Date().getFullYear();
  const count = invoices.filter((invoice) => invoice.id.startsWith(`PS-${year}-`)).length + 1;
  return `PS-${year}-${String(count).padStart(3, "0")}`;
}

async function serveStatic(res, requestedPath) {
  const relative = decodeURIComponent(requestedPath === "/" ? "index.html" : requestedPath.replace(/^\/+/, ""));
  if (!STATIC_FILES.has(relative)) {
    json(res, 404, { error: "Not found" });
    return;
  }
  const resolved = path.resolve(PUBLIC_DIR, relative);
  if (path.dirname(resolved) !== PUBLIC_DIR) {
    json(res, 404, { error: "Not found" });
    return;
  }
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg" };
  try {
    const content = await fsp.readFile(resolved);
    res.writeHead(200, { "Content-Type": types[path.extname(resolved)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(content);
  } catch { json(res, 404, { error: "Not found" }); }
}

async function handleApi(req, res, url) {
  const route = url.pathname;
  const publicInvoiceMatch = route.match(/^\/api\/public\/invoices\/(PS-\d{4}-\d{3,})$/);
  if (req.method === "GET" && publicInvoiceMatch) {
    const invoices = await readJson(INVOICES_FILE, []);
    const invoice = invoices.find((item) => item.id === publicInvoiceMatch[1]);
    if (!invoice || !publicTokenMatches(url.searchParams.get("token"), invoice.publicToken) || Date.parse(invoice.publicTokenExpiresAt || "") < Date.now()) return json(res, 404, { error: "Invoice not found" });
    return pdf(res, `${invoice.id}.pdf`, await buildInvoicePdf(invoice));
  }
  if (req.method === "GET" && route === "/api/auth/session") {
    const session = authenticatedSession(req);
    if (!session) return json(res, 200, { authenticated: false });
    const users = await readJson(USERS_FILE, []);
    const user = users.find((item) => item.id === session.userId && item.status === "active");
    if (!user) {
      sessions.delete(session.token);
      clearSessionCookie(res);
      return json(res, 200, { authenticated: false });
    }
    return json(res, 200, { authenticated: true, email: user.email, role: user.role, csrfToken: session.csrfToken });
  }
  if (req.method === "POST" && route === "/api/auth/owner-password-reset/request") {
    const ip = clientIp(req);
    const input = await bodyJson(req);
    const email = cleanText(input.email, 120).toLowerCase();
    const allowed = ownerPasswordResetAllowed(ip);
    recordOwnerPasswordResetRequest(ip);
    const users = await readJson(USERS_FILE, []);
    const owner = users.find((user) => isOwner(user) && user.status === "active" && user.email === email);
    if (!allowed || !owner) return json(res, 200, { ok: true, message: "If that address is the active owner account, a reset email has been sent." });
    const reset = createOwnerPasswordReset(owner);
    try {
      await sendOwnerPasswordResetEmail(owner, reset.token, reset.smsOtpRequired);
      const message = reset.smsOtpRequired
        ? "Check the owner email inbox for a reset link. SMS OTP will be required after you open it."
        : "Check the owner email inbox for a reset link.";
      return json(res, 200, { ok: true, message });
    } catch (error) {
      ownerPasswordResets.delete(reset.token);
      console.error(`Owner password reset email failed: ${error.message}`);
      return json(res, 503, { error: "Password reset email could not be sent. Check the email settings and try again." });
    }
  }
  if (req.method === "POST" && route === "/api/auth/owner-password-reset/otp") {
    const input = await bodyJson(req);
    const token = String(input.token || "");
    pruneOwnerPasswordResets();
    const reset = ownerPasswordResets.get(token);
    if (!reset) return json(res, 400, { error: "This reset link is invalid or has expired. Request a new one." });
    if (!reset.smsOtpRequired || !ownerResetOtpConfigured()) return json(res, 503, { error: "Owner SMS verification is not configured for this reset link. Request a new reset link after it is set up." });
    if (!attemptAllowed(ownerPasswordOtpSendAttempts, reset.userId, OWNER_OTP_SEND_WINDOW_MS, MAX_OWNER_OTP_SEND_ATTEMPTS)) {
      return json(res, 429, { error: "Too many OTP requests. Please wait 15 minutes before trying again." });
    }
    try {
      await sendOwnerPasswordResetOtp();
      recordAttempt(ownerPasswordOtpSendAttempts, reset.userId, OWNER_OTP_SEND_WINDOW_MS);
      return json(res, 200, { ok: true, message: `SMS OTP sent to ${maskedOwnerResetPhone()}. It expires shortly.` });
    } catch (error) {
      console.error(`Owner password reset OTP send failed: ${error.message}`);
      return json(res, 503, { error: "SMS OTP could not be sent. Check the Twilio Verify settings and try again." });
    }
  }
  if (req.method === "POST" && route === "/api/auth/owner-password-reset/confirm") {
    const input = await bodyJson(req);
    const token = String(input.token || "");
    const password = typeof input.password === "string" ? input.password : "";
    const otp = String(input.otp || "").trim();
    pruneOwnerPasswordResets();
    const reset = ownerPasswordResets.get(token);
    if (!reset) return json(res, 400, { error: "This reset link is invalid or has expired. Request a new one." });
    if (!validBootstrapPassword(password)) return json(res, 400, { error: "Use a 12+ character password with uppercase, lowercase, and a number." });
    if (reset.smsOtpRequired) {
      if (!ownerResetOtpConfigured()) return json(res, 503, { error: "Owner SMS verification is not configured. Request a new reset link after it is set up." });
      if (!/^\d{4,10}$/.test(otp)) return json(res, 400, { error: "Enter the SMS OTP." });
      if (!attemptAllowed(ownerPasswordOtpCheckAttempts, reset.userId, OWNER_OTP_CHECK_WINDOW_MS, MAX_OWNER_OTP_CHECK_ATTEMPTS)) {
        return json(res, 429, { error: "Too many incorrect OTP attempts. Request a new reset link after 10 minutes." });
      }
      let otpAccepted = false;
      try {
        otpAccepted = await ownerPasswordOtpIsValid(otp);
      } catch (error) {
        console.error(`Owner password reset OTP check failed: ${error.message}`);
        return json(res, 503, { error: "SMS OTP could not be verified. Check the code and try again." });
      }
      if (!otpAccepted) {
        recordAttempt(ownerPasswordOtpCheckAttempts, reset.userId, OWNER_OTP_CHECK_WINDOW_MS);
        return json(res, 400, { error: "That SMS OTP is invalid or expired." });
      }
    }
    const users = await readJson(USERS_FILE, []);
    const owner = users.find((user) => user.id === reset.userId && isOwner(user) && user.status === "active");
    if (!owner) {
      ownerPasswordResets.delete(token);
      return json(res, 400, { error: "This reset link is no longer valid." });
    }
    owner.passwordHash = await passwordHash(password);
    await writeJson(USERS_FILE, users);
    revokeUserSessions(owner.id);
    for (const [pendingToken, pendingReset] of ownerPasswordResets) {
      if (pendingReset.userId === owner.id) ownerPasswordResets.delete(pendingToken);
    }
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && route === "/api/auth/login") {
    const ip = clientIp(req);
    if (!loginAllowed(ip)) return json(res, 429, { error: "Too many sign-in attempts. Please wait 15 minutes." });
    const { email, password } = await bodyJson(req);
    const users = await readJson(USERS_FILE, []);
    const user = users.find((item) => item.email === String(email || "").trim().toLowerCase());
    const valid = user && user.status === "active" && typeof password === "string" && await passwordMatches(password, user.passwordHash);
    if (!valid) {
      failedLogin(ip);
      return json(res, 401, { error: "Invalid email or password." });
    }
    loginAttempts.delete(ip);
    const token = randomToken();
    const csrfToken = randomToken();
    sessions.set(token, { userId: user.id, email: user.email, role: user.role, csrfToken, expiresAt: Date.now() + SESSION_TTL_MS });
    setSessionCookie(res, token);
    return json(res, 200, { authenticated: true, email: user.email, role: user.role, csrfToken });
  }
  if (req.method === "POST" && route === "/api/auth/logout") {
    const session = requireAuth(req, res, { csrf: true });
    if (!session) return;
    sessions.delete(session.token);
    clearSessionCookie(res);
    return json(res, 200, { ok: true });
  }
  if (req.method === "GET" && route === "/api/billing/invoices") {
    if (!await requireActiveUser(req, res)) return;
    const invoices = await readJson(INVOICES_FILE, []);
    return json(res, 200, { invoices: invoices.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
  }
  if (req.method === "GET" && route === "/api/billing/staff") {
    if (!await requireActiveUser(req, res, { owner: true })) return;
    const users = await readJson(USERS_FILE, []);
    return json(res, 200, { staff: users.map(publicStaffUser).sort((a, b) => a.name.localeCompare(b.name)) });
  }
  if (req.method === "POST" && route === "/api/billing/staff") {
    if (!await requireActiveUser(req, res, { csrf: true, owner: true })) return;
    const input = await bodyJson(req);
    const name = cleanText(input.name, 80);
    const email = cleanText(input.email, 120).toLowerCase();
    const password = typeof input.password === "string" ? input.password : "";
    if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !validBootstrapPassword(password)) {
      return json(res, 400, { error: "Enter a staff name, valid email, and a 12+ character password with uppercase, lowercase, and a number." });
    }
    const users = await readJson(USERS_FILE, []);
    if (users.some((user) => user.email === email)) return json(res, 409, { error: "A staff account already uses this email address." });
    const employee = { id: crypto.randomUUID(), name, email, role: "billing", status: "active", createdAt: new Date().toISOString(), passwordHash: await passwordHash(password) };
    users.push(employee);
    await writeJson(USERS_FILE, users);
    return json(res, 201, { staff: publicStaffUser(employee) });
  }
  const staffStatusMatch = route.match(/^\/api\/billing\/staff\/([a-f0-9-]{36})\/(enable|disable)$/i);
  if (req.method === "POST" && staffStatusMatch) {
    const session = await requireActiveUser(req, res, { csrf: true, owner: true });
    if (!session) return;
    const users = await readJson(USERS_FILE, []);
    const employee = users.find((user) => user.id === staffStatusMatch[1]);
    if (!employee) return json(res, 404, { error: "Staff account not found." });
    if (employee.id === session.user.id || isOwner(employee)) return json(res, 400, { error: "The studio owner account cannot be disabled here." });
    employee.status = staffStatusMatch[2].toLowerCase() === "enable" ? "active" : "disabled";
    await writeJson(USERS_FILE, users);
    return json(res, 200, { staff: publicStaffUser(employee) });
  }
  const staffPasswordMatch = route.match(/^\/api\/billing\/staff\/([a-f0-9-]{36})\/password$/i);
  if (req.method === "POST" && staffPasswordMatch) {
    if (!await requireActiveUser(req, res, { csrf: true, owner: true })) return;
    const input = await bodyJson(req);
    const password = typeof input.password === "string" ? input.password : "";
    if (!validBootstrapPassword(password)) {
      return json(res, 400, { error: "Use a 12+ character password with uppercase, lowercase, and a number." });
    }
    const users = await readJson(USERS_FILE, []);
    const employee = users.find((user) => user.id === staffPasswordMatch[1]);
    if (!employee) return json(res, 404, { error: "Staff account not found." });
    if (isOwner(employee)) return json(res, 400, { error: "Use the owner password reset utility for the studio owner account." });
    employee.passwordHash = await passwordHash(password);
    await writeJson(USERS_FILE, users);
    revokeUserSessions(employee.id);
    return json(res, 200, { staff: publicStaffUser(employee) });
  }
  if (req.method === "POST" && route === "/api/billing/invoices") {
    const session = await requireActiveUser(req, res, { csrf: true });
    if (!session) return;
    const input = await bodyJson(req);
    const clientName = cleanText(input.clientName, 80);
    const clientEmail = cleanText(input.clientEmail, 120).toLowerCase();
    const clientPhoneInput = cleanText(input.clientPhone, 30);
    const clientPhone = clientPhoneInput ? normaliseClientPhone(clientPhoneInput) : "";
    const selectedService = cleanText(input.service, 80);
    const customService = cleanText(input.customService, 80);
    const service = selectedService === "__custom__" ? customService : selectedService;
    const notes = cleanText(input.notes, 500);
    const amount = Number(input.amount);
    const dueDate = cleanText(input.dueDate, 10);
    if (!clientName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail) || !service || !Number.isFinite(amount) || amount <= 0 || amount > 10_000_000 || !isDate(dueDate)) {
      return json(res, 400, { error: "Enter a client, valid email, service, positive amount, and due date." });
    }
    if (clientPhoneInput && !clientPhone) return json(res, 400, { error: "Enter a valid 10-digit Indian mobile number or an international number starting with +." });
    if (!invoiceEmailConfigured()) {
      return json(res, 503, { error: "Invoice email delivery is not configured. Set the SMTP environment variables and try again." });
    }
    const invoices = await readJson(INVOICES_FILE, []);
    const invoice = { id: createInvoiceId(invoices), clientName, clientEmail, clientPhone, service, amount: Math.round(amount * 100) / 100, dueDate, notes, status: "unpaid", createdBy: { id: session.user.id, name: session.user.name, email: session.user.email }, publicToken: randomToken(), publicTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), createdAt: new Date().toISOString() };
    try {
      const emailedTo = await sendInvoiceEmail(invoice, session.email);
      const clientNotifications = await sendClientNotifications(invoice);
      invoices.push(invoice);
      await writeJson(INVOICES_FILE, invoices);
      return json(res, 201, { invoice, emailedTo, clientNotifications });
    } catch (error) {
      console.error(`Invoice email failed for ${invoice.id}: ${error.message}`);
      return json(res, 502, { error: "Invoice PDF could not be emailed. Check the email settings and try again." });
    }
  }
  const paidMatch = route.match(/^\/api\/billing\/invoices\/(PS-\d{4}-\d{3,})\/paid$/);
  if (req.method === "POST" && paidMatch) {
    if (!await requireActiveUser(req, res, { csrf: true, owner: true })) return;
    const invoices = await readJson(INVOICES_FILE, []);
    const invoice = invoices.find((item) => item.id === paidMatch[1]);
    if (!invoice) return json(res, 404, { error: "Invoice not found." });
    invoice.status = "paid";
    invoice.paidAt = new Date().toISOString();
    await writeJson(INVOICES_FILE, invoices);
    return json(res, 200, { invoice });
  }
  return json(res, 404, { error: "API route not found" });
}

const server = http.createServer(async (req, res) => {
  secureHeaders(res);
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Method not allowed" });
    return await serveStatic(res, url.pathname);
  } catch (error) {
    console.error(error);
    return json(res, error.message === "Request too large" ? 413 : 500, { error: "Something went wrong. Please try again." });
  }
});

initialiseData().then(() => server.listen(PORT, "0.0.0.0", () => console.log(`PRABHU STUDIO secure portal is running on port ${PORT}`))).catch((error) => {
  console.error(`Startup aborted: ${error.message}`);
  process.exit(1);
});

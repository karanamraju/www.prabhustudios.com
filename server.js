"use strict";

// Minimal dependency-free server for the studio website. It intentionally keeps
// authentication and billing data on the server; browser storage is never used
// for passwords, sessions, or invoices.
const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const INVOICES_FILE = path.join(DATA_DIR, "invoices.json");
const sessions = new Map();
const loginAttempts = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function secureHeaders(res) {
  res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
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

async function initialiseData() {
  await fsp.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const users = await readJson(USERS_FILE, []);
  if (!users.length) {
    const email = String(process.env.STUDIO_ADMIN_EMAIL || "").trim().toLowerCase();
    const password = process.env.STUDIO_ADMIN_PASSWORD;
    if (!email || !validBootstrapPassword(password)) {
      throw new Error("First run requires STUDIO_ADMIN_EMAIL and a 12+ character STUDIO_ADMIN_PASSWORD containing upper, lower, and number characters.");
    }
    await writeJson(USERS_FILE, [{ id: crypto.randomUUID(), email, role: "owner", passwordHash: await passwordHash(password) }]);
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
  const relative = requestedPath === "/" ? "index.html" : requestedPath.replace(/^\/+/, "");
  const resolved = path.resolve(PUBLIC_DIR, relative);
  if (!resolved.startsWith(`${PUBLIC_DIR}${path.sep}`) && resolved !== path.join(PUBLIC_DIR, "index.html")) {
    json(res, 404, { error: "Not found" });
    return;
  }
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8" };
  try {
    const content = await fsp.readFile(resolved);
    res.writeHead(200, { "Content-Type": types[path.extname(resolved)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(content);
  } catch { json(res, 404, { error: "Not found" }); }
}

async function handleApi(req, res, url) {
  const route = url.pathname;
  if (req.method === "GET" && route === "/api/auth/session") {
    const session = authenticatedSession(req);
    return json(res, 200, session ? { authenticated: true, email: session.email, role: session.role, csrfToken: session.csrfToken } : { authenticated: false });
  }
  if (req.method === "POST" && route === "/api/auth/login") {
    const ip = clientIp(req);
    if (!loginAllowed(ip)) return json(res, 429, { error: "Too many sign-in attempts. Please wait 15 minutes." });
    const { email, password } = await bodyJson(req);
    const users = await readJson(USERS_FILE, []);
    const user = users.find((item) => item.email === String(email || "").trim().toLowerCase());
    const valid = user && typeof password === "string" && await passwordMatches(password, user.passwordHash);
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
    if (!requireAuth(req, res)) return;
    const invoices = await readJson(INVOICES_FILE, []);
    return json(res, 200, { invoices: invoices.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
  }
  if (req.method === "POST" && route === "/api/billing/invoices") {
    if (!requireAuth(req, res, { csrf: true })) return;
    const input = await bodyJson(req);
    const clientName = cleanText(input.clientName, 80);
    const clientEmail = cleanText(input.clientEmail, 120).toLowerCase();
    const service = cleanText(input.service, 80);
    const notes = cleanText(input.notes, 500);
    const amount = Number(input.amount);
    const dueDate = cleanText(input.dueDate, 10);
    if (!clientName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail) || !service || !Number.isFinite(amount) || amount <= 0 || amount > 10_000_000 || !isDate(dueDate)) {
      return json(res, 400, { error: "Enter a client, valid email, service, positive amount, and due date." });
    }
    const invoices = await readJson(INVOICES_FILE, []);
    const invoice = { id: createInvoiceId(invoices), clientName, clientEmail, service, amount: Math.round(amount * 100) / 100, dueDate, notes, status: "unpaid", createdAt: new Date().toISOString() };
    invoices.push(invoice);
    await writeJson(INVOICES_FILE, invoices);
    return json(res, 201, { invoice });
  }
  const paidMatch = route.match(/^\/api\/billing\/invoices\/(PS-\d{4}-\d{3,})\/paid$/);
  if (req.method === "POST" && paidMatch) {
    if (!requireAuth(req, res, { csrf: true })) return;
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

initialiseData().then(() => server.listen(PORT, () => console.log(`PRABHU STUDIO secure portal is running at http://localhost:${PORT}`))).catch((error) => {
  console.error(`Startup aborted: ${error.message}`);
  process.exit(1);
});

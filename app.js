"use strict";

const state = { authenticated: false, csrfToken: null, email: "", invoices: [] };
const $ = (id) => document.getElementById(id);
const loginDialog = $("loginDialog");
const billingGate = $("billingGate");
const dashboard = $("dashboard");
const invoiceList = $("invoiceList");
const billingSummary = $("billingSummary");

function showMessage(element, message = "", kind = "") {
  element.textContent = message;
  element.className = `form-message ${kind}`;
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) setSignedOut();
    throw new Error(body.error || "Request failed. Please try again.");
  }
  return body;
}

function formatMoney(amount) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(amount);
}

function setSignedOut() {
  state.authenticated = false;
  state.csrfToken = null;
  state.email = "";
  state.invoices = [];
  billingGate.classList.remove("is-hidden");
  dashboard.classList.add("is-hidden");
  $("signInButton").textContent = "Staff sign in";
}

function setSignedIn(session) {
  state.authenticated = true;
  state.csrfToken = session.csrfToken;
  state.email = session.email;
  billingGate.classList.add("is-hidden");
  dashboard.classList.remove("is-hidden");
  $("accountEmail").textContent = session.email;
  $("signInButton").textContent = "Billing dashboard";
}

function makeSummary(label, value) {
  const card = document.createElement("div");
  card.className = "summary-card";
  const labelNode = document.createElement("span");
  labelNode.textContent = label;
  const valueNode = document.createElement("strong");
  valueNode.textContent = value;
  card.append(labelNode, valueNode);
  return card;
}

function renderInvoices() {
  const invoices = state.invoices;
  const unpaid = invoices.filter((invoice) => invoice.status === "unpaid");
  const outstanding = unpaid.reduce((total, invoice) => total + Number(invoice.amount), 0);
  billingSummary.replaceChildren(
    makeSummary("Total invoices", String(invoices.length)),
    makeSummary("Outstanding", formatMoney(outstanding)),
    makeSummary("Paid invoices", String(invoices.length - unpaid.length)),
  );
  invoiceList.replaceChildren();
  if (!invoices.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No invoices yet. Create the first one here.";
    invoiceList.append(empty);
    return;
  }
  for (const invoice of invoices) {
    const row = document.createElement("article");
    row.className = "invoice-row";
    const detail = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = invoice.clientName;
    const descriptor = document.createElement("small");
    descriptor.textContent = `${invoice.id} · ${invoice.service}`;
    const date = document.createElement("small");
    date.textContent = `Due ${new Date(`${invoice.dueDate}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`;
    detail.append(title, descriptor, date);
    const amount = document.createElement("div");
    amount.className = "invoice-amount";
    const value = document.createElement("strong");
    value.textContent = formatMoney(invoice.amount);
    const status = document.createElement("span");
    status.className = `status ${invoice.status}`;
    status.textContent = invoice.status;
    amount.append(value, status);
    if (invoice.status === "unpaid") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mark-paid";
      button.textContent = "Mark paid";
      button.addEventListener("click", () => markPaid(invoice.id, button));
      amount.append(button);
    }
    row.append(detail, amount);
    invoiceList.append(row);
  }
}

async function loadInvoices() {
  if (!state.authenticated) return;
  invoiceList.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "muted";
  loading.textContent = "Loading invoices…";
  invoiceList.append(loading);
  try {
    const data = await request("/api/billing/invoices");
    state.invoices = data.invoices || [];
    renderInvoices();
  } catch (error) {
    invoiceList.textContent = "";
    const message = document.createElement("p");
    message.className = "form-message error";
    message.textContent = error.message;
    invoiceList.append(message);
  }
}

async function markPaid(invoiceId, button) {
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    await request(`/api/billing/invoices/${encodeURIComponent(invoiceId)}/paid`, {
      method: "POST",
      headers: { "X-CSRF-Token": state.csrfToken },
    });
    await loadInvoices();
  } catch (error) {
    button.disabled = false;
    button.textContent = error.message;
  }
}

function openLogin() {
  if (state.authenticated) {
    $("billing").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  showMessage($("loginMessage"));
  if (!loginDialog.open) loginDialog.showModal();
  window.setTimeout(() => $("loginEmail").focus(), 0);
}

$("signInButton").addEventListener("click", openLogin);
$("billingSignInButton").addEventListener("click", openLogin);
$("refreshInvoices").addEventListener("click", loadInvoices);

$("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  showMessage($("loginMessage"), "Signing in…");
  const form = new FormData(event.currentTarget);
  try {
    const session = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ email: form.get("email"), password: form.get("password") }) });
    setSignedIn(session);
    $("loginPassword").value = "";
    loginDialog.close();
    await loadInvoices();
  } catch (error) {
    showMessage($("loginMessage"), error.message, "error");
  } finally {
    submit.disabled = false;
  }
});

$("signOutButton").addEventListener("click", async () => {
  try { await request("/api/auth/logout", { method: "POST", headers: { "X-CSRF-Token": state.csrfToken } }); } catch { /* The UI should still clear a timed-out session. */ }
  setSignedOut();
});

$("invoiceForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  showMessage($("invoiceMessage"), "Creating invoice…");
  const form = new FormData(event.currentTarget);
  const payload = Object.fromEntries(form.entries());
  try {
    const result = await request("/api/billing/invoices", { method: "POST", headers: { "X-CSRF-Token": state.csrfToken }, body: JSON.stringify(payload) });
    event.currentTarget.reset();
    setDefaultDueDate();
    showMessage($("invoiceMessage"), `${result.invoice.id} created successfully.`, "success");
    await loadInvoices();
  } catch (error) {
    showMessage($("invoiceMessage"), error.message, "error");
  } finally {
    submit.disabled = false;
  }
});

function setDefaultDueDate() {
  const due = new Date();
  due.setDate(due.getDate() + 7);
  $("invoiceForm").elements.dueDate.value = due.toISOString().slice(0, 10);
}

async function initialise() {
  $("year").textContent = String(new Date().getFullYear());
  setDefaultDueDate();
  try {
    const session = await request("/api/auth/session");
    if (session.authenticated) {
      setSignedIn(session);
      await loadInvoices();
    } else setSignedOut();
  } catch { setSignedOut(); }
}

initialise();

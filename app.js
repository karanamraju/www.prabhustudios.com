"use strict";

const state = { authenticated: false, csrfToken: null, email: "", invoices: [] };
const $ = (id) => document.getElementById(id);
const loginDialog = $("loginDialog");
const billingGate = $("billingGate");
const dashboard = $("dashboard");
const invoiceList = $("invoiceList");
const billingSummary = $("billingSummary");
const invoiceSearch = $("invoiceSearch");
const invoiceStatus = $("invoiceStatus");
const invoiceResultCount = $("invoiceResultCount");
const heroCarousel = document.querySelector(".hero-carousel");
const heroSlides = heroCarousel ? Array.from(heroCarousel.querySelectorAll(".hero-slide")) : [];
let heroSlideIndex = 0;
let heroCarouselTimer;

function showHeroSlide(index) {
  if (!heroSlides.length) return;
  heroSlideIndex = (index + heroSlides.length) % heroSlides.length;
  heroSlides.forEach((slide, slideIndex) => slide.classList.toggle("is-active", slideIndex === heroSlideIndex));
}

function pauseHeroCarousel() {
  window.clearInterval(heroCarouselTimer);
  heroCarouselTimer = undefined;
}

function startHeroCarousel() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || heroSlides.length < 2) return;
  pauseHeroCarousel();
  heroCarouselTimer = window.setInterval(() => showHeroSlide(heroSlideIndex + 1), 5000);
}

if (heroSlides.length > 1) {
  $("heroPrevious").addEventListener("click", () => { showHeroSlide(heroSlideIndex - 1); startHeroCarousel(); });
  $("heroNext").addEventListener("click", () => { showHeroSlide(heroSlideIndex + 1); startHeroCarousel(); });
  heroCarousel.addEventListener("mouseenter", pauseHeroCarousel);
  heroCarousel.addEventListener("mouseleave", startHeroCarousel);
  heroCarousel.addEventListener("focusin", pauseHeroCarousel);
  heroCarousel.addEventListener("focusout", startHeroCarousel);
  startHeroCarousel();
}

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

function isOverdue(invoice) {
  if (invoice.status !== "unpaid") return false;
  const dueAt = new Date(`${invoice.dueDate}T23:59:59`).getTime();
  return Number.isFinite(dueAt) && dueAt < Date.now();
}

function displayStatus(invoice) {
  return isOverdue(invoice) ? "overdue" : invoice.status;
}

function filteredInvoices() {
  const query = invoiceSearch.value.trim().toLowerCase();
  const statusFilter = invoiceStatus.value;
  return state.invoices.filter((invoice) => {
    const statusMatches = statusFilter === "all" || displayStatus(invoice) === statusFilter;
    if (!statusMatches) return false;
    if (!query) return true;
    return [invoice.clientName, invoice.clientEmail, invoice.id, invoice.service].some((value) => String(value || "").toLowerCase().includes(query));
  });
}

function renderInvoices() {
  const invoices = state.invoices;
  const visibleInvoices = filteredInvoices();
  const unpaid = invoices.filter((invoice) => invoice.status === "unpaid");
  const paid = invoices.filter((invoice) => invoice.status === "paid");
  const overdue = invoices.filter(isOverdue);
  const totalBilled = invoices.reduce((total, invoice) => total + Number(invoice.amount), 0);
  const received = paid.reduce((total, invoice) => total + Number(invoice.amount), 0);
  const outstanding = unpaid.reduce((total, invoice) => total + Number(invoice.amount), 0);
  const overdueAmount = overdue.reduce((total, invoice) => total + Number(invoice.amount), 0);
  billingSummary.replaceChildren(
    makeSummary("Total billed", formatMoney(totalBilled)),
    makeSummary("Received", formatMoney(received)),
    makeSummary("Outstanding", formatMoney(outstanding)),
    makeSummary("Overdue", overdue.length ? `${overdue.length} - ${formatMoney(overdueAmount)}` : "None"),
  );
  invoiceResultCount.textContent = invoices.length ? `Showing ${visibleInvoices.length} of ${invoices.length} invoice${invoices.length === 1 ? "" : "s"}.` : "";
  invoiceList.replaceChildren();
  if (!invoices.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No invoices yet. Create the first one here.";
    invoiceList.append(empty);
    return;
  }
  if (!visibleInvoices.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No invoices match these filters.";
    invoiceList.append(empty);
    return;
  }
  for (const invoice of visibleInvoices) {
    const row = document.createElement("article");
    row.className = "invoice-row";
    const detail = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = invoice.clientName;
    const descriptor = document.createElement("small");
    descriptor.textContent = `${invoice.id} · ${invoice.service}`;
    const date = document.createElement("small");
    const dueLabel = isOverdue(invoice) ? "Overdue since" : "Due";
    date.textContent = `${dueLabel} ${new Date(`${invoice.dueDate}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`;
    detail.append(title, descriptor, date);
    const amount = document.createElement("div");
    amount.className = "invoice-amount";
    const value = document.createElement("strong");
    value.textContent = formatMoney(invoice.amount);
    const status = document.createElement("span");
    status.className = `status ${displayStatus(invoice)}`;
    status.textContent = displayStatus(invoice);
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
invoiceSearch.addEventListener("input", renderInvoices);
invoiceStatus.addEventListener("change", renderInvoices);

$("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const submit = event.submitter;
  submit.disabled = true;
  showMessage($("loginMessage"), "Signing in…");
  const form = new FormData(formElement);
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
  const formElement = event.currentTarget;
  const submit = event.submitter;
  submit.disabled = true;
  showMessage($("invoiceMessage"), "Creating invoice…");
  const form = new FormData(event.currentTarget);
  const payload = Object.fromEntries(form.entries());
  try {
    const result = await request("/api/billing/invoices", { method: "POST", headers: { "X-CSRF-Token": state.csrfToken }, body: JSON.stringify(payload) });
    formElement.reset();
    setDefaultDueDate();
    const notifiedChannels = (result.clientNotifications || []).filter((notification) => notification.status === "sent").map((notification) => notification.channel);
    const clientNotice = notifiedChannels.length ? ` Client notified by ${notifiedChannels.join(" and ")}.` : payload.clientPhone ? " Client notification needs Twilio and a public website URL to be configured." : "";
    showMessage($("invoiceMessage"), `${result.invoice.id} created and PDF emailed to ${result.emailedTo}.${clientNotice}`, "success");
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

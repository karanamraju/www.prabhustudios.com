"use strict";

const state = { authenticated: false, csrfToken: null, email: "", role: "", invoices: [], staff: [], ownerResetToken: null };
const $ = (id) => document.getElementById(id);
const loginDialog = $("loginDialog");
const billingGate = $("billingGate");
const dashboard = $("dashboard");
const invoiceList = $("invoiceList");
const billingSummary = $("billingSummary");
const invoiceSearch = $("invoiceSearch");
const invoiceStatus = $("invoiceStatus");
const invoiceResultCount = $("invoiceResultCount");
const serviceSelect = $("serviceSelect");
const customServiceField = $("customServiceField");
const customServiceInput = $("customServiceInput");
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

// ==========================================
// RENDER SERVER CONNECTION
// ==========================================
const API_BASE_URL = "https://prabhu-studio-billing.onrender.com";

async function request(url, options = {}) {
  const response = await fetch(API_BASE_URL + url, {
    credentials: "include",
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
// ==========================================

function formatMoney(amount) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(amount);
}

function setSignedOut() {
  state.authenticated = false;
  state.csrfToken = null;
  state.email = "";
  state.role = "";
  state.invoices = [];
  state.staff = [];
  billingGate.classList.remove("is-hidden");
  dashboard.classList.add("is-hidden");
  $("staffAdmin").classList.add("is-hidden");
  $("signInButton").textContent = "Staff sign in";
}

function isOwner() {
  return state.role === "owner";
}

function setSignedIn(session) {
  state.authenticated = true;
  state.csrfToken = session.csrfToken;
  state.email = session.email;
  state.role = session.role;
  billingGate.classList.add("is-hidden");
  dashboard.classList.remove("is-hidden");
  $("staffAdmin").classList.toggle("is-hidden", !isOwner());
  $("accountEmail").textContent = `${session.email} - ${isOwner() ? "Owner" : "Billing employee"}`;
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
    if (invoice.createdBy && invoice.createdBy.name) {
      const createdBy = document.createElement("small");
      createdBy.textContent = `Created by ${invoice.createdBy.name}`;
      detail.append(createdBy);
    }
    const amount = document.createElement("div");
    amount.className = "invoice-amount";
    const value = document.createElement("strong");
    value.textContent = formatMoney(invoice.amount);
    const status = document.createElement("span");
    status.className = `status ${displayStatus(invoice)}`;
    status.textContent = displayStatus(invoice);
    amount.append(value, status);
    if (invoice.status === "unpaid" && isOwner()) {
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

function renderStaff() {
  const staffList = $("staffList");
  staffList.replaceChildren();
  if (!state.staff.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No staff accounts yet.";
    staffList.append(empty);
    return;
  }
  for (const staff of state.staff) {
    const row = document.createElement("article");
    row.className = "staff-row";
    const details = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = staff.name;
    const email = document.createElement("small");
    email.textContent = staff.email;
    const role = document.createElement("small");
    role.textContent = staff.role === "owner" ? "Owner" : "Billing employee";
    details.append(name, email, role);
    const controls = document.createElement("div");
    const status = document.createElement("span");
    status.className = `staff-status ${staff.status}`;
    status.textContent = staff.status;
    controls.append(status);
    if (staff.role !== "owner") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "staff-toggle";
      button.textContent = staff.status === "active" ? "Disable" : "Enable";
      button.addEventListener("click", () => toggleStaffStatus(staff, button));
      const resetButton = document.createElement("button");
      resetButton.type = "button";
      resetButton.className = "staff-toggle";
      resetButton.textContent = "Reset password";
      resetButton.addEventListener("click", () => showPasswordReset(staff, row));
      controls.append(button, resetButton);
    }
    row.append(details, controls);
    staffList.append(row);
  }
}

function showPasswordReset(staff, row) {
  const existing = row.querySelector(".staff-password-reset");
  if (existing) {
    existing.remove();
    return;
  }
  const form = document.createElement("form");
  form.className = "staff-password-reset";
  const label = document.createElement("label");
  label.textContent = `New password for ${staff.name}`;
  const input = document.createElement("input");
  input.name = "password";
  input.type = "password";
  input.autocomplete = "new-password";
  input.minLength = 12;
  input.required = true;
  label.append(input);
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "staff-toggle";
  save.textContent = "Save new password";
  const message = document.createElement("p");
  message.className = "form-message";
  form.append(label, save, message);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    save.disabled = true;
    showMessage(message, "Saving new password...");
    try {
      await request(`/api/billing/staff/${encodeURIComponent(staff.id)}/password`, {
        method: "POST",
        headers: { "X-CSRF-Token": state.csrfToken },
        body: JSON.stringify({ password: input.value }),
      });
      input.value = "";
      showMessage(message, "Password reset. The employee must sign in again.", "success");
    } catch (error) {
      showMessage(message, error.message, "error");
    } finally {
      save.disabled = false;
    }
  });
  row.append(form);
  input.focus();
}

async function loadStaff() {
  if (!state.authenticated || !isOwner()) return;
  try {
    const data = await request("/api/billing/staff");
    state.staff = data.staff || [];
    renderStaff();
  } catch (error) {
    showMessage($("staffMessage"), error.message, "error");
  }
}

async function toggleStaffStatus(staff, button) {
  button.disabled = true;
  try {
    await request(`/api/billing/staff/${encodeURIComponent(staff.id)}/${staff.status === "active" ? "disable" : "enable"}`, {
      method: "POST",
      headers: { "X-CSRF-Token": state.csrfToken },
    });
    await loadStaff();
  } catch (error) {
    button.disabled = false;
    showMessage($("staffMessage"), error.message, "error");
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
  updateOwnerResetVisibility();
  if (!loginDialog.open) loginDialog.showModal();
  window.setTimeout(() => $("loginEmail").focus(), 0);
}

function updateOwnerResetVisibility() {
  const emailField = $("loginEmail");
  $("forgotOwnerPasswordButton").classList.toggle("is-hidden", !emailField.value.trim() || !emailField.validity.valid);
}

function showOwnerResetRequest() {
  const loginEmail = $("loginEmail").value.trim();
  if (!loginEmail || !$("loginEmail").validity.valid) {
    showMessage($("loginMessage"), "Enter the studio owner email first.", "error");
    $("loginEmail").focus();
    return;
  }
  $("ownerResetRequestPanel").classList.remove("is-hidden");
  $("ownerResetConfirmPanel").classList.add("is-hidden");
  $("ownerResetEmail").value = loginEmail;
  showMessage($("ownerResetRequestMessage"));
  if (!loginDialog.open) loginDialog.showModal();
  window.setTimeout(() => $("ownerResetEmail").focus(), 0);
}

function showOwnerResetConfirmation(token, smsOtpRequired = false) {
  state.ownerResetToken = token;
  $("ownerResetRequestPanel").classList.add("is-hidden");
  $("ownerResetConfirmPanel").classList.remove("is-hidden");
  $("ownerResetOtpPanel").classList.toggle("is-hidden", !smsOtpRequired);
  $("ownerResetConfirmForm").elements.otp.required = smsOtpRequired;
  showMessage($("ownerResetConfirmMessage"));
  if (!loginDialog.open) loginDialog.showModal();
  window.setTimeout(() => (smsOtpRequired ? $("sendOwnerResetOtpButton") : $("ownerResetConfirmForm").elements.password).focus(), 0);
}

$("signInButton").addEventListener("click", openLogin);
$("billingSignInButton").addEventListener("click", openLogin);
$("forgotOwnerPasswordButton").addEventListener("click", showOwnerResetRequest);
$("loginEmail").addEventListener("input", updateOwnerResetVisibility);
$("refreshInvoices").addEventListener("click", loadInvoices);
$("refreshStaff").addEventListener("click", loadStaff);
invoiceSearch.addEventListener("input", renderInvoices);
invoiceStatus.addEventListener("change", renderInvoices);
serviceSelect.addEventListener("change", updateCustomServiceField);

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
    // లాగిన్ సక్సెస్ అయిన వెంటనే బిల్లింగ్ సెక్షన్‌కి ఆటోమేటిక్‌గా నావిగేట్ అవుతుంది (స్క్రోల్ అవుతుంది)
    $("billing").scrollIntoView({ behavior: "smooth", block: "start" });
    await loadInvoices();
    await loadStaff();
  } catch (error) {
    showMessage($("loginMessage"), error.message, "error");
  } finally {
    submit.disabled = false;
  }
});

$("ownerResetRequestForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  showMessage($("ownerResetRequestMessage"), "Sending reset link...");
  const form = new FormData(event.currentTarget);
  try {
    const result = await request("/api/auth/owner-password-reset/request", {
      method: "POST",
      body: JSON.stringify({ email: form.get("email") }),
    });
    showMessage($("ownerResetRequestMessage"), result.message || "If the address is the owner account, check its inbox for a reset link.", "success");
  } catch (error) {
    showMessage($("ownerResetRequestMessage"), error.message, "error");
  } finally {
    submit.disabled = false;
  }
});

$("sendOwnerResetOtpButton").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (!state.ownerResetToken) {
    showMessage($("ownerResetConfirmMessage"), "Open a new password-reset link from the owner email.", "error");
    return;
  }
  button.disabled = true;
  showMessage($("ownerResetConfirmMessage"), "Sending SMS OTP...");
  try {
    const result = await request("/api/auth/owner-password-reset/otp", {
      method: "POST",
      body: JSON.stringify({ token: state.ownerResetToken }),
    });
    showMessage($("ownerResetConfirmMessage"), result.message || "SMS OTP sent to the registered owner mobile number.", "success");
    $("ownerResetConfirmForm").elements.otp.focus();
  } catch (error) {
    showMessage($("ownerResetConfirmMessage"), error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("ownerResetConfirmForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const submit = event.submitter;
  const form = new FormData(formElement);
  if (form.get("password") !== form.get("confirmation")) {
    showMessage($("ownerResetConfirmMessage"), "The two passwords do not match.", "error");
    return;
  }
  submit.disabled = true;
  showMessage($("ownerResetConfirmMessage"), "Resetting password...");
  try {
    await request("/api/auth/owner-password-reset/confirm", {
      method: "POST",
      body: JSON.stringify({ token: state.ownerResetToken, otp: form.get("otp"), password: form.get("password") }),
    });
    state.ownerResetToken = null;
    formElement.reset();
    $("ownerResetConfirmPanel").classList.add("is-hidden");
    showMessage($("loginMessage"), "Owner password reset. Sign in with your new password.", "success");
  } catch (error) {
    showMessage($("ownerResetConfirmMessage"), error.message, "error");
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
  if (payload.service === "__custom__") payload.service = payload.customService;
  delete payload.customService;
  try {
    const result = await request("/api/billing/invoices", { method: "POST", headers: { "X-CSRF-Token": state.csrfToken }, body: JSON.stringify(payload) });
    formElement.reset();
    updateCustomServiceField();
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

$("staffForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const submit = event.submitter;
  submit.disabled = true;
  showMessage($("staffMessage"), "Creating employee login...");
  const form = new FormData(formElement);
  try {
    const result = await request("/api/billing/staff", {
      method: "POST",
      headers: { "X-CSRF-Token": state.csrfToken },
      body: JSON.stringify({ name: form.get("name"), email: form.get("email"), password: form.get("password") }),
    });
    formElement.reset();
    showMessage($("staffMessage"), `${result.staff.name} can now sign in with the new billing employee account.`, "success");
    await loadStaff();
  } catch (error) {
    showMessage($("staffMessage"), error.message, "error");
  } finally {
    submit.disabled = false;
  }
});

function setDefaultDueDate() {
  const due = new Date();
  due.setDate(due.getDate() + 7);
  $("invoiceForm").elements.dueDate.value = due.toISOString().slice(0, 10);
}

function updateCustomServiceField() {
  const customSelected = serviceSelect.value === "__custom__";
  customServiceField.classList.toggle("is-hidden", !customSelected);
  customServiceInput.required = customSelected;
  if (!customSelected) customServiceInput.value = "";
}

async function initialise() {
  $("year").textContent = String(new Date().getFullYear());
  setDefaultDueDate();
  updateCustomServiceField();
  const resetToken = new URLSearchParams(window.location.search).get("reset");
  if (resetToken) {
    const smsOtpRequired = new URLSearchParams(window.location.search).get("sms") === "1";
    window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.hash}`);
    showOwnerResetConfirmation(resetToken, smsOtpRequired);
  }
  try {
    const session = await request("/api/auth/session");
    if (session.authenticated) {
      setSignedIn(session);
      $("billing").scrollIntoView({ behavior: "smooth", block: "start" });
      await loadInvoices();
      await loadStaff();
    } else setSignedOut();
  } catch { setSignedOut(); }
}

initialise();

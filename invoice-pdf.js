"use strict";

const path = require("node:path");
const PDFDocument = require("pdfkit");

const FOUNDER_PHOTO = path.join(__dirname, "JAMES.JPG");

function pdfSecurityOptions() {
  const ownerPassword = String(process.env.INVOICE_PDF_OWNER_PASSWORD || "");
  if (!ownerPassword) return {};

  return {
    pdfVersion: "1.7ext3",
    ownerPassword,
    permissions: {
      printing: "highResolution",
      modifying: false,
      copying: false,
      annotating: false,
      fillingForms: false,
      contentAccessibility: true,
      documentAssembly: false,
    },
  };
}

function formatAmount(value) {
  return `INR ${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(value) {
  return new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
}

function detailRow(document, label, value, y) {
  document.font("Helvetica-Bold").fontSize(10).fillColor("#40556a").text(label.toUpperCase(), 54, y);
  document.font("Helvetica").fontSize(11).fillColor("#10263d").text(String(value), 190, y, { width: 340 });
}

function drawOriginalWatermark(document, invoice) {
  const watermarkText = `ORIGINAL - ${invoice.id} - ${invoice.clientEmail}`;

  document.save();
  document.opacity(0.1).image(FOUNDER_PHOTO, 176, 184, { fit: [245, 380], align: "center", valign: "center" });
  document.opacity(0.14).fillColor("#b06b2f").font("Helvetica-Bold").fontSize(15).rotate(-34, { origin: [297, 430] }).text(watermarkText, 92, 418, { width: 410, align: "center" });
  document.restore();
}

function buildInvoicePdf(invoice) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({
      size: "A4",
      margin: 54,
      info: { Title: `Invoice ${invoice.id}`, Author: "PRABHU STUDIO", Subject: "Original client-personalized invoice" },
      ...pdfSecurityOptions(),
    });
    const chunks = [];
    document.on("data", (chunk) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);

    drawOriginalWatermark(document, invoice);
    document.rect(0, 0, document.page.width, 118).fill("#081a2e");
    document.font("Helvetica-Bold").fontSize(24).fillColor("#ffffff").text("PRABHU STUDIO", 54, 42);
    document.font("Helvetica").fontSize(10).fillColor("#ffbd83").text("Photography - Videography - Editing", 54, 75);
    document.font("Helvetica-Bold").fontSize(18).fillColor("#081a2e").text("INVOICE", 54, 155);
    document.font("Helvetica").fontSize(10).fillColor("#40556a").text(invoice.id, 54, 181);

    document.roundedRect(54, 220, 487, 72, 8).fill("#edf3f8");
    document.font("Helvetica").fontSize(10).fillColor("#40556a").text("AMOUNT DUE", 75, 238);
    document.font("Helvetica-Bold").fontSize(22).fillColor("#081a2e").text(formatAmount(invoice.amount), 75, 255);

    detailRow(document, "Client", invoice.clientName, 330);
    detailRow(document, "Email", invoice.clientEmail, 360);
    if (invoice.clientPhone) detailRow(document, "Mobile", invoice.clientPhone, 390);
    detailRow(document, "Service", invoice.service, invoice.clientPhone ? 420 : 390);
    detailRow(document, "Due date", formatDate(invoice.dueDate), invoice.clientPhone ? 450 : 420);
    detailRow(document, "Status", invoice.status === "paid" ? "Paid" : "Payment pending", invoice.clientPhone ? 480 : 450);

    if (invoice.notes) {
      const notesY = invoice.clientPhone ? 530 : 500;
      document.font("Helvetica-Bold").fontSize(10).fillColor("#40556a").text("NOTES", 54, notesY);
      document.font("Helvetica").fontSize(11).fillColor("#10263d").text(invoice.notes, 54, notesY + 20, { width: 487, lineGap: 3 });
    }

    document.moveTo(54, 730).lineTo(541, 730).strokeColor("#d5e0e9").stroke();
    document.font("Helvetica").fontSize(9).fillColor("#40556a").text("Thank you for choosing PRABHU STUDIO.", 54, 746);
    document.font("Helvetica").fontSize(9).fillColor("#40556a").text("Original, client-personalized invoice - unauthorized changes are not authorized.", 54, 762);
    document.end();
  });
}

module.exports = { buildInvoicePdf };

import express from "express";
import OpenAI from "openai";
import { Resend } from "resend";
import puppeteer from "puppeteer";

const app = express();
app.use(express.json({ limit: "2mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const resend = new Resend(process.env.RESEND_API_KEY);

/* =========================
   Utility
========================= */

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeFieldValue(field) {
  if (!field) return "";

  try {
    const v = field.value;

    if (typeof v === "string") return v;
    if (typeof v === "number") return String(v);
    if (typeof v === "boolean") return v ? "yes" : "no";

    if (Array.isArray(v)) {
      return v.map(x => JSON.stringify(x)).join(" ");
    }

    if (typeof v === "object" && v !== null) {
      return JSON.stringify(v);
    }

    return "";
  } catch {
    return "";
  }
}

/* =========================
   🔥 最終抽出（確定版）
========================= */

function extractSmart(fields) {
  const raw = fields
    .map(f => normalizeFieldValue(f))
    .join(" ")
    .toLowerCase();

  const pick = (keywords) => {
    for (const k of keywords) {
      if (raw.includes(k)) return k;
    }
    return "";
  };

  return {
    processingMethod: pick(["blow", "injection", "extrusion", "molding"]),
    currentMaterial: pick(["pet", "pp", "pe", "ps"]),
    bioMaterial: pick(["starch", "pla", "pha", "biodegradable"]),
    productionScale: pick(["small", "medium", "large"]),
    projectStage: pick(["pilot", "planning", "trial"]),
    equipment: pick(["equipment", "machine", "extruder"])
  };
}

function formatText(str, fallback) {
  if (!str) return fallback;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function inferApplication(product, method) {
  const text = (product + " " + method).toLowerCase();

  if (text.includes("film")) return "Flexible Packaging Film";
  if (text.includes("mulch")) return "Agricultural Film";
  if (text.includes("rigid")) return "Rigid Packaging";
  if (text.includes("injection")) return "Injection Molded Product";
  if (text.includes("blow")) return "Blow Molded Product";

  return "General Plastic Application";
}

function injectHtml(template, data) {
  let html = template;

  Object.keys(data).forEach(key => {
    const value = data[key] ?? "";
    html = html.replace(
      new RegExp(`{{\\s*${key}\\s*}}`, "g"),
      escapeHtml(String(value))
    );
  });

  html = html.replace(/{{.*?}}/g, "");
  html = html.replace(/undefined/g, "");

  return html;
}

/* =========================
   MAIN
========================= */

app.post("/generate-report", async (req, res) => {
  try {

    // 🔥 これが最後の鍵
    console.log("===== REQUEST BODY =====");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("========================");

    const fields = req.body?.data?.fields || [];

    const emailField = fields.find(f => f.type === "INPUT_EMAIL");
    const email = normalizeFieldValue(emailField);

    if (!email) return res.status(400).json({ error: "EMAIL NOT FOUND" });

    /* ===== 基本 ===== */

    const rawText = fields.map(f => normalizeFieldValue(f)).join(" ");

    const clientName = rawText || "—";
    const clientCompany = rawText.includes("eco") ? "EcoPack Solutions Inc." : "—";
    const clientCountry = rawText.includes("japan") ? "Japan" : "—";

    const product = rawText;

    /* ===== 抽出 ===== */

    const smart = extractSmart(fields);

    const application = inferApplication(product, smart.processingMethod);

    /* ===== DATA ===== */

    const data = {
      client_name: clientName,
      client_company: clientCompany,
      client_country: clientCountry,

      application,

      current_material: formatText(smart.currentMaterial, "Not specified"),
      bio_material: formatText(smart.bioMaterial, "Not specified"),
      processing_method: formatText(smart.processingMethod, "Not specified"),
      production_scale: formatText(smart.productionScale, "Not specified"),
      project_stage: formatText(smart.projectStage, "Preliminary evaluation stage"),

      equipment: formatText(smart.equipment, "Standard processing equipment (assumed)"),

      submission_reference: "Initial screening input",

      report_id: "FV-" + Date.now(),
      report_date: new Date().toLocaleDateString(),

      executive_summary_overview:
        "This report provides an initial technical assessment of biodegradable material compatibility.",

      executive_summary_findings:
        "The evaluation indicates moderate compatibility with potential adjustments required in processing and material handling.",

      executive_summary_conclusion:
        "A pilot validation is recommended prior to full-scale implementation.",

      feasibility_level: "MODERATE",
      feasibility_class: "level-moderate",
      feasibility_explanation: "Feasible with adjustments.",

      thermal_risk: "Moderate",
      thermal_risk_class: "risk-moderate",
      thermal_note: "Further validation recommended under controlled conditions",

      processing_risk: "Moderate",
      processing_risk_class: "risk-moderate",
      processing_note: "Process optimization may be required",

      equipment_risk: "Low",
      equipment_risk_class: "risk-low",
      equipment_note: "Further equipment-specific validation recommended",

      score_thermal_class: "moderate",
      score_processing_class: "moderate",
      score_equipment_class: "low",
      score_cert_class: "na",
      score_eol_class: "na",

      score_thermal_level: "MODERATE",
      score_processing_level: "MODERATE",
      score_equipment_level: "LOW",
      score_cert_level: "N/A",
      score_eol_level: "N/A",

      score_thermal_assessment: "Preliminary assessment based on available input data",
      score_processing_assessment: "Initial evaluation under standard processing assumptions",
      score_equipment_assessment: "Compatibility inferred from typical equipment configuration",
      score_cert_assessment: "Certification status not yet verified",
      score_eol_assessment: "End-of-life behaviour requires confirmation",

      score_thermal_note: "Further validation recommended",
      score_processing_note: "Process optimization may be required",
      score_equipment_note: "Further equipment-specific validation recommended",
      score_cert_note: "Regulatory compliance review required",
      score_eol_note: "Disposal evaluation required",

      obs_1_title: "Material Behaviour",
      obs_1_body: "Material behaviour differs from conventional plastics.",

      obs_2_title: "Processing Adjustment",
      obs_2_body: "Processing adjustments may be required.",

      obs_3_title: "Performance Variability",
      obs_3_body: "Performance may vary.",

      risk_1_title: "Processing Stability",
      risk_1_body: "Stability may vary.",

      risk_2_title: "Equipment Interaction",
      risk_2_body: "Compatibility issues possible.",

      strategic_recommendation:
        "Conduct pilot validation before implementation.",

      disclaimer:
        "Preliminary advisory only."
    };

    /* ===== HTML ===== */

    const htmlTemplate = `ここにHTML貼る`;

    const html = injectHtml(htmlTemplate, data);

    /* ===== PDF ===== */

    const browser = await puppeteer.launch({
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true
    });

    await browser.close();

    /* ===== EMAIL ===== */

    await resend.emails.send({
      from: "FairVia <info@ilnautico.com>",
      to: email,
      subject: "FairVia Report",
      html: "<p>Your report is attached.</p>",
      attachments: [
        {
          filename: "report.pdf",
          content: pdf.toString("base64")
        }
      ]
    });

    res.send("OK");

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(8080, () => console.log("Server running"));

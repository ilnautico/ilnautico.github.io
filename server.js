import express from "express";
import puppeteer from "puppeteer";
import { Resend } from "resend";


/* ===== 追加（PDF用）===== */
import fs from "fs";
import path from "path";
/* ======================= */

const app = express();
app.use(express.json());
console.log("TEST ENV:", process.env.TEST_ENV_CHECK);
const resend = new Resend(process.env.RESEND_API_KEY);
console.log("ENV KEYS:", Object.keys(process.env).filter(k => k.includes("ANTH")));
console.log("ANTH KEY LEN:", process.env.ANTHROPIC_API_KEY ? process.env.ANTHROPIC_API_KEY.length : 0);

// =========================
// Claude生成
// =========================
async function generateClaudeHypothesis(prompt) {
    console.log("API KEY:", process.env.ANTHROPIC_API_KEY);
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
  model: "claude-3-5-sonnet-20241022",
  max_tokens: 2000,
  messages: [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: prompt
        }
      ]
    }
  ]
})

  if (!response.ok) {
    const errorText = await response.text();
    console.error("❌ Claude API ERROR:", errorText);
    throw new Error("Claude API failed");
  }

  const data = await response.json();
  return data.content?.[0]?.text || "No response from Claude";
}

// =========================
// HTML差し込み
// =========================
function injectHtml(template, data) {
  let html = template;

  Object.keys(data).forEach((key) => {
    const regex = new RegExp("\\{\\{\\s*" + key + "\\s*\\}\\}", "g");
    html = html.replace(regex, data[key] || "");
  });

  return html;
}

// =========================
// 値取得
// =========================
function getValue(fields, keyword) {
  const field = fields.find((f) =>
    (f.label || "").toLowerCase().includes(keyword.toLowerCase())
  );

  if (!field) return "";

  if (Array.isArray(field.value) && Array.isArray(field.options)) {
    const selected = field.options.find((opt) =>
      field.value.includes(opt.id)
    );
    if (selected?.text) return selected.text.toLowerCase();
  }

  if (typeof field.value === "string") {
    return field.value.toLowerCase();
  }

  return "";
}

// =========================
// 固定コメント（そのまま維持）
// =========================
const SUMMARY_OVERVIEW =
  "No immediate incompatibility is identified at this screening stage. The primary constraint lies in undefined processing and material conditions.";

const SUMMARY_FINDINGS =
  "Technical feasibility cannot be confirmed under the current conditions due to undefined processing parameters.";

const SUMMARY_CONCLUSION =
  "Transition should not proceed without prior pilot validation under controlled conditions.";

const FEASIBILITY_EXPLANATION =
  "This assessment reflects a screening-level evaluation based on the available inputs. Validation under controlled conditions is required before any transition decision.";

const OBS_1_TITLE = "Processing Condition Uncertainty";
const OBS_1_BODY =
  "Undefined processing conditions introduce variability in material behavior during processing, affecting product consistency and performance.";

const OBS_2_TITLE = "Operational Stability Risk";
const OBS_2_BODY =
  "Unverified process settings increase the risk of unstable conversion behavior during early production runs, potentially reducing consistency and increasing adjustment requirements.";

const OBS_3_TITLE = "Application Requirement Gap";
const OBS_3_BODY =
  "Undefined end-use requirements prevent confirmation that the selected material and process combination will meet performance expectations under real application conditions.";

const RISK_1_TITLE = "Performance Instability";
const RISK_1_BODY =
  "Material mismatch may lead to unstable product performance.";

const RISK_2_TITLE = "Operational Inefficiency";
const RISK_2_BODY =
  "Unverified conditions may reduce operational efficiency.";

const STRATEGIC_RECOMMENDATION =
  "A controlled pilot validation is recommended before any production-scale transition decision is made.";

const DISCLAIMER =
  "This report is a preliminary screening-level technical assessment based solely on submitted information. It does not replace pilot testing, detailed engineering review, or commercial qualification.";

// =========================
// 🔥 PDF確認ルート（追加だけ）
// =========================
app.get("/generate-pdf", async (req, res) => {
  try {
    const templatePath = path.join(process.cwd(), "template.html");
    const htmlTemplate = fs.readFileSync(templatePath, "utf8");

    const finalHtml = injectHtml(htmlTemplate, {
      compatibility_level: "Moderate",
      application: "Flexible Food Packaging Film",
      material_transition: "CPP → PHBV",
      assessment_type: "Tier 2 – Pre-Commercial Feasibility",
      report_date: "March 2025",

      executive_summary: SUMMARY_OVERVIEW,
      key_risk: SUMMARY_FINDINGS,

      obs1_title: OBS_1_TITLE,
      obs1_body: OBS_1_BODY,
      obs2_title: OBS_2_TITLE,
      obs2_body: OBS_2_BODY,
      obs3_title: OBS_3_TITLE,
      obs3_body: OBS_3_BODY,

      risk1_title: RISK_1_TITLE,
      risk1_body: RISK_1_BODY,
      risk2_title: RISK_2_TITLE,
      risk2_body: RISK_2_BODY,

      recommendation: STRATEGIC_RECOMMENDATION,
      disclaimer: DISCLAIMER
    });

    const browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    await page.setContent(finalHtml, { waitUntil: "networkidle0" });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true
    });

    await browser.close();

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": "inline; filename=report.pdf"
    });

    res.send(pdf);

  } catch (err) {
    console.error(err);
    res.status(500).send("PDF generation failed");
  }
});
app.post("/tally", async (req, res) => {
  console.log("🔥 TIER2 REQUEST HIT");

  try {
    const fields = req.body.data.fields;

    const application = getValue(fields, "application");
    const currentMaterial = getValue(fields, "current material");
    const bioMaterial = getValue(fields, "target material");
    const processing = getValue(fields, "processing");
    const equipment = getValue(fields, "equipment");
    const productionScale = getValue(fields, "production scale");
    const projectStage = getValue(fields, "project");
    const technicalConcern = getValue(fields, "concern");

    const claudeReport = await generateClaudeHypothesis({
      application,
      material: currentMaterial,
      bioMaterial,
      processing,
      equipment,
      scale: productionScale,
      stage: projectStage,
      concern: technicalConcern
    });

    console.log("✅ CLAUDE GENERATED");

    res.json({
      success: true,
      report: claudeReport
    });

  } catch (err) {
    console.error("❌ TIER2 ERROR:", err);
    res.status(500).json({ error: "Tier2 generation failed" });
  }
});// =========================
// サーバー起動（ここは最後）
// =========================
app.listen(3000, () => {
  console.log("Server running on port 3000");
});
// =========================
// HTMLテンプレ（あなたの本番HTML）
// =========================
const htmlTemplate = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FairVia™ Technical Screening Report</title>
<style>

/* ── Reset ── */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

/* ── Page setup ── */
@page {
  size: A4;
  margin: 0;
}

html {
  width: 210mm;
  background: #ffffff;
}

body {
  width: 210mm;
  background: #ffffff;
  font-family: Georgia, "Times New Roman", serif;
  color: #2c2c2c;
  font-size: 10pt;
  line-height: 1.6;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
  margin: 0;
}

/* ── Page container ── */
.page {
  display: flex;
  flex-direction: column;
  width: 210mm;
  height: 297mm;
  box-sizing: border-box;
  page-break-after: always;
  background: #ffffff;
  position: relative;
}

.page:last-child {
  page-break-after: auto;
}

/* ── Page body grows to push footer down ── */
.page-body {
  flex: 1;
  min-height: 0;
  padding: 8mm 14mm 14mm;
}

/* ── Page footer: always at bottom ── */
.page-footer {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 100%;
  background: #17263c;
}

.page-footer-gold {
  height: 1px;
  background: #b4965a;
  opacity: 0.6;
}

.page-footer-inner {
  padding: 3mm 14mm;
  display: flex;
  justify-content: space-between;
}

.page-footer-left {
  font-size: 6.5pt;
  color: rgba(255,255,255,0.45);
  letter-spacing: 0.06em;
}

.page-footer-right {
  font-size: 6.5pt;
  color: #b4965a;
}

/* ═══════════════════════════════════════════
   COVER PAGE
═══════════════════════════════════════════ */

.cover {
  background: #17263c;
}

.cover-inner {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 0;
}

.cover-header {
  padding: 10mm 14mm 0;
  display: block;
}

.cover-brand {
  font-family: Georgia, serif;
  font-size: 8pt;
  color: #b4965a;
  letter-spacing: 0.25em;
  text-transform: uppercase;
  display: block;
  margin-bottom: 1mm;
}

.cover-service {
  font-size: 7pt;
  color: rgba(255,255,255,0.5);
  letter-spacing: 0.15em;
  text-transform: uppercase;
  display: block;
}

.cover-gold-rule {
  margin: 8mm 14mm 0;
  height: 1px;
  background: #b4965a;
  opacity: 0.4;
}

.cover-main {
  padding: 16mm 14mm 0;
  display: block;
  flex: 1;
}

.cover-report-type {
  font-size: 7.5pt;
  color: #b4965a;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  display: block;
  margin-bottom: 5mm;
}

.cover-title {
  font-family: Georgia, serif;
  font-size: 28pt;
  font-weight: normal;
  color: #ffffff;
  line-height: 1.15;
  display: block;
  margin-bottom: 3mm;
}

.cover-subtitle {
  font-family: Georgia, serif;
  font-size: 13pt;
  font-weight: normal;
  color: #b4965a;
  letter-spacing: 0.03em;
  display: block;
  margin-bottom: 12mm;
}

.cover-divider {
  width: 20mm;
  height: 2px;
  background: #b4965a;
  display: block;
  margin-bottom: 10mm;
}

.cover-client-box {
  background: rgba(180, 150, 90, 0.12);
  border-left: 3px solid #b4965a;
  padding: 6mm 8mm;
  display: block;
  margin-bottom: 12mm;
}

.cover-client-label {
  font-size: 7pt;
  color: #b4965a;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  display: block;
  margin-bottom: 2mm;
}

.cover-client-name {
  font-size: 13pt;
  color: #ffffff;
  font-weight: normal;
  display: block;
  margin-bottom: 1.5mm;
}

.cover-client-detail {
  font-size: 8.5pt;
  color: rgba(255,255,255,0.6);
  display: block;
  margin-bottom: 0.8mm;
}

.cover-meta-grid {
  display: block;
}

.cover-meta-row {
  padding: 2.5mm 0;
  border-top: 1px solid rgba(180,150,90,0.25);
  display: block;
  overflow: hidden;
}

.cover-meta-row:last-child {
  border-bottom: 1px solid rgba(180,150,90,0.25);
}

.cover-meta-label {
  font-size: 7pt;
  color: rgba(255,255,255,0.45);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  float: left;
  width: 38mm;
  display: inline-block;
}

.cover-meta-value {
  font-size: 8.5pt;
  color: rgba(255,255,255,0.85);
  display: inline-block;
}

.cover-badge-area {
  padding: 10mm 14mm 0;
  display: block;
}

.cover-badge-label {
  font-size: 7pt;
  color: rgba(255,255,255,0.45);
  letter-spacing: 0.15em;
  text-transform: uppercase;
  display: block;
  margin-bottom: 3mm;
}

.cover-badge {
  display: inline-block;
  padding: 3mm 8mm;
  border: 1.5px solid #b4965a;
  font-size: 11pt;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.cover-badge.level-low      { color: #6db07a; border-color: #6db07a; }
.cover-badge.level-moderate { color: #c4963e; border-color: #c4963e; }
.cover-badge.level-high     { color: #c0614a; border-color: #c0614a; }

/* Cover footer */
.cover-footer {
  background: #17263c;
  border-top: 1px solid rgba(180,150,90,0.25);
  padding: 5mm 14mm;
  display: flex;
  justify-content: space-between;
  flex-shrink: 0;
}

.cover-footer-left {
  font-size: 7pt;
  color: rgba(255,255,255,0.35);
  letter-spacing: 0.08em;
}

.cover-footer-right {
  font-size: 7pt;
  color: rgba(255,255,255,0.35);
  letter-spacing: 0.08em;
}

/* ═══════════════════════════════════════════
   CONTENT PAGES — header strip
═══════════════════════════════════════════ */

.page-header {
  background: #17263c;
  padding: 4mm 14mm;
  flex-shrink: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  overflow: hidden;
}

.page-header-left {
  font-size: 6.5pt;
  color: rgba(255,255,255,0.55);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  line-height: 1.4;
}

.page-header-right {
  font-size: 6.5pt;
  color: #b4965a;
  letter-spacing: 0.08em;
  line-height: 1.4;
}

.page-header-gold {
  height: 1.5px;
  background: #b4965a;
  flex-shrink: 0;
}

/* ── Section elements ── */

.section {
  break-inside: avoid;
  page-break-inside: avoid;
  margin-bottom: 7mm;
  display: block;
}

.section-label {
  font-size: 6.5pt;
  color: #b4965a;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  display: block;
  margin-bottom: 1mm;
}

.section-title {
  font-family: Georgia, serif;
  font-size: 14pt;
  font-weight: normal;
  color: #17263c;
  display: block;
  margin-bottom: 1.5mm;
}

.section-rule-full {
  height: 1px;
  background: #b4965a;
  display: block;
  margin-bottom: 5mm;
}

/* ── Body text ── */
.body-text {
  font-size: 9.5pt;
  color: #2c2c2c;
  line-height: 1.65;
  text-align: justify;
  display: block;
  margin-bottom: 3mm;
}

/* ── Info table ── */
.info-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 9pt;
  margin-bottom: 4mm;
}

.info-table tr:nth-child(odd) td  { background: #f5f3ee; }
.info-table tr:nth-child(even) td { background: #ffffff; }

.info-table td {
  padding: 2.5mm 4mm;
  vertical-align: top;
  border-bottom: 0.5px solid #ddd6c8;
}

.info-table td:first-child {
  width: 44mm;
  font-size: 8pt;
  font-weight: bold;
  color: #17263c;
  white-space: nowrap;
}

.info-table td:last-child { color: #2c2c2c; }

.info-table tr:last-child td { border-bottom: 1.5px solid #b4965a; }

/* ── Executive Summary blocks ── */
.summary-block {
  border-left: 3px solid #b4965a;
  padding-left: 4mm;
  margin-bottom: 4mm;
}

.summary-heading {
  display: block;
  font-size: 8pt;
  font-weight: bold;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #b4965a;
  margin-bottom: 1.5mm;
}

/* ── Feasibility scale ── */
.feasibility-scale {
  display: block;
  margin-bottom: 4mm;
}

.feasibility-scale-label {
  font-size: 7pt;
  color: #b4965a;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  display: block;
  margin-bottom: 2mm;
}

.feasibility-row {
  display: block;
  width: 72mm;
  padding: 2mm 4mm;
  margin-bottom: 1.2mm;
  border-radius: 2px;
  font-size: 9pt;
  overflow: hidden;
}

.feasibility-row.inactive {
  background: #f5f3ee;
  border: 0.5px solid #ddd6c8;
  color: #9a9088;
}

.feasibility-row.active {
  background: #17263c;
  border: 1px solid #b4965a;
  color: #ffffff;
}

.feasibility-dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  margin-right: 3mm;
  vertical-align: middle;
  position: relative;
  top: -1px;
}

.feasibility-row.active   .feasibility-dot { background: #b4965a; }
.feasibility-row.inactive .feasibility-dot { background: transparent; border: 1px solid #c8bfb0; }

.feasibility-text {
  font-size: 8.5pt;
  letter-spacing: 0.06em;
  vertical-align: middle;
}

.feasibility-row.active   .feasibility-text { font-weight: bold; }
.feasibility-row.inactive .feasibility-text { font-weight: normal; }

/* ── Risk indicator cards ── */
.risk-grid {
  display: block;
  overflow: hidden;
  margin-bottom: 4mm;
  clear: both;
}

.risk-card {
  float: left;
  width: 58mm;
  margin-right: 3mm;
  border-radius: 2px;
  overflow: hidden;
  break-inside: avoid;
  page-break-inside: avoid;
}

.risk-card:last-child { margin-right: 0; }

.risk-card-accent { height: 3px; display: block; }

.risk-card-body { padding: 3mm 3.5mm; }

.risk-card-aspect {
  font-size: 6.5pt;
  font-weight: bold;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  display: block;
  margin-bottom: 2mm;
}

.risk-badge {
  display: inline-block;
  padding: 1mm 3mm;
  border-radius: 2px;
  font-size: 7pt;
  font-weight: bold;
  color: #ffffff;
  letter-spacing: 0.06em;
  margin-bottom: 2mm;
}

.risk-note { font-size: 7pt; line-height: 1.45; display: block; }

.risk-high .risk-card-accent  { background: #8b2500; }
.risk-high .risk-card-body    { background: #fff3f0; }
.risk-high .risk-card-aspect  { color: #8b2500; }
.risk-high .risk-badge        { background: #8b2500; }
.risk-high .risk-note         { color: #6b3028; }

.risk-moderate .risk-card-accent { background: #8a6800; }
.risk-moderate .risk-card-body   { background: #fffbee; }
.risk-moderate .risk-card-aspect { color: #8a6800; }
.risk-moderate .risk-badge       { background: #8a6800; }
.risk-moderate .risk-note        { color: #6b5420; }

.risk-low .risk-card-accent  { background: #2e7d52; }
.risk-low .risk-card-body    { background: #f2faf5; }
.risk-low .risk-card-aspect  { color: #2e7d52; }
.risk-low .risk-badge        { background: #2e7d52; }
.risk-low .risk-note         { color: #245c3c; }

/* ── Score table ── */
.score-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 9pt;
  margin-bottom: 4mm;
}

.score-table th {
  background: #17263c;
  color: #b4965a;
  font-size: 7pt;
  font-weight: bold;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 2.5mm 4mm;
  text-align: left;
}

.score-table td {
  padding: 2.5mm 4mm;
  border-bottom: 0.5px solid #ddd6c8;
  vertical-align: top;
}

.score-table tr:nth-child(odd) td  { background: #f5f3ee; }
.score-table tr:nth-child(even) td { background: #ffffff; }
.score-table tr:last-child td      { border-bottom: 1.5px solid #b4965a; }

.score-pill {
  display: inline-block;
  padding: 0.5mm 3mm;
  border-radius: 2px;
  font-size: 7.5pt;
  font-weight: bold;
  color: #ffffff;
}

.score-pill.high     { background: #8b2500; }
.score-pill.moderate { background: #8a6800; }
.score-pill.low      { background: #2e7d52; }
.score-pill.na       { background: #7a8a9a; }

/* ── Considerations ── */
.consideration {
  break-inside: avoid;
  page-break-inside: avoid;
  margin-bottom: 4mm;
  padding-bottom: 4mm;
  border-bottom: 0.5px solid #ddd6c8;
  display: block;
}

.consideration:last-child { border-bottom: none; margin-bottom: 0; }

.consideration-number {
  font-size: 7pt;
  color: #b4965a;
  letter-spacing: 0.1em;
  font-weight: bold;
  display: block;
  margin-bottom: 0.5mm;
}

.consideration-title {
  font-size: 10pt;
  font-weight: bold;
  color: #17263c;
  display: block;
  margin-bottom: 1.5mm;
}

.consideration-body {
  font-size: 9pt;
  color: #2c2c2c;
  line-height: 1.6;
  text-align: justify;
  display: block;
}

/* ── Recommendation box ── */
.recommendation-box {
  background: #f5f3ee;
  border-left: 3px solid #b4965a;
  padding: 5mm 6mm;
  display: block;
  margin-bottom: 4mm;
  break-inside: avoid;
  page-break-inside: avoid;
}

.recommendation-text {
  font-size: 9.5pt;
  color: #2c2c2c;
  line-height: 1.65;
  text-align: justify;
  display: block;
}

/* ── Disclaimer ── */
.disclaimer-box {
  background: #f5f3ee;
  border: 0.5px solid #ddd6c8;
  padding: 4mm 5mm;
  display: block;
}

.disclaimer-text {
  font-size: 7.5pt;
  color: #7a8070;
  line-height: 1.55;
  font-style: italic;
  text-align: justify;
  display: block;
}

/* ── Signature block ── */
.sig-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 5mm;
}

.sig-table td {
  width: 33.33%;
  padding: 2.5mm 4mm;
  border: 0.5px solid #ddd6c8;
}

.sig-table .sig-header td {
  background: #f5f3ee;
  font-size: 6.5pt;
  color: #9a9088;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  border-bottom: 1px solid #b4965a;
}

.sig-table .sig-values td {
  background: #ffffff;
  font-size: 8.5pt;
  font-weight: bold;
  color: #17263c;
}

.sig-table .sig-values .gold-text { color: #b4965a; }

/* ── Utility ── */
.clearfix::after { content: ''; display: table; clear: both; }
.gold-text  { color: #b4965a; }
.navy-text  { color: #17263c; }
.muted-text { color: #9a9088; }

</style>
</head>
<body>


<!-- ═══════════════════════════════════════════════════════
     PAGE 1 — COVER
═══════════════════════════════════════════════════════ -->
<div class="page cover">

  <div class="cover-inner">
    <div class="cover-header">
      <span class="cover-brand">FairVia™</span>
      <span class="cover-service">Technical Advisory Services &nbsp;|&nbsp; Il Nautico Co., Ltd.</span>
    </div>
    <div class="cover-gold-rule"></div>

    <div class="cover-main">
      <span class="cover-report-type">Material Feasibility Screening Report</span>
      <span class="cover-title">Material &amp; Processing<br>Feasibility Screening</span>
      <span class="cover-subtitle">Material Transition Decision Brief</span>
      <span class="cover-divider"></span>

      <div class="cover-client-box">
        <span class="cover-client-label">Prepared for</span>
        <span class="cover-client-name">{{client_name}}</span>
        <span class="cover-client-detail"><strong>Company:</strong> {{client_company}}</span>
        <span class="cover-client-detail"><strong>Country:</strong> {{client_country}}</span>
      </div>

      <div class="cover-meta-grid">
        <div class="cover-meta-row">
          <span class="cover-meta-label">Report No.</span>
          <span class="cover-meta-value">{{report_id}}</span>
        </div>
        <div class="cover-meta-row">
          <span class="cover-meta-label">Date Issued</span>
          <span class="cover-meta-value">{{report_date}}</span>
        </div>
        <div class="cover-meta-row">
          <span class="cover-meta-label">Document Type</span>
          <span class="cover-meta-value">Preliminary Screening — Strategic Advisory</span>
        </div>
        <div class="cover-meta-row">
          <span class="cover-meta-label">Classification</span>
          <span class="cover-meta-value">Strictly Confidential</span>
        </div>
      </div>
    </div>

    <div class="cover-badge-area">
      <span class="cover-badge-label">Overall Feasibility Assessment</span>
      <span class="cover-badge {{feasibility_class}}">&#11044;&nbsp; {{feasibility_level}}</span>
    </div>
  </div><!-- /cover-inner -->

  <div class="cover-footer">
    <span class="cover-footer-left">© Il Nautico Co., Ltd. — FairVia™ Technical Advisory</span>
    <span class="cover-footer-right">Page 1</span>
  </div>

</div>


<!-- ═══════════════════════════════════════════════════════
     PAGE 2 — CLIENT INFORMATION + EXECUTIVE SUMMARY
═══════════════════════════════════════════════════════ -->
<div class="page content">

    <div class="page-header">
      <span class="page-header-left">FairVia™ &nbsp;|&nbsp; Technical Advisory Services</span>
      <span class="page-header-right">Strictly Confidential</span>
    </div>
    <div class="page-header-gold"></div>

    <div class="page-body">

      <div class="section">
        <span class="section-label">Section 1</span>
        <span class="section-title">Client Information &amp; Application Overview</span>
        <div class="section-rule-full"></div>
        <table class="info-table">
          <tr><td>Application</td>          <td>{{application}}</td></tr>
          <tr><td>Current Material</td>     <td>{{current_material}}</td></tr>
          <tr><td>Processing Method</td>    <td>{{processing_method}}</td></tr>
          <tr><td>Target Material</td>      <td>{{bio_material}}</td></tr>
          <tr><td>Processing Equipment</td> <td>{{equipment}}</td></tr>
          <tr><td>Production Scale</td>     <td>{{production_scale}}</td></tr>
          <tr><td>Project Objective</td>    <td>{{project_stage}}</td></tr>
          <tr><td>Submission Reference</td> <td>{{submission_reference}}</td></tr>
        </table>
      </div>

      <div class="section">
        <span class="section-label">Section 2</span>
        <span class="section-title">Executive Summary</span>
        <div class="section-rule-full"></div>
        <div class="summary-block">
          <span class="summary-heading">Overview</span>
          <p class="body-text">{{executive_summary_overview}}</p>
        </div>
        <div class="summary-block">
          <span class="summary-heading">Key Findings</span>
          <p class="body-text">{{executive_summary_findings}}</p>
        </div>
        <div class="summary-block">
          <span class="summary-heading">Assessment Conclusion</span>
          <p class="body-text">{{executive_summary_conclusion}}</p>
        </div>
      </div>

      <div class="section">
        <span class="section-label">Section 3</span>
        <span class="section-title">Feasibility Level</span>
        <div class="section-rule-full"></div>
        <div class="feasibility-scale">
          <span class="feasibility-scale-label">Feasibility Level</span>
          <div class="feasibility-row inactive">
            <span class="feasibility-dot"></span>
            <span class="feasibility-text">LOW</span>
          </div>
          <div class="feasibility-row active">
            <span class="feasibility-dot"></span>
            <span class="feasibility-text">{{feasibility_level}}</span>
          </div>
          <div class="feasibility-row inactive">
            <span class="feasibility-dot"></span>
            <span class="feasibility-text">HIGH</span>
          </div>
        </div>
        <p class="body-text">{{feasibility_explanation}}</p>
      </div>

    </div><!-- /page-body -->

  <div class="page-footer">
    <div class="page-footer-gold"></div>
    <div class="page-footer-inner">
      <span class="page-footer-left">© Il Nautico Co., Ltd. — FairVia™ Technical Advisory &nbsp;|&nbsp; {{report_id}}</span>
      <span class="page-footer-right">Page 2</span>
    </div>
  </div>

</div>


<!-- ═══════════════════════════════════════════════════════
     PAGE 3 — RISK INDICATOR + SCORE TABLE
═══════════════════════════════════════════════════════ -->
<div class="page content">

    <div class="page-header">
      <span class="page-header-left">FairVia™ &nbsp;|&nbsp; Technical Advisory Services</span>
      <span class="page-header-right">Strictly Confidential</span>
    </div>
    <div class="page-header-gold"></div>

    <div class="page-body">

      <div class="section">
        <span class="section-label">Technical Risk Indicator</span>
        <span class="section-title">Risk Profile Summary</span>
        <div class="section-rule-full"></div>
        <div class="risk-grid clearfix">
          <div class="risk-card {{thermal_risk_class}}">
            <span class="risk-card-accent"></span>
            <div class="risk-card-body">
              <span class="risk-card-aspect">Thermal Stability</span>
              <span class="risk-badge">{{thermal_risk}}</span>
              <span class="risk-note">{{thermal_note}}</span>
            </div>
          </div>
          <div class="risk-card {{processing_risk_class}}">
            <span class="risk-card-accent"></span>
            <div class="risk-card-body">
              <span class="risk-card-aspect">Processing Behaviour</span>
              <span class="risk-badge">{{processing_risk}}</span>
              <span class="risk-note">{{processing_note}}</span>
            </div>
          </div>
          <div class="risk-card {{equipment_risk_class}}">
            <span class="risk-card-accent"></span>
            <div class="risk-card-body">
              <span class="risk-card-aspect">Equipment Compatibility</span>
              <span class="risk-badge">{{equipment_risk}}</span>
              <span class="risk-note">{{equipment_note}}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="section">
        <span class="section-label">Section 4</span>
        <span class="section-title">Risk Band &amp; Score Summary</span>
        <div class="section-rule-full"></div>
        <table class="score-table">
          <thead>
            <tr>
              <th>Evaluation Area</th>
              <th>Assessment</th>
              <th>Risk Level</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Thermal Stability</td>
              <td>{{score_thermal_assessment}}</td>
              <td><span class="score-pill {{score_thermal_class}}">{{score_thermal_level}}</span></td>
              <td>{{score_thermal_note}}</td>
            </tr>
            <tr>
              <td>Processing Behaviour</td>
              <td>{{score_processing_assessment}}</td>
              <td><span class="score-pill {{score_processing_class}}">{{score_processing_level}}</span></td>
              <td>{{score_processing_note}}</td>
            </tr>
            <tr>
              <td>Equipment Compatibility</td>
              <td>{{score_equipment_assessment}}</td>
              <td><span class="score-pill {{score_equipment_class}}">{{score_equipment_level}}</span></td>
              <td>{{score_equipment_note}}</td>
            </tr>
            <tr>
              <td>Material Certification</td>
              <td>{{score_cert_assessment}}</td>
              <td><span class="score-pill {{score_cert_class}}">{{score_cert_level}}</span></td>
              <td>{{score_cert_note}}</td>
            </tr>
            <tr>
              <td>End-of-Life Compliance</td>
              <td>{{score_eol_assessment}}</td>
              <td><span class="score-pill {{score_eol_class}}">{{score_eol_level}}</span></td>
              <td>{{score_eol_note}}</td>
            </tr>
          </tbody>
        </table>
      </div>

    </div><!-- /page-body -->

  <div class="page-footer">
    <div class="page-footer-gold"></div>
    <div class="page-footer-inner">
      <span class="page-footer-left">© Il Nautico Co., Ltd. — FairVia™ Technical Advisory &nbsp;|&nbsp; {{report_id}}</span>
      <span class="page-footer-right">Page 3</span>
    </div>
  </div>

</div>


<!-- ═══════════════════════════════════════════════════════
     PAGE 4 — TECHNICAL OBSERVATIONS + POTENTIAL RISKS
═══════════════════════════════════════════════════════ -->
<div class="page content">

    <div class="page-header">
      <span class="page-header-left">FairVia™ &nbsp;|&nbsp; Technical Advisory Services</span>
      <span class="page-header-right">Strictly Confidential</span>
    </div>
    <div class="page-header-gold"></div>

    <div class="page-body">

      <div class="section">
        <span class="section-label">Section 5</span>
        <span class="section-title">Key Technical Observations</span>
        <div class="section-rule-full"></div>
        <div class="consideration">
          <span class="consideration-number">01</span>
          <span class="consideration-title">{{obs_1_title}}</span>
          <span class="consideration-body">{{obs_1_body}}</span>
        </div>
        <div class="consideration">
          <span class="consideration-number">02</span>
          <span class="consideration-title">{{obs_2_title}}</span>
          <span class="consideration-body">{{obs_2_body}}</span>
        </div>
        <div class="consideration">
          <span class="consideration-number">03</span>
          <span class="consideration-title">{{obs_3_title}}</span>
          <span class="consideration-body">{{obs_3_body}}</span>
        </div>
      </div>

      <div class="section">
        <span class="section-label">Section 6</span>
        <span class="section-title">Potential Risks</span>
        <div class="section-rule-full"></div>
        <div class="consideration">
          <span class="consideration-number">Risk 01</span>
          <span class="consideration-title">{{risk_1_title}}</span>
          <span class="consideration-body">{{risk_1_body}}</span>
        </div>
        <div class="consideration">
          <span class="consideration-number">Risk 02</span>
          <span class="consideration-title">{{risk_2_title}}</span>
          <span class="consideration-body">{{risk_2_body}}</span>
        </div>
      </div>

    </div><!-- /page-body -->

  <div class="page-footer">
    <div class="page-footer-gold"></div>
    <div class="page-footer-inner">
      <span class="page-footer-left">© Il Nautico Co., Ltd. — FairVia™ Technical Advisory &nbsp;|&nbsp; {{report_id}}</span>
      <span class="page-footer-right">Page 4</span>
    </div>
  </div>

</div>


<!-- ═══════════════════════════════════════════════════════
     PAGE 5 — RECOMMENDATION + DISCLAIMER
═══════════════════════════════════════════════════════ -->
<div class="page content">

    <div class="page-header">
      <span class="page-header-left">FairVia™ &nbsp;|&nbsp; Technical Advisory Services</span>
      <span class="page-header-right">Strictly Confidential</span>
    </div>
    <div class="page-header-gold"></div>

    <div class="page-body">

      <div class="section">
        <span class="section-label">Section 7</span>
        <span class="section-title">Suggested Next Step</span>
        <div class="section-rule-full"></div>
        <div class="recommendation-box">
          <p class="recommendation-text">{{strategic_recommendation}}</p>
        </div>
      </div>

      <div class="section">
        <span class="section-label">Section 8</span>
        <span class="section-title">Professional Disclaimer</span>
        <div class="section-rule-full"></div>
        <div class="disclaimer-box">
          <p class="disclaimer-text">{{disclaimer}}</p>
        </div>
      </div>

      <table class="sig-table">
        <tr class="sig-header">
          <td>Prepared by</td>
          <td>Report Status</td>
          <td>Date Issued</td>
        </tr>
        <tr class="sig-values">
          <td>FairVia™ Technical Advisory</td>
          <td class="gold-text">Preliminary — For Client Review</td>
          <td>{{report_date}}</td>
        </tr>
      </table>

    </div><!-- /page-body -->

  <div class="page-footer">
    <div class="page-footer-gold"></div>
    <div class="page-footer-inner">
      <span class="page-footer-left">© Il Nautico Co., Ltd. — FairVia™ Technical Advisory &nbsp;|&nbsp; {{report_id}}</span>
      <span class="page-footer-right">Page 5</span>
    </div>
  </div>

</div>


</body>
</html>
`;

// =========================
// メイン
// =========================
app.post("/generate-report", async (req, res) => {
  console.log("🔥 REQUEST HIT");

  try {
    const fields = Array.isArray(req.body)
      ? req.body
      : req.body?.fields || req.body?.data?.fields || [];

    const email =
      fields.find((f) => f.type === "INPUT_EMAIL")?.value ||
      req.body?.email ||
      "";

    const processing = getValue(fields, "processing");
    const currentMaterial = getValue(fields, "material");
    const bioMaterial = getValue(fields, "biodegradable");

    const clientName = getValue(fields, "client name");
    const company = getValue(fields, "company name");
    const country = getValue(fields, "country");
    const equipment = getValue(fields, "equipment");
    const productionScale = getValue(fields, "production");
    const projectStage = getValue(fields, "project");
    const submissionReference = "Auto-generated";

    const text = [
      processing,
      currentMaterial,
      bioMaterial,
      projectStage
    ].join(" ").toLowerCase();

    // =========================
    // 判定（確定ロジック）
    // =========================
    const isInjection = text.includes("injection");
    const isPP = text.includes("pp");
    const isBio = text.includes("pla") || text.includes("bio");

    let finalFeasibility = "MODERATE";

    if (isInjection && isPP && isBio) {
      finalFeasibility = "LOW";
    }

    console.log("RESULT:", finalFeasibility);

    // =========================
    // Riskロジック
    // =========================
    const isLow = finalFeasibility === "LOW";

    const thermalRisk = isLow ? "HIGH RISK" : "MODERATE";
    const thermalNote = isLow
      ? "Thermal behaviour requires careful validation under controlled conditions prior to implementation."
      : "Thermal behaviour should be validated under controlled conditions prior to implementation.";

    const processingRisk = isLow ? "HIGH RISK" : "MODERATE";
    const processingNote = isLow
      ? "Processing stability risk is elevated under the proposed transition scenario and should be carefully validated."
      : "Processing stability remains subject to confirmation through pilot evaluation.";

    const equipmentRisk = isLow ? "HIGH RISK" : "MODERATE";
    const equipmentNote = isLow
      ? "Existing equipment may require adjustment before stable conversion can be reliably achieved."
      : "Equipment suitability should be confirmed prior to any production commitment.";

    // =========================
    // Score
    // =========================
    const scoreThermalAssessment = isLow
      ? "Critical review required"
      : "Conditional review required";
    const scoreThermalLevel = isLow ? "HIGH RISK" : "MODERATE";
    const scoreThermalNote = isLow
      ? "Thermal mismatch may materially affect process stability."
      : "Thermal response remains dependent on confirmed process conditions.";

    const scoreProcessingAssessment = isLow
      ? "High transition sensitivity"
      : "Moderate transition sensitivity";
    const scoreProcessingLevel = isLow ? "HIGH RISK" : "MODERATE";
    const scoreProcessingNote = isLow
      ? "Process consistency may deteriorate under current assumptions."
      : "Process consistency remains to be confirmed in controlled validation.";

    const scoreEquipmentAssessment = isLow
      ? "Compatibility gap likely"
      : "Compatibility to be confirmed";
    const scoreEquipmentLevel = isLow ? "HIGH RISK" : "MODERATE";
    const scoreEquipmentNote = isLow
      ? "Equipment readiness may be insufficient without adjustment."
      : "Equipment capability should be reviewed before scale-up.";

    const html = injectHtml(htmlTemplate, {
      client_name: clientName || "",
      client_company: company || "",
      client_country: country || "",

      application: processing || "",
      current_material: currentMaterial || "",
      processing_method: processing || "",
      bio_material: bioMaterial || "",
      equipment: equipment || "",
      production_scale: productionScale || "",
      project_stage: projectStage || "",
      submission_reference: submissionReference,

      feasibility_level: finalFeasibility,
      FEASIBILITY_LEVEL: finalFeasibility,
　　　　score_cert_assessment: "To be confirmed",
　　　　score_cert_level: "MODERATE",
　　　　score_cert_note: "Material certification status should be verified prior to implementation.",

score_eol_assessment: "To be confirmed",
score_eol_level: "MODERATE",
score_eol_note: "End-of-life compliance should be evaluated based on regional regulatory requirements.",
      report_date: new Date().toISOString().split("T")[0],
      report_id: "FV-" + Date.now(),

      executive_summary_overview: SUMMARY_OVERVIEW,
      executive_summary_findings: SUMMARY_FINDINGS,
      executive_summary_conclusion: SUMMARY_CONCLUSION,

      feasibility_explanation: FEASIBILITY_EXPLANATION,

      thermal_risk: thermalRisk,
      thermal_note: thermalNote,
      processing_risk: processingRisk,
      processing_note: processingNote,
      equipment_risk: equipmentRisk,
      equipment_note: equipmentNote,

      score_thermal_assessment: scoreThermalAssessment,
      score_thermal_level: scoreThermalLevel,
      score_thermal_note: scoreThermalNote,

      score_processing_assessment: scoreProcessingAssessment,
      score_processing_level: scoreProcessingLevel,
      score_processing_note: scoreProcessingNote,

      score_equipment_assessment: scoreEquipmentAssessment,
      score_equipment_level: scoreEquipmentLevel,
      score_equipment_note: scoreEquipmentNote,

      obs_1_title: OBS_1_TITLE,
      obs_1_body: OBS_1_BODY,
      obs_2_title: OBS_2_TITLE,
      obs_2_body: OBS_2_BODY,
      obs_3_title: OBS_3_TITLE,
      obs_3_body: OBS_3_BODY,

      risk_1_title: RISK_1_TITLE,
      risk_1_body: RISK_1_BODY,
      risk_2_title: RISK_2_TITLE,
      risk_2_body: RISK_2_BODY,

      strategic_recommendation: STRATEGIC_RECOMMENDATION,
      disclaimer: DISCLAIMER
    });

    const browser = await puppeteer.launch({
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ]
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true
    });

    await browser.close();

    if (!email) {
      console.log("⚠️ NO EMAIL");
      return res.json({ success: false });
    }

    await resend.emails.send({
      from: "FairVia <info@ilnautico.com>",
      to: email,
      subject: "FairVia Report",
      html: `<p>Your report result: <b>${finalFeasibility}</b></p>`,
      attachments: [
        {
          filename: "report.pdf",
          content: pdf.toString("base64"),
          encoding: "base64"
        }
      ]
    });

    console.log("✅ MAIL SENT");

    res.json({ success: true });

  } catch (err) {
    console.error("❌ ERROR:", err);
    res.status(500).json({ error: "Server Error" });
  }
});

app.post("/generate-tier2", async (req, res) => {
  try {
    console.log("🔥 TIER2 REQUEST HIT");

    const fields =req.body.answers
    ? mapTallyToFields(req.body.answers)
    : req.body.data?.fields || [];

    const application = getValue(fields, "application");
    const currentMaterial = getValue(fields, "material");
    const bioMaterial = getValue(fields, "biodegradable");
    const processing = getValue(fields, "processing");
    const equipment = getValue(fields, "equipment");
    const productionScale = getValue(fields, "production");
    const projectStage = getValue(fields, "project");
    const technicalConcern = getValue(fields, "concern");

    const claudeReport = await generateClaudeHypothesis({
      application,
      material: currentMaterial,
      bioMaterial,
      processing,
      equipment,
      scale: productionScale,
      stage: projectStage,
      concern: technicalConcern
    });

    console.log("✅ CLAUDE GENERATED");

    res.json({
      success: true,
      report: claudeReport
    });

  } catch (err) {
    console.error("❌ TIER2 ERROR:", err);
    res.status(500).json({ error: "Tier2 generation failed" });
  }
});
app.get("/generate-pdf", async (req, res) => {
  try {
    res.send("PDF route working");
  } catch (err) {
    res.status(500).send("error");
  }
});
app.listen(8080, () => {
  console.log("🚀 Server running");
});

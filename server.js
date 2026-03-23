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

function normalizeValue(v) {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return v.label || v.value || "";
  return "";
}

function getValue(fields, keyword) {
  const f = fields.find(f =>
    (f.label || "").toLowerCase().includes(keyword) ||
    (f.key || "").toLowerCase().includes(keyword)
  );
  return normalizeValue(f?.value).trim();
}

function injectHtml(template, data) {
  let html = template;
  Object.keys(data).forEach(key => {
    html = html.replace(
      new RegExp(`{{\\s*${key}\\s*}}`, "g"),
      escapeHtml(String(data[key] || ""))
    );
  });
  return html.replace(/{{.*?}}/g, "");
}

/* =========================
   MAIN
========================= */

app.post("/generate-report", async (req, res) => {
  try {

    const fields = req.body?.data?.fields || [];

    const email = normalizeValue(
      fields.find(f => f.type === "INPUT_EMAIL")?.value
    );

    if (!email) {
      return res.status(400).json({ error: "EMAIL NOT FOUND" });
    }

    /* ===== 入力 ===== */

    const processing = getValue(fields, "processing");
    const currentMaterial = getValue(fields, "material");
    const bioMaterial = getValue(fields, "target");
    const equipment = getValue(fields, "equipment");
    const productionScale = getValue(fields, "production");
    const projectStage = getValue(fields, "project");

    /* =========================
       GPT 完全版
    ========================= */

    let parsed = null;

    const prompt = `You are a senior polymer processing consultant writing a paid technical screening report.

CRITICAL RULES:
- You MUST always give a technical judgment
- NEVER say "insufficient data"
- NEVER stop analysis

STRICT DATA RULE:
- DO NOT assume temperature, viscosity, extrusion issues
- ONLY use given inputs
- If missing → use material-level reasoning

MANDATORY DECISION LOGIC:
If data is incomplete:
- Assume screening-level behavior
- Identify most likely constraint
- Give conditional feasibility

You must write like:
"At screening level, no fundamental incompatibility is identified, however..."

STRUCTURE:

1. Executive Summary
- verdict
- constraint
- action

2. Observations (3)
- cause → mechanism → impact

3. Risks (2)
- cause → mechanism → production impact

4. Feasibility
- LOW / MODERATE / HIGH


INPUT:
Processing: ${processing || "unknown"}
Material: ${currentMaterial || "unknown"}
Target: ${bioMaterial || "unknown"}
Equipment: ${equipment || "unknown"}
Scale: ${productionScale || "unknown"}
Stage: ${projectStage || "unknown"}

Return JSON:
{
"summary":"...",
"findings":"...",
"conclusion":"...",
"feasibility":"...",
"observations":[
{"title":"...","body":"..."},
{"title":"...","body":"..."},
{"title":"...","body":"..."}
],
"risks":[
{"title":"...","body":"..."},
{"title":"...","body":"..."}
]
}
`;

    try {
      const ai = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "polymer expert" },
          { role: "user", content: prompt }
        ]
      });

      parsed = JSON.parse(ai.choices[0].message.content);

    } catch (e) {
      console.error("AI ERROR:", e);
    }

    if (!parsed) {
      parsed = {
        summary:
          "At screening level, no fundamental incompatibility is identified, however validation is required.",
        findings:
          "Material behavior must be confirmed through controlled testing.",
        conclusion:
          "Proceed to pilot validation.",
        feasibility: "MODERATE",
        observations: [],
        risks: []
      };
    }

const obs = parsed.observations || [];
const risks = parsed.risks || [];
    
const company = getValue(fields, "company");
const country = getValue(fields, "country")
    
    const data = {
      application: processing,
      current_material: currentMaterial,
      bio_material: bioMaterial,
      equipment: equipment,
      production_scale: productionScale,
      project_stage: projectStage,

      report_id: "FV-" + Date.now(),
      report_date: new Date().toLocaleDateString(),

　　　　executive_summary_overview: "No fundamental incompatibility is identified at screening level. The primary constraint lies in undefined processing and material conditions, which prevent direct validation of production performance. A controlled pilot evaluation is required before any production-level decision.",
      executive_summary_findings: "Technical feasibility cannot be validated under current conditions due to undefined processing parameters and material specifications. The limitation is operational, not material-related. Compatibility must be confirmed under controlled processing conditions.",
　　　　executive_summary_conclusion: "Transition should not proceed to production at this stage. A structured pilot validation under defined processing conditions is required to confirm compatibility and performance. Production commitment is contingent on successful pilot results.",

      feasibility_level: parsed.feasibility,

      obs_1_body: "Undefined processing conditions introduce variability in material behavior during processing, affecting product consistency and performance.",
      obs_2_body: obs[1]?.body || "",
      obs_3_body: obs[2]?.body || "",

      risk_1_body: risks[0]?.body || "",
      risk_2_body: risks[1]?.body || ""
    };

/* =========================
       HTML（ネイビー最終版）
    ========================= */

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
</html>`;

    const html = injectHtml(htmlTemplate, data);

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
    console.error("SERVER ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(8080, () => console.log("RUNNING"));

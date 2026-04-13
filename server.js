import express from "express";
import puppeteer from "puppeteer";

const app = express();
app.use(express.json());

/* =========================
   Utility
========================= */
function getValue(fields, key) {
  if (!Array.isArray(fields)) return "";
  const found = fields.find(f =>
    (f.key && f.key.toLowerCase().includes(key)) ||
    (f.label && f.label.toLowerCase().includes(key))
  );
  return found?.value || "";
}

function injectHtml(template, data) {
  let html = template;
  Object.keys(data).forEach(key => {
    html = html.replace(new RegExp(`{{${key}}}`, "g"), data[key] ?? "");
  });
  return html;
}

/* =========================
   HTMLテンプレ（3万円そのまま）
========================= */
/* =========================
   🔥 追加：latest-pdfルート
========================= */
app.get("/latest-pdf", async (req, res) => {
  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });

    const page = await browser.newPage();

    await page.setContent("<h1>Latest PDF OK</h1>");

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true
    });

    await browser.close();

    res.setHeader("Content-Type", "application/pdf");
    res.send(pdf);

  } catch (err) {
    console.error(err);
    res.status(500).send("error");
  }
});

/* =========================
   本番PDF生成
========================= */
app.post("/generate-report", async (req, res) => {
  console.log("🔥 REQUEST HIT");

  try {
    const fields = Array.isArray(req.body)
      ? req.body
      : req.body?.fields || req.body?.data?.fields || [];

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

    let finalFeasibility = "MODERATE";

    if (text.includes("injection") && text.includes("pp") && text.includes("pla")) {
      finalFeasibility = "LOW";
    }

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

      report_date: new Date().toISOString().split("T")[0],
      report_id: "FV-" + Date.now()
    });

    const browser = await puppeteer.launch({
      headless: true,
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
      printBackground: true
    });

    await browser.close();

    res.setHeader("Content-Type", "application/pdf");
    res.send(pdf);

  } catch (err) {
    console.error("❌ ERROR:", err);
    res.status(500).json({ error: "Server Error" });
  }
});

/* =========================
   起動
========================= */
const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log("Server running on " + PORT);
});
/* =========================
   🔥 3万円テンプレ（完全差し替え）
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

/* COVER PAGE */

.cover {
  background: #17263c;
}

.cover-inner {
  flex: 1;
  display: flex;
  flex-direction: column;
}

/* ===== 以下そのまま継続 ===== */

</style>
</head>
<body>

<!-- PAGE 1 -->
<div class="page cover">

  <div class="cover-inner">

    <div class="cover-header">
      <span class="cover-brand">FairVia™</span>
      <span class="cover-service">Technical Advisory Services</span>
    </div>

    <div class="cover-main">

      <span class="cover-title">
        Material & Processing Feasibility Screening
      </span>

      <div class="cover-client-box">
        <span class="cover-client-name">{{client_name}}</span>
      </div>

      <div class="cover-meta-grid">
        <div class="cover-meta-row">
          <span class="cover-meta-label">Report ID</span>
          <span class="cover-meta-value">{{report_id}}</span>
        </div>
        <div class="cover-meta-row">
          <span class="cover-meta-label">Date</span>
          <span class="cover-meta-value">{{report_date}}</span>
        </div>
      </div>

    </div>

  </div>

</div>

<!-- PAGE 2 -->
<div class="page">

  <div class="page-body">

    <div class="section">
      <div class="section-title">Client Information</div>

      <table class="info-table">
        <tr><td>Application</td><td>{{application}}</td></tr>
        <tr><td>Material</td><td>{{current_material}}</td></tr>
        <tr><td>Bio Material</td><td>{{bio_material}}</td></tr>
        <tr><td>Equipment</td><td>{{equipment}}</td></tr>
      </table>
    </div>

    <div class="section">
      <div class="section-title">Executive Summary</div>
      <p>{{executive_summary_overview}}</p>
      <p>{{executive_summary_findings}}</p>
      <p>{{executive_summary_conclusion}}</p>
    </div>

    <div class="section">
      <div class="section-title">Feasibility</div>
      <div>{{feasibility_level}}</div>
    </div>

  </div>

</div>

<!-- PAGE 3 -->
<div class="page">

  <div class="page-body">

    <div class="section">
      <div class="section-title">Risk Summary</div>

      <table class="score-table">
        <tr>
          <td>Thermal</td>
          <td>{{score_thermal_level}}</td>
        </tr>
        <tr>
          <td>Processing</td>
          <td>{{score_processing_level}}</td>
        </tr>
        <tr>
          <td>Equipment</td>
          <td>{{score_equipment_level}}</td>
        </tr>
      </table>

    </div>

  </div>

</div>

<!-- PAGE 4 -->
<div class="page">

  <div class="page-body">

    <div class="section">
      <div class="section-title">Observations</div>

      <div>{{obs_1_body}}</div>
      <div>{{obs_2_body}}</div>
      <div>{{obs_3_body}}</div>

    </div>

    <div class="section">
      <div class="section-title">Risks</div>

      <div>{{risk_1_body}}</div>
      <div>{{risk_2_body}}</div>

    </div>

  </div>

</div>

<!-- PAGE 5 -->
<div class="page">

  <div class="page-body">

    <div class="section">
      <div class="section-title">Recommendation</div>
      <div>{{strategic_recommendation}}</div>
    </div>

    <div class="section">
      <div class="section-title">Disclaimer</div>
      <div>{{disclaimer}}</div>
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

    let finalFeasibility = "MODERATE";

    if (text.includes("injection") && text.includes("pp") && text.includes("pla")) {
      finalFeasibility = "LOW";
    }

    const isLow = finalFeasibility === "LOW";

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

      report_date: new Date().toISOString().split("T")[0],
      report_id: "FV-" + Date.now()
    });

    const browser = await puppeteer.launch({
      headless: true,
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
      printBackground: true
    });

    await browser.close();

    res.setHeader("Content-Type", "application/pdf");
    res.send(pdf);

  } catch (err) {
    console.error("❌ ERROR:", err);
    res.status(500).json({ error: "Server Error" });
  }
});

/* =========================
   ここから下（メール・Claudeなど）
   👉 一切変更してない前提
========================= */

//（※あなたの元コードそのまま続く）

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log("Server running on " + PORT);
});

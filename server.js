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
   HTMLテンプレ（5ページ安全版）
========================= */
const htmlTemplate = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
* { margin:0; padding:0; box-sizing:border-box; }

body {
  font-family: Georgia, serif;
  background:#ffffff;
  color:#2c2c2c;
}

.page {
  width: 210mm;
  height: 297mm;
  padding: 20mm;
  page-break-after: always;
}

h1 {
  font-size: 22px;
  margin-bottom: 20px;
  color:#17263c;
}

.section {
  margin-bottom: 15px;
}

.label {
  font-size:12px;
  color:#b4965a;
  text-transform:uppercase;
}

.value {
  font-size:14px;
  margin-bottom:10px;
}

.box {
  border-left:3px solid #b4965a;
  padding-left:10px;
  margin-bottom:10px;
}
</style>
</head>

<body>

<!-- PAGE1 -->
<div class="page">
<h1>FairVia™ Report</h1>
<div class="section"><div class="label">Client</div><div class="value">{{client_name}}</div></div>
<div class="section"><div class="label">Company</div><div class="value">{{client_company}}</div></div>
<div class="section"><div class="label">Country</div><div class="value">{{client_country}}</div></div>
<div class="section"><div class="label">Report ID</div><div class="value">{{report_id}}</div></div>
<div class="section"><div class="label">Date</div><div class="value">{{report_date}}</div></div>
</div>

<!-- PAGE2 -->
<div class="page">
<h1>Application Overview</h1>
<div class="box"><div class="label">Application</div><div class="value">{{application}}</div></div>
<div class="box"><div class="label">Material</div><div class="value">{{current_material}}</div></div>
<div class="box"><div class="label">Bio Material</div><div class="value">{{bio_material}}</div></div>
<div class="box"><div class="label">Equipment</div><div class="value">{{equipment}}</div></div>
</div>

<!-- PAGE3 -->
<div class="page">
<h1>Feasibility</h1>
<div class="section"><div class="label">Level</div><div class="value">{{feasibility_level}}</div></div>
<div class="section"><div class="label">Explanation</div><div class="value">{{feasibility_explanation}}</div></div>
</div>

<!-- PAGE4 -->
<div class="page">
<h1>Observations</h1>
<div class="box">{{obs_1}}</div>
<div class="box">{{obs_2}}</div>
<div class="box">{{obs_3}}</div>
</div>

<!-- PAGE5 -->
<div class="page">
<h1>Recommendation</h1>
<div class="box">{{recommendation}}</div>
<div class="box"><div class="label">Disclaimer</div><div class="value">{{disclaimer}}</div></div>
</div>

</body>
</html>
`;

/* =========================
   API
========================= */
app.post("/generate-report", async (req, res) => {
  try {
    const fields = Array.isArray(req.body)
      ? req.body
      : req.body?.fields || req.body?.data?.fields || [];

    const clientName = getValue(fields, "client name");

    const html = injectHtml(htmlTemplate, {
      client_name: clientName || "Test User",
      client_company: "Test Company",
      client_country: "Japan",
      application: "Film",
      current_material: "PP",
      bio_material: "PLA",
      equipment: "Extruder",

      feasibility_level: "MODERATE",
      feasibility_explanation: "Initial compatibility appears feasible with conditions.",

      obs_1: "Thermal sensitivity observed.",
      obs_2: "Flow variation expected.",
      obs_3: "Equipment tuning required.",

      recommendation: "Pilot test strongly recommended.",
      disclaimer: "This is a preliminary assessment.",

      report_date: new Date().toISOString().split("T")[0],
      report_id: "FV-" + Date.now()
    });

    const browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });

    const page = await browser.newPage();
    await page.setContent(html);

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true
    });

    await browser.close();

    res.setHeader("Content-Type", "application/pdf");
    res.send(pdf);

  } catch (err) {
    console.error(err);
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

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
   HTMLテンプレ（ここだけ1つ）
========================= */
const htmlTemplate = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: Arial; padding:40px; background:#f5f7fa; }
h1 { color:#1a2b4c; margin-bottom:20px; }
.box { background:#fff; padding:20px; border-radius:10px; margin-bottom:20px; }
</style>
</head>
<body>

<h1>FairVia Report</h1>

<div class="box">
<b>Client:</b> {{client_name}}
</div>

<div class="box">
<b>Feasibility:</b> {{feasibility_level}}
</div>

<div class="box">
<b>Date:</b> {{report_date}}<br>
<b>ID:</b> {{report_id}}
</div>

</body>
</html>
`;

/* =========================
   API（簡易）
========================= */
app.post("/generate-ai", (req, res) => {
  try {
    const { material, bio_material } = req.body || {};

    const result =
      "Compatibility: Moderate\n" +
      "Material: " + (material || "N/A") + "\n" +
      "Bio: " + (bio_material || "N/A");

    res.send("<pre>" + result + "</pre>");

  } catch (error) {
    res.status(500).json({ error: "AI generation failed" });
  }
});

/* =========================
   本番PDF
========================= */
app.post("/generate-report", async (req, res) => {
  try {
    const fields = Array.isArray(req.body)
      ? req.body
      : req.body?.fields || req.body?.data?.fields || [];

    const clientName = getValue(fields, "client name");

    let finalFeasibility = "MODERATE";

    const html = injectHtml(htmlTemplate, {
      client_name: clientName || "Unknown",
      feasibility_level: finalFeasibility,
      report_date: new Date().toISOString().split("T")[0],
      report_id: "FV-" + Date.now()
    });

    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox"]
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
   起動（1回だけ）
========================= */
const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log("Server running on " + PORT);
});

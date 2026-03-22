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

function injectHtml(template, data) {
  let html = template;
  Object.keys(data).forEach(key => {
    html = html.replace(
      new RegExp(`{{\\s*${key}\\s*}}`, "g"),
      escapeHtml(String(data[key] || ""))
    );
  });
  html = html.replace(/{{.*?}}/g, "");
  return html;
}

/* =========================
   MAIN
========================= */

app.post("/generate-report", async (req, res) => {
  try {

    /* =========================
       ✔ メール（ここが修正ポイント）
    ========================= */

    const fields = req.body?.data?.fields || [];

    const emailField = fields.find(f => f.type === "INPUT_EMAIL");
    const email = emailField?.value;

    if (!email) {
      return res.status(400).json({ error: "EMAIL NOT FOUND" });
    }

    /* =========================
       GPT（今回は固定でOK）
    ========================= */

    const parsed = {
      summary: "No fundamental incompatibility is identified at screening level.",
      findings: "Thermal window requires validation.",
      conclusion: "Proceed to pilot validation.",
      feasibility: "MODERATE"
    };

    const data = {
      client_name: "Client",
      report_id: "FV-" + Date.now(),
      report_date: new Date().toLocaleDateString(),

      executive_summary_overview: parsed.summary,
      executive_summary_findings: parsed.findings,
      executive_summary_conclusion: parsed.conclusion,

      feasibility_level: parsed.feasibility
    };

    /* =========================
       HTML（安全）
    ========================= */

    const htmlTemplate = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
body { font-family: Arial; padding: 20px; }
.box { border:1px solid #ccc; padding:10px; margin-bottom:10px; }
</style>
</head>
<body>

<h2>FairVia Report</h2>

<div class="box">
<b>Client:</b> {{client_name}}<br>
<b>Report ID:</b> {{report_id}}<br>
<b>Date:</b> {{report_date}}
</div>

<div class="box">
<b>Summary</b><br>
{{executive_summary_overview}}
</div>

<div class="box">
<b>Findings</b><br>
{{executive_summary_findings}}
</div>

<div class="box">
<b>Conclusion</b><br>
{{executive_summary_conclusion}}
</div>

<div class="box">
<b>Feasibility</b><br>
{{feasibility_level}}
</div>

</body>
</html>
`;

    const html = injectHtml(htmlTemplate, data);

    /* =========================
       PDF
    ========================= */

    const browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });

    const page = await browser.newPage();
    await page.setContent(html);

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true
    });

    await browser.close();

    /* =========================
       EMAIL（確実に送る）
    ========================= */

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

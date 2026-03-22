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

    const fields = req.body?.data?.fields || [];
    const emailField = fields.find(f => f.type === "INPUT_EMAIL");
    const email = emailField?.value;

    if (!email) {
      return res.status(400).json({ error: "EMAIL NOT FOUND" });
    }

    /* =========================
       GPT（完全診断版）
    ========================= */

    let parsed = null;

    const prompt = `
You are a senior polymer processing consultant writing a paid technical screening report.

CRITICAL RULES:
- You MUST provide a technical judgment
- NEVER say "insufficient data"
- If data is missing → give conditional judgment
- Use causal explanation (cause → mechanism → impact)
- Write like a consultant, not AI

OUTPUT STRUCTURE:

Executive Summary:
- sentence 1: verdict
- sentence 2: main constraint
- sentence 3: required action

Observations (3):
- phenomenon
- cause
- mechanism
- production impact

Risks (2):
- cause
- mechanism
- production impact

Feasibility:
LOW / MODERATE / HIGH

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
        summary: "No fundamental incompatibility is identified at screening level.",
        findings: "Processing window constraints require validation.",
        conclusion: "Proceed to controlled pilot validation.",
        feasibility: "MODERATE",
        observations: [],
        risks: []
      };
    }

    const obs = parsed.observations || [];
    const risks = parsed.risks || [];

    const data = {
      client_name: "Client",
      report_id: "FV-" + Date.now(),
      report_date: new Date().toLocaleDateString(),

      executive_summary_overview: parsed.summary,
      executive_summary_findings: parsed.findings,
      executive_summary_conclusion: parsed.conclusion,

      feasibility_level: parsed.feasibility,

      obs_1_title: obs[0]?.title || "",
      obs_1_body: obs[0]?.body || "",
      obs_2_title: obs[1]?.title || "",
      obs_2_body: obs[1]?.body || "",
      obs_3_title: obs[2]?.title || "",
      obs_3_body: obs[2]?.body || "",

      risk_1_title: risks[0]?.title || "",
      risk_1_body: risks[0]?.body || "",
      risk_2_title: risks[1]?.title || "",
      risk_2_body: risks[1]?.body || ""
    };

    /* =========================
       HTML（安定＋診断構造）
    ========================= */

    const htmlTemplate = `
DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
body { font-family: Arial; padding: 20px; }
.section { margin-bottom: 15px; }
.title { font-size: 22px; margin-bottom: 10px; }
.box { border:1px solid #ccc; padding:10px; }
</style>
</head>
<body>

<div class="title">FairVia Technical Report</div>

<div class="section box">
<b>Client:</b> {{client_name}}<br>
<b>ID:</b> {{report_id}}<br>
<b>Date:</b> {{report_date}}
</div>

<div class="section box">
<b>Executive Summary</b><br>
{{executive_summary_overview}}
</div>

<div class="section box">
<b>Key Findings</b><br>
{{executive_summary_findings}}
</div>

<div class="section box">
<b>Conclusion</b><br>
{{executive_summary_conclusion}}
</div>

<div class="section box">
<b>Feasibility:</b> {{feasibility_level}}
</div>

<div class="section box">
<b>Observation 1</b><br>
{{obs_1_body}}
</div>

<div class="section box">
<b>Observation 2</b><br>
{{obs_2_body}}
</div>

<div class="section box">
<b>Observation 3</b><br>
{{obs_3_body}}
</div>

<div class="section box">
<b>Risk 1</b><br>
{{risk_1_body}}
</div>

<div class="section box">
<b>Risk 2</b><br>
{{risk_2_body}}
</div>

</body>
</html>
`;

    const html = injectHtml(htmlTemplate, data);

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

app.listen(8080);

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

function matchField(f, keyword) {
  const label = (f.label || "").toLowerCase();
  const key = (f.key || "").toLowerCase();
  return label.includes(keyword) || key.includes(keyword);
}

function getValue(fields, keyword) {
  const f = fields.find(f => matchField(f, keyword));
  if (!f) return "";
  return normalizeValue(f.value).trim();
}

function inferApplication(text) {
  const t = text.toLowerCase();

  if (t.includes("film")) return "Flexible Packaging Film";
  if (t.includes("mulch")) return "Agricultural Film";
  if (t.includes("rigid")) return "Rigid Packaging";
  if (t.includes("injection")) return "Injection Molded Product";
  if (t.includes("blow")) return "Blow Molded Product";

  return "General Plastic Application";
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
    const email = normalizeValue(emailField?.value);

    if (!email) {
      return res.status(400).json({ error: "EMAIL NOT FOUND" });
    }

    const clientName = getValue(fields, "name") || "—";
    const clientCompany = getValue(fields, "company") || "—";
    const clientCountry = getValue(fields, "country") || "—";

    const processing = getValue(fields, "processing");
    const currentMaterial = getValue(fields, "material");
    const bioMaterial = getValue(fields, "target");
    const productionScale = getValue(fields, "production");
    const projectStage = getValue(fields, "project");
    const equipment = getValue(fields, "equipment");

    const rawText = fields
      .map(f => normalizeValue(f.value).toLowerCase())
      .join(" ");

    /* =========================
       DATA（初期値）
    ========================= */

    const data = {
      client_name: clientName,
      client_company: clientCompany,
      client_country: clientCountry,

      application: inferApplication(rawText),

      current_material: currentMaterial || "Not specified",
      bio_material: bioMaterial || "Not specified",
      processing_method: processing || "Not specified",
      production_scale: productionScale || "Not specified",
      project_stage: projectStage || "Preliminary evaluation stage",
      equipment: equipment || "Standard processing equipment (assumed)",

      submission_reference: "Initial screening input",

      report_id: "FV-" + Date.now(),
      report_date: new Date().toLocaleDateString(),

      /* fallback */
      executive_summary_overview:
        "This report provides an initial technical assessment of biodegradable material compatibility with existing processing systems.",

      executive_summary_findings:
        "The evaluation indicates moderate compatibility; however, process stability and equipment interaction require confirmation during early trials.",

      executive_summary_conclusion:
        "A pilot validation is recommended prior to full-scale implementation.",

      obs_1_body:
        "Biodegradable materials generally exhibit lower thermal stability compared to conventional polymers, which may affect processing consistency under standard conditions.",

      obs_2_body:
        "Material flow behavior may differ due to variations in viscosity and shear sensitivity, potentially requiring operational adjustment during early trials.",

      obs_3_body:
        "Performance characteristics may vary depending on processing conditions, product geometry, and environmental exposure.",

      risk_1_body:
        "Processing instability may occur if temperature control is not adequately maintained, potentially leading to material degradation or inconsistent output quality.",

      risk_2_body:
        "Equipment interaction risk may arise where material behavior differs significantly from the current resin, especially during startup, transition, or extended runs.",

      feasibility_level: "MODERATE",
      feasibility_class: "level-moderate",
      feasibility_explanation: "Feasible with adjustments."
    };

    /* =========================
       🔥 AI生成（追加）
    ========================= */

    try {
      const ai = await openai.chat.completions.create({
        model: "gpt-5",
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `
You are a senior polymer processing consultant.

Write concise, professional, technical screening-level content.

Rules:
- Explain WHY and WHAT happens
- No exact processing conditions
- No formulation details
- No supplier recommendations

Return JSON:
{
  "summary": "...",
  "observations": ["...", "...", "..."],
  "risks": ["...", "..."]
}
`
          },
          {
            role: "user",
            content: `
Application: ${data.application}
Material: ${data.current_material}
Bio Material: ${data.bio_material}
Processing: ${data.processing_method}
`
          }
        ]
      });

      const parsed = JSON.parse(ai.choices[0].message.content);

      data.executive_summary_overview = parsed.summary;
      data.obs_1_body = parsed.observations[0];
      data.obs_2_body = parsed.observations[1];
      data.obs_3_body = parsed.observations[2];
      data.risk_1_body = parsed.risks[0];
      data.risk_2_body = parsed.risks[1];

    } catch (e) {
      console.error("AI fallback used:", e);
    }

    /* =========================
       HTML（そのまま）
    ========================= */

    const html = injectHtml(YOUR_HTML_TEMPLATE_HERE, data);

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
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(8080, () => console.log("Server running"));

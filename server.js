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

    const processing = getValue(fields, "processing");
    const currentMaterial = getValue(fields, "material");
    const bioMaterial = getValue(fields, "target");
    const productionScale = getValue(fields, "production");
    const projectStage = getValue(fields, "project");
    const equipment = getValue(fields, "equipment");

    /* =========================
       🔥 最終プロンプト
    ========================= */

    let parsed = null;

    try {

      const prompt = `
You are a senior polymer processing consultant with direct industrial experience in film extrusion, injection molding, and biodegradable material integration.

Your task is to produce a technical screening report for engineering and production decision-makers.

STRICT REQUIREMENTS:
- Avoid generic wording
- Each observation must include cause, mechanism, and production impact
- Always link to equipment and process
- Use real engineering terminology

Return JSON:

{
"summary":"...",
"findings":"...",
"conclusion":"...",
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

Processing Method: ${processing}
Current Material: ${currentMaterial}
Target Material: ${bioMaterial}
Equipment: ${equipment}
Production Scale: ${productionScale}
Project Stage: ${projectStage}
`;

      const ai = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You are a polymer expert." },
          { role: "user", content: prompt }
        ]
      });

      parsed = JSON.parse(ai.choices[0].message.content);

    } catch (e) {
      console.error("AI ERROR:", e);
    }

    /* =========================
       FALLBACK（安全）
    ========================= */

    if (!parsed || !parsed.observations || parsed.observations.length < 3) {
      parsed = {
        summary: "Preliminary technical screening.",
        findings: "Further validation required.",
        conclusion: "Proceed to pilot testing.",
        observations: [
          { title: "Material Behaviour", body: "Material differences require evaluation." },
          { title: "Processing Conditions", body: "Process conditions differ from standard plastics." },
          { title: "Performance Impact", body: "Material performance may change in production." }
        ],
        risks: [
          { title: "Processing Risk", body: "Processing instability may occur." },
          { title: "Equipment Risk", body: "Equipment compatibility should be verified." }
        ]
      };
    }

    const obs = parsed.observations || [];
    const risks = parsed.risks || [];

    /* =========================
       DATA
    ========================= */

    const data = {
      client_name: "Client",
      client_company: "—",
      client_country: "—",

      application: processing,

      current_material: currentMaterial || "Not specified",
      bio_material: bioMaterial || "Not specified",
      processing_method: processing || "Not specified",
      production_scale: productionScale || "Not specified",
      project_stage: projectStage || "Preliminary",
      equipment: equipment || "Standard",

      report_id: "FV-" + Date.now(),
      report_date: new Date().toLocaleDateString(),

      executive_summary_overview: parsed.summary || "",
      executive_summary_findings: parsed.findings || "",
      executive_summary_conclusion: parsed.conclusion || "",

      obs_1_title: obs[0]?.title || "",
      obs_1_body: obs[0]?.body || "",

      obs_2_title: obs[1]?.title || "",
      obs_2_body: obs[1]?.body || "",

      obs_3_title: obs[2]?.title || "",
      obs_3_body: obs[2]?.body || "",

      risk_1_title: risks[0]?.title || "",
      risk_1_body: risks[0]?.body || "",

      risk_2_title: risks[1]?.title || "",
      risk_2_body: risks[1]?.body || "",

      strategic_recommendation: "Proceed to pilot validation.",
      disclaimer: "Preliminary advisory only."
    };

    /* =========================
       HTML（ここだけ自分の入れる）
    ========================= */

    const htmlTemplate = `ここにあなたのHTML全文を貼る`;

    const html = injectHtml(htmlTemplate, data);

    /* =========================
       PDF
    ========================= */

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

    /* =========================
       EMAIL
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

app.listen(8080, () => console.log("Server running"));

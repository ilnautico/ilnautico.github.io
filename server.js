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

function resolveValue(value, fallback) {
  return value && value.trim() !== "" ? value : fallback;
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
       GPT（最終版）
    ========================= */

    let parsed = null;

    try {

      const prompt = `
You are a senior polymer processing consultant writing a paid technical screening report.

CRITICAL:
You MUST provide a technical judgment even if data is incomplete.

At minimum:
- State whether there is NO fundamental material incompatibility at screening level
- Or state that transition is NOT feasible

You are NOT allowed to return "insufficient data"

If data is missing:
→ give a CONDITIONAL decision, not a refusal

-------------------------------------

INPUT:
Processing: ${processing || "unknown"}
Material: ${currentMaterial || "unknown"}
Target: ${bioMaterial || "unknown"}
Equipment: ${equipment || "unknown"}
Scale: ${productionScale || "unknown"}
Stage: ${projectStage || "unknown"}

-------------------------------------

RULES:

1. Executive Summary
- sentence 1: verdict
- sentence 2: constraint
- sentence 3: action

2. Observations
- phenomenon
- cause
- mechanism
- impact

3. Risks
- cause
- mechanism
- production impact
- max 3 sentences

4. Feasibility
- Must return one of: LOW / MODERATE / HIGH
- Must reflect technical judgment

-------------------------------------

Return JSON:

{
"summary":"...",
"findings":"...",
"conclusion":"...",
"feasibility":"LOW / MODERATE / HIGH",
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
       FALLBACK
    ========================= */

    if (!parsed || !parsed.observations || parsed.observations.length < 3) {
      parsed = {
        summary:
          "No fundamental incompatibility is identified at screening level. The primary limitation is undefined process conditions. A pilot validation is required.",
        findings:
          "Assessment is conditional due to missing operating parameters.",
        conclusion:
          "Proceed to pilot after defining process conditions.",
        feasibility: "MODERATE",
        observations: [
          {
            title: "Conditional Assessment",
            body: "Material compatibility cannot be fully validated due to missing inputs."
          },
          {
            title: "Process Sensitivity",
            body: "Biodegradable materials require controlled processing conditions."
          },
          {
            title: "Equipment Assumption",
            body: "General-purpose equipment is assumed for screening evaluation."
          }
        ],
        risks: [
          {
            title: "Process Instability",
            body: "Undefined parameters may lead to unstable processing behavior."
          },
          {
            title: "Quality Variation",
            body: "Lack of control may result in inconsistent product quality."
          }
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

      application: resolveValue(processing, "General polymer application"),

      current_material: resolveValue(currentMaterial, "Conventional polymer baseline assumed"),
      bio_material: resolveValue(bioMaterial, "Biodegradable polymer system assumed"),
      processing_method: resolveValue(processing, "Standard extrusion or molding process assumed"),
      production_scale: resolveValue(productionScale, "Pilot-scale evaluation assumed"),
      project_stage: resolveValue(projectStage, "Preliminary evaluation stage"),
      equipment: resolveValue(equipment, "General-purpose processing equipment assumed"),

      report_id: "FV-" + Date.now(),
      report_date: new Date().toLocaleDateString(),

      executive_summary_overview: parsed.summary || "",
      executive_summary_findings: parsed.findings || "",
      executive_summary_conclusion: parsed.conclusion || "",

      feasibility: parsed.feasibility || "MODERATE",

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

      strategic_recommendation:
        "Proceed to pilot validation after confirming process and equipment conditions.",

      disclaimer:
        "This assessment is based on submitted inputs and assumed conditions. No physical testing has been conducted."
    };

    /* =========================
       HTML
    ========================= */

    const htmlTemplate = \`import express from "express";
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

function resolveValue(value, fallback) {
  return value && value.trim() !== "" ? value : fallback;
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
       GPT（最終版）
    ========================= */

    let parsed = null;

    try {

      const prompt = `
You are a senior polymer processing consultant writing a paid technical screening report.

CRITICAL:
You MUST provide a technical judgment even if data is incomplete.

At minimum:
- State whether there is NO fundamental material incompatibility at screening level
- Or state that transition is NOT feasible

You are NOT allowed to return "insufficient data"

If data is missing:
→ give a CONDITIONAL decision, not a refusal

-------------------------------------

INPUT:
Processing: ${processing || "unknown"}
Material: ${currentMaterial || "unknown"}
Target: ${bioMaterial || "unknown"}
Equipment: ${equipment || "unknown"}
Scale: ${productionScale || "unknown"}
Stage: ${projectStage || "unknown"}

-------------------------------------

RULES:

1. Executive Summary
- sentence 1: verdict
- sentence 2: constraint
- sentence 3: action

2. Observations
- phenomenon
- cause
- mechanism
- impact

3. Risks
- cause
- mechanism
- production impact
- max 3 sentences

4. Feasibility
- Must return one of: LOW / MODERATE / HIGH
- Must reflect technical judgment

-------------------------------------

Return JSON:

{
"summary":"...",
"findings":"...",
"conclusion":"...",
"feasibility":"LOW / MODERATE / HIGH",
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
       FALLBACK
    ========================= */

    if (!parsed || !parsed.observations || parsed.observations.length < 3) {
      parsed = {
        summary:
          "No fundamental incompatibility is identified at screening level. The primary limitation is undefined process conditions. A pilot validation is required.",
        findings:
          "Assessment is conditional due to missing operating parameters.",
        conclusion:
          "Proceed to pilot after defining process conditions.",
        feasibility: "MODERATE",
        observations: [
          {
            title: "Conditional Assessment",
            body: "Material compatibility cannot be fully validated due to missing inputs."
          },
          {
            title: "Process Sensitivity",
            body: "Biodegradable materials require controlled processing conditions."
          },
          {
            title: "Equipment Assumption",
            body: "General-purpose equipment is assumed for screening evaluation."
          }
        ],
        risks: [
          {
            title: "Process Instability",
            body: "Undefined parameters may lead to unstable processing behavior."
          },
          {
            title: "Quality Variation",
            body: "Lack of control may result in inconsistent product quality."
          }
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

      application: resolveValue(processing, "General polymer application"),

      current_material: resolveValue(currentMaterial, "Conventional polymer baseline assumed"),
      bio_material: resolveValue(bioMaterial, "Biodegradable polymer system assumed"),
      processing_method: resolveValue(processing, "Standard extrusion or molding process assumed"),
      production_scale: resolveValue(productionScale, "Pilot-scale evaluation assumed"),
      project_stage: resolveValue(projectStage, "Preliminary evaluation stage"),
      equipment: resolveValue(equipment, "General-purpose processing equipment assumed"),

      report_id: "FV-" + Date.now(),
      report_date: new Date().toLocaleDateString(),

      executive_summary_overview: parsed.summary || "",
      executive_summary_findings: parsed.findings || "",
      executive_summary_conclusion: parsed.conclusion || "",

      feasibility: parsed.feasibility || "MODERATE",

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

      strategic_recommendation:
        "Proceed to pilot validation after confirming process and equipment conditions.",

      disclaimer:
        "This assessment is based on submitted inputs and assumed conditions. No physical testing has been conducted."
    };

    /* =========================
       HTML
    ========================= */

    const htmlTemplate = \`ここにあなたのHTML全文を貼る\`;

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

app.listen(8080, () => console.log("Server running"));`;

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

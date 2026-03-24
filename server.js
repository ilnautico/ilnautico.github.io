import express from "express";
import OpenAI from "openai";
import { Resend } from "resend";
import puppeteer from "puppeteer-core";

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

function getExactValue(fields, labelName) {
  const target = labelName.trim().toLowerCase();
  const f = fields.find(
    f => (f.label || "").trim().toLowerCase() === target
  );
  return normalizeValue(f?.value).trim();
}

function getValue(fields, keyword) {
  const target = keyword.trim().toLowerCase();
  const f = fields.find(f =>
    (f.label || "").toLowerCase().includes(target) ||
    (f.key || "").toLowerCase().includes(target)
  );
  return normalizeValue(f?.value).trim();
}

function injectHtml(template, data) {
  let html = template;
  Object.keys(data).forEach(key => {
    html = html.replace(
      new RegExp(`{{\\s*${key}\\s*}}`, "g"),
      escapeHtml(String(data[key] ?? ""))
    );
  });
  return html.replace(/{{.*?}}/g, "");
}

function safe(v, fallback) {
  return v && String(v).trim() !== "" ? v : fallback;
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

    const processing =
      getValue(fields, "processing") ||
      getValue(fields, "method") ||
      getValue(fields, "process");

    const currentMaterial =
      getValue(fields, "current material") ||
      getValue(fields, "material");

    const bioMaterial =
      getValue(fields, "target") ||
      getValue(fields, "biodegradable") ||
      getValue(fields, "bio");

    const equipment =
      getValue(fields, "equipment") ||
      getValue(fields, "machine");

    const productionScale =
      getValue(fields, "production scale") ||
      getValue(fields, "production") ||
      getValue(fields, "scale");

    const projectStage =
      getValue(fields, "project currently in") ||
      getValue(fields, "project stage") ||
      getValue(fields, "stage");

    const clientName =
      getExactValue(fields, "Client Name") ||
      getValue(fields, "client");

    const company =
      getExactValue(fields, "Company Name") ||
      getValue(fields, "company");

    const country =
      getExactValue(fields, "Country") ||
      getValue(fields, "country");

    /* =========================
       GPT
    ========================= */

    let parsed = null;

    const prompt = `
You are a senior polymer processing consultant writing a short paid technical screening report.

Input:
Processing: ${processing || "unknown"}
Current material: ${currentMaterial || "unknown"}
Target biodegradable material: ${bioMaterial || "unknown"}
Equipment: ${equipment || "unknown"}
Production scale: ${productionScale || "unknown"}
Project stage: ${projectStage || "unknown"}

Rules:
- Always provide a judgment.
- Never say "insufficient data".
- Keep the wording concise and professional.
- Return valid JSON only.

Return JSON:
{
  "summary":"...",
  "findings":"...",
  "conclusion":"...",
  "feasibility":"LOW/MODERATE/HIGH",
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
          { role: "system", content: "You are a polymer processing expert." },
          { role: "user", content: prompt }
        ]
      });

      parsed = JSON.parse(ai.choices[0].message.content);
    } catch (e) {
      console.error("GPT ERROR:", e);
    }

    if (!parsed) {
      parsed = {
        summary:
          "No fundamental incompatibility is identified at screening level. The primary constraint lies in incomplete process definition under current submission conditions.",
        findings:
          "Technical feasibility cannot be fully validated until material, equipment, and processing conditions are confirmed under controlled evaluation.",
        conclusion:
          "A controlled pilot validation is required before any production-level decision.",
        feasibility: "MODERATE",
        observations: [],
        risks: []
      };
    }

    /* =========================
       判定ロジック
    ========================= */

    let finalFeasibility = (parsed.feasibility || "MODERATE").toUpperCase();

    const riskKeywords = [
      processing,
      currentMaterial,
      bioMaterial,
      projectStage
    ].join(" ").toLowerCase();

    const isInjection = riskKeywords.includes("injection");
    const isPP =
      riskKeywords.includes("pp") ||
      riskKeywords.includes("polypropylene");
    const isBio =
      riskKeywords.includes("pla") ||
      riskKeywords.includes("pla-based") ||
      riskKeywords.includes("biodegradable");

    if (isInjection && isPP && isBio) {
      finalFeasibility = "LOW";
    }

    const isHighRisk = finalFeasibility === "LOW";

    if (isHighRisk) {
      parsed.summary =
        "At screening level, a significant compatibility risk is identified between the current processing system and the proposed biodegradable material transition.";

      parsed.findings =
        "Material substitution introduces high instability risk in production, particularly in thermal behaviour, flow consistency, and process reliability under existing conversion conditions.";

      parsed.conclusion =
        "Production transition is not recommended without pilot validation and controlled process adjustment.";
    }

    const obs = parsed.observations || [];
    const risks = parsed.risks || [];

    const feasibilityClass =
      finalFeasibility === "LOW"
        ? "level-high"
        : finalFeasibility === "MODERATE"
        ? "level-moderate"
        : "level-low";

    const riskCardClass =
      finalFeasibility === "LOW"
        ? "risk-high"
        : finalFeasibility === "MODERATE"
        ? "risk-moderate"
        : "risk-low";

    const scoreClass =
      finalFeasibility === "LOW"
        ? "high"
        : finalFeasibility === "MODERATE"
        ? "moderate"
        : "low";

    const riskLabel =
      finalFeasibility === "LOW"
        ? "HIGH RISK"
        : finalFeasibility === "MODERATE"
        ? "MODERATE"
        : "LOW RISK";

    const data = {
      client_name: safe(clientName, "Client"),
      client_company: safe(company, "Not specified"),
      client_country: safe(country, "Not specified"),

      application: safe(processing, "Not specified"),
      current_material: safe(currentMaterial, "Not specified"),
      processing_method: safe(processing, "Not specified"),
      bio_material: safe(bioMaterial, "Not specified"),
      equipment: safe(equipment, "Not specified"),
      production_scale: safe(productionScale, "Not specified"),
      project_stage: safe(projectStage, "Not specified"),
      submission_reference: "Auto Generated",

      report_id: "FV-" + Date.now(),
      report_date: new Date().toLocaleDateString(),

      executive_summary_overview: safe(
        parsed.summary,
        "No fundamental incompatibility is identified at screening level. The primary constraint lies in incomplete process definition under current submission conditions."
      ),
      executive_summary_findings: safe(
        parsed.findings,
        "Technical feasibility cannot be fully validated until material, equipment, and processing conditions are confirmed under controlled evaluation."
      ),
      executive_summary_conclusion: safe(
        parsed.conclusion,
        "A controlled pilot validation is required before any production-level decision."
      ),

      feasibility_level: finalFeasibility,
      feasibility_class: feasibilityClass,
      feasibility_explanation:
        "This assessment reflects screening-level evaluation based on available inputs. Validation under controlled conditions is required.",

      thermal_risk_class: riskCardClass,
      thermal_risk: riskLabel,
      thermal_note:
        finalFeasibility === "LOW"
          ? "Thermal mismatch risk is elevated under the proposed transition scenario."
          : "Thermal behaviour remains subject to confirmation under controlled validation.",

      processing_risk_class: riskCardClass,
      processing_risk: riskLabel,
      processing_note:
        finalFeasibility === "LOW"
          ? "Process stability is likely to deteriorate under existing production settings."
          : "Processing behaviour requires confirmation under pilot conditions.",

      equipment_risk_class: riskCardClass,
      equipment_risk: riskLabel,
      equipment_note:
        finalFeasibility === "LOW"
          ? "Existing equipment may not support stable biodegradable conversion without adjustment."
          : "Equipment suitability should be verified before production commitment.",

      score_thermal_assessment:
        finalFeasibility === "LOW" ? "Critical review required" : "Conditional review required",
      score_thermal_class: scoreClass,
      score_thermal_level: riskLabel,
      score_thermal_note:
        finalFeasibility === "LOW"
          ? "Thermal behaviour may diverge materially from existing polyolefin processing norms."
          : "Thermal evaluation remains dependent on defined process conditions.",

      score_processing_assessment:
        finalFeasibility === "LOW" ? "High transition sensitivity" : "Moderate transition sensitivity",
      score_processing_class: scoreClass,
      score_processing_level: riskLabel,
      score_processing_note:
        finalFeasibility === "LOW"
          ? "Processing behaviour may become unstable under current assumptions."
          : "Process consistency remains unverified at screening stage.",

      score_equipment_assessment:
        finalFeasibility === "LOW" ? "Compatibility gap likely" : "Compatibility to be confirmed",
      score_equipment_class: scoreClass,
      score_equipment_level: riskLabel,
      score_equipment_note:
        finalFeasibility === "LOW"
          ? "Equipment setup may require adjustment before safe transition."
          : "Existing equipment capability has not yet been validated.",

      score_cert_assessment: "Not assessed",
      score_cert_class: "na",
      score_cert_level: "N/A",
      score_cert_note:
        "Certification status was not part of the submitted screening inputs.",

      score_eol_assessment: "Not assessed",
      score_eol_class: "na",
      score_eol_level: "N/A",
      score_eol_note:
        "End-of-life requirements were not defined in the submitted inputs.",

      obs_1_title: safe(obs[0]?.title, "Processing Stability"),
      obs_1_body: safe(
        obs[0]?.body,
        "Processing stability must be validated under controlled conditions."
      ),

      obs_2_title: safe(obs[1]?.title, "Material Compatibility"),
      obs_2_body: safe(
        obs[1]?.body,
        "Material compatibility requires controlled validation."
      ),

      obs_3_title: safe(obs[2]?.title, "Operational Risk"),
      obs_3_body: safe(
        obs[2]?.body,
        "Operational risks must be assessed before scaling."
      ),

      risk_1_title: safe(risks[0]?.title, "Production Instability"),
      risk_1_body: safe(
        risks[0]?.body,
        "Production instability may occur under current conditions."
      ),

      risk_2_title: safe(risks[1]?.title, "Performance Risk"),
      risk_2_body: safe(
        risks[1]?.body,
        "Performance may not meet expected criteria."
      ),

      strategic_recommendation:
        finalFeasibility === "LOW"
          ? "Do not proceed to production under the current configuration. Conduct a structured pilot validation with controlled processing adjustments before any production commitment."
          : "Proceed to controlled pilot validation after confirming material behaviour, processing conditions, and equipment compatibility.",

      disclaimer:
        "This assessment is based on submitted inputs and screening-level technical interpretation only. No physical testing, rheology analysis, or on-site equipment review has been performed."
    };
        /* =========================
       HTML（ここにあなたのHTML全文をそのまま貼る）
    ========================= */

    const htmlTemplate = `
    /* =========================
       HTML（ここにあなたのHTML全文をそのまま貼る）
    ========================= */

    const htmlTemplate = `
ここにあなたのHTML全文をそのまま貼る
`;

    /* =========================
       実行
    ========================= */

    const html = injectHtml(htmlTemplate, data);

    const browser = await puppeteer.launch({
      executablePath:
        process.env.PUPPETEER_EXECUTABLE_PATH ||
        process.env.CHROME_PATH ||
        "/usr/bin/chromium-browser",
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
          content: pdf.toString("base64"),
          encoding: "base64"
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
`;

    /* =========================
       実行
    ========================= */

    const html = injectHtml(htmlTemplate, data);

    const browser = await puppeteer.launch({
      executablePath:
        process.env.PUPPETEER_EXECUTABLE_PATH ||
        process.env.CHROME_PATH ||
        "/usr/bin/chromium-browser",
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
          content: pdf.toString("base64"),
          encoding: "base64"
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

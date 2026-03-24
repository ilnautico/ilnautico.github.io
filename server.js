import express from "express";
import puppeteer from "puppeteer";
import { Resend } from "resend";

const app = express();
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

// =========================
// HTML差し込み
// =========================
function injectHtml(template, data) {
  let html = template;

  Object.keys(data).forEach(key => {
    const regex = new RegExp("\\{\\{\\s*" + key + "\\s*\\}\\}", "g");
    html = html.replace(regex, data[key] || "");
  });

  return html;
}

// =========================
// 値取得（ID→text完全対応）
// =========================
function getValue(fields, keyword) {
  const field = fields.find(f =>
    (f.label || "").toLowerCase().includes(keyword.toLowerCase())
  );

  if (!field) return "";

  if (Array.isArray(field.value) && Array.isArray(field.options)) {
    const selected = field.options.find(opt =>
      field.value.includes(opt.id)
    );
    if (selected?.text) return selected.text.toLowerCase();
  }

  if (typeof field.value === "string") {
    return field.value.toLowerCase();
  }

  return "";
}

// =========================
// あなたのHTMLテンプレそのまま貼る
// =========================
const htmlTemplate = `
import express from "express";
import puppeteer from "puppeteer";
import { Resend } from "resend";

const app = express();
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

// =========================
// HTML差し込み
// =========================
function injectHtml(template, data) {
  let html = template;

  Object.keys(data).forEach(key => {
   const regex = new RegExp("\\{\\{\\s*" + key + "\\s*\\}\\}", "g");
    html = html.replace(regex, data[key] || "");
  });

  return html;
}

// =========================
// 値取得（ID→text完全対応）
// =========================
function getValue(fields, keyword) {
  const field = fields.find(f =>
    (f.label || "").toLowerCase().includes(keyword.toLowerCase())
  );

  if (!field) return "";

  if (Array.isArray(field.value) && Array.isArray(field.options)) {
    const selected = field.options.find(opt =>
      field.value.includes(opt.id)
    );
    if (selected?.text) return selected.text.toLowerCase();
  }

  if (typeof field.value === "string") {
    return field.value.toLowerCase();
  }

  return "";
}

// =========================
// あなたのHTMLテンプレそのまま貼る
// =========================
const htmlTemplate = `
<!-- ここにあなたの5ページHTMLを丸ごと貼る -->
`;

// =========================
// メイン
// =========================
app.post("/generate-report", async (req, res) => {
  console.log("🔥 REQUEST HIT");

  try {
    const fields = req.body?.data?.fields || [];

    const email =
      fields.find(f => f.type === "INPUT_EMAIL")?.value || "";

    const processing = getValue(fields, "processing");
    const currentMaterial = getValue(fields, "material");
    const bioMaterial = getValue(fields, "biodegradable");

    const text = [
      processing,
      currentMaterial,
      bioMaterial
    ].join(" ").toLowerCase();

    const isInjection = text.includes("injection");
    const isPP = text.includes("pp");
    const isBio =
      text.includes("pla") ||
      text.includes("bio");

    let finalFeasibility = "MODERATE";

    if (isInjection && isPP && isBio) {
      finalFeasibility = "LOW";
    }

    console.log("RESULT:", finalFeasibility);

    // =========================
    // 🔥 テンプレ差し込み（完全版）
    // =========================
    const html = injectHtml(htmlTemplate, {
      // 基本
      application: processing,
      current_material: currentMaterial,
      processing_method: processing,
      bio_material: bioMaterial,

      // 判定（両対応）
      feasibility_level: finalFeasibility,
      FEASIBILITY_LEVEL: finalFeasibility,

      // メタ
      report_date: new Date().toISOString().split("T")[0],
      report_id: "FV-" + Date.now(),

      // クライアント（空でOK）
      client_name: "",
      client_company: "",
      client_country: "",

      // その他（空でOK：テンプレ崩れ防止）
      equipment: "",
      production_scale: "",
      project_stage: "",
      submission_reference: "",

      executive_summary_overview: "",
      executive_summary_findings: "",
      executive_summary_conclusion: "",

      feasibility_explanation: "",

      thermal_risk: "",
      thermal_note: "",
      processing_risk: "",
      processing_note: "",
      equipment_risk: "",
      equipment_note: "",

      score_thermal_assessment: "",
      score_thermal_level: "",
      score_thermal_note: "",

      score_processing_assessment: "",
      score_processing_level: "",
      score_processing_note: "",

      score_equipment_assessment: "",
      score_equipment_level: "",
      score_equipment_note: "",

      score_cert_assessment: "",
      score_cert_level: "",
      score_cert_note: "",

      score_eol_assessment: "",
      score_eol_level: "",
      score_eol_note: "",

      obs_1_title: "",
      obs_1_body: "",
      obs_2_title: "",
      obs_2_body: "",
      obs_3_title: "",
      obs_3_body: "",

      risk_1_title: "",
      risk_1_body: "",
      risk_2_title: "",
      risk_2_body: "",

      strategic_recommendation: "",
      disclaimer: ""
    });

    // =========================
    // PDF
    // =========================
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

    // =========================
    // メール
    // =========================
    await resend.emails.send({
      from: "FairVia <info@ilnautico.com>",
      to: email,
      subject: "FairVia Report",
      html: `<p>Your report result: <b>${finalFeasibility}</b></p>`,
      attachments: [
        {
          filename: "report.pdf",
          content: pdf.toString("base64"),
          encoding: "base64"
        }
      ]
    });

    console.log("✅ MAIL SENT");

    res.json({ success: true });

  } catch (err) {
    console.error("❌ ERROR:", err);
    res.status(500).json({ error: "Server Error" });
  }
});

app.listen(8080, () => {
  console.log("🚀 Server running");
});
`;

// =========================
// メイン
// =========================
app.post("/generate-report", async (req, res) => {
  console.log("🔥 REQUEST HIT");

  try {
    const fields = req.body?.data?.fields || [];

    const email =
      fields.find(f => f.type === "INPUT_EMAIL")?.value || "";

    const processing = getValue(fields, "processing");
    const currentMaterial = getValue(fields, "material");
    const bioMaterial = getValue(fields, "biodegradable");

    const text = [
      processing,
      currentMaterial,
      bioMaterial
    ].join(" ").toLowerCase();

    const isInjection = text.includes("injection");
    const isPP = text.includes("pp");
    const isBio =
      text.includes("pla") ||
      text.includes("bio");

    let finalFeasibility = "MODERATE";

    if (isInjection && isPP && isBio) {
      finalFeasibility = "LOW";
    }

    console.log("RESULT:", finalFeasibility);

    // =========================
    // 🔥 テンプレ差し込み（完全版）
    // =========================
    const html = injectHtml(htmlTemplate, {
      // 基本
      application: processing,
      current_material: currentMaterial,
      processing_method: processing,
      bio_material: bioMaterial,

      // 判定（両対応）
      feasibility_level: finalFeasibility,
      FEASIBILITY_LEVEL: finalFeasibility,

      // メタ
      report_date: new Date().toISOString().split("T")[0],
      report_id: "FV-" + Date.now(),

      // クライアント（空でOK）
      client_name: "",
      client_company: "",
      client_country: "",

      // その他（空でOK：テンプレ崩れ防止）
      equipment: "",
      production_scale: "",
      project_stage: "",
      submission_reference: "",

      executive_summary_overview: "",
      executive_summary_findings: "",
      executive_summary_conclusion: "",

      feasibility_explanation: "",

      thermal_risk: "",
      thermal_note: "",
      processing_risk: "",
      processing_note: "",
      equipment_risk: "",
      equipment_note: "",

      score_thermal_assessment: "",
      score_thermal_level: "",
      score_thermal_note: "",

      score_processing_assessment: "",
      score_processing_level: "",
      score_processing_note: "",

      score_equipment_assessment: "",
      score_equipment_level: "",
      score_equipment_note: "",

      score_cert_assessment: "",
      score_cert_level: "",
      score_cert_note: "",

      score_eol_assessment: "",
      score_eol_level: "",
      score_eol_note: "",

      obs_1_title: "",
      obs_1_body: "",
      obs_2_title: "",
      obs_2_body: "",
      obs_3_title: "",
      obs_3_body: "",

      risk_1_title: "",
      risk_1_body: "",
      risk_2_title: "",
      risk_2_body: "",

      strategic_recommendation: "",
      disclaimer: ""
    });

    // =========================
    // PDF
    // =========================
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

    // =========================
    // メール
    // =========================
    await resend.emails.send({
      from: "FairVia <info@ilnautico.com>",
      to: email,
      subject: "FairVia Report",
      html: `<p>Your report result: <b>${finalFeasibility}</b></p>`,
      attachments: [
        {
          filename: "report.pdf",
          content: pdf.toString("base64"),
          encoding: "base64"
        }
      ]
    });

    console.log("✅ MAIL SENT");

    res.json({ success: true });

  } catch (err) {
    console.error("❌ ERROR:", err);
    res.status(500).json({ error: "Server Error" });
  }
});

app.listen(8080, () => {
  console.log("🚀 Server running");
});

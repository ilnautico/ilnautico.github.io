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
   Helpers
========================= */

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeFieldValue(field) {
  if (!field) return "";

  const { value, options } = field;

  if (
    (typeof value === "string" || typeof value === "number") &&
    Array.isArray(options)
  ) {
    const match = options.find((o) => String(o.id) === String(value));
    if (match?.text) return match.text;
  }

  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (Array.isArray(options)) {
      return value
        .map((id) => {
          const m = options.find((o) => String(o.id) === String(id));
          return m?.text || id;
        })
        .join(", ");
    }
    return value.join(", ");
  }

  return "";
}

function getField(fields, keyword) {
  return fields.find((f) =>
    `${f.label} ${f.key}`.toLowerCase().includes(keyword)
  );
}

/* =========================
   MAIN HANDLER
========================= */

const handler = async (req, res) => {
  try {
    const fields = req.body?.data?.fields || [];

    console.log("PAYLOAD:", JSON.stringify(req.body, null, 2));

    const emailField = fields.find((f) => f.type === "INPUT_EMAIL");
    const email = emailField ? normalizeFieldValue(emailField) : "";

    if (!email) {
      return res.status(400).json({ error: "EMAIL NOT FOUND" });
    }

    const application = normalizeFieldValue(getField(fields, "product"));
    const processingMethod = normalizeFieldValue(getField(fields, "processing"));
    const currentMaterial = normalizeFieldValue(getField(fields, "currently"));
    const bioMaterial = normalizeFieldValue(getField(fields, "biodegradable"));
    const equipment = normalizeFieldValue(getField(fields, "equipment"));
    const productionScale = normalizeFieldValue(getField(fields, "scale"));
    const concerns = normalizeFieldValue(getField(fields, "concern"));
    const projectStage = normalizeFieldValue(getField(fields, "stage"));

    console.log("EMAIL:", email);

    // ✅ AI（落ちない版）
    let executiveSummary = "Preliminary screening completed.";

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "user",
            content: `
Summarize this in 1 professional paragraph:

Application: ${application}
Material: ${currentMaterial}
Process: ${processingMethod}
Bio: ${bioMaterial}
Equipment: ${equipment}
Scale: ${productionScale}
Concerns: ${concerns}
Stage: ${projectStage}
`
          }
        ]
      });

      executiveSummary =
        completion?.choices?.[0]?.message?.content || executiveSummary;
    } catch (e) {
      console.log("AI FAILED → fallback");
    }

    // =========================
    // ★ ここにあなたのHTMLそのまま貼る
    // =========================
    const htmlTemplate = `
<<<ここにあなたのHTML全文そのまま貼る>>>
`;

    const data = {
      application,
      processing_method: processingMethod,
      current_material: currentMaterial,
      bio_material: bioMaterial,
      equipment,
      production_scale: productionScale,
      project_stage: projectStage,

      report_id: "FV-" + Date.now(),
      report_date: new Date().toLocaleDateString(),

      executive_summary: executiveSummary
    };

    let html = htmlTemplate;
    Object.keys(data).forEach((key) => {
      html = html.replace(new RegExp(`{{${key}}}`, "g"), escapeHtml(data[key]));
    });

    const browser = await puppeteer.launch({
      args: ["--no-sandbox"]
    });

    const page = await browser.newPage();
    await page.setContent(html);

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true
    });

    await browser.close();

    // ✅ メール送信（ここは生きてる）
    await resend.emails.send({
      from: "FairVia <info@ilnautico.com>",
      to: email,
      subject: "FairVia Report",
      text: "Attached.",
      attachments: [
        {
          filename: "report.pdf",
          content: pdf.toString("base64")
        }
      ]
    });

    console.log("MAIL SENT:", email);

    res.send(pdf);
  } catch (err) {
    console.error("ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};

/* =========================
   🔥 ここが最重要（壊れてた原因）
========================= */

app.post("/generate-report", handler);
app.post("/api/tally", handler);
app.post("/webhook", handler); // ← 保険

/* ========================= */

app.listen(8080, () => {
  console.log("Server running");
});

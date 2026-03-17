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

app.get("/", (req, res) => {
  res.send("FairVia server running");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getFieldValue(payload, type) {
  if (
    payload &&
    payload.data &&
    payload.data.fields &&
    Array.isArray(payload.data.fields)
  ) {
    const field = payload.data.fields.find((f) => f && f.type === type);
    if (field && typeof field.value === "string") {
      return field.value.trim();
    }
  }
  return "";
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeArray(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean).map((v) => String(v));
  }
  return [];
}

app.post("/generate-report", async (req, res) => {
  try {
    const payload = req.body;

    console.log("PAYLOAD:", JSON.stringify(payload, null, 2));

    const email = getFieldValue(payload, "INPUT_EMAIL");
    const product = getFieldValue(payload, "INPUT_TEXT") || "Not specified";

    console.log("EMAIL FOUND:", email);

    if (!email) {
      return res.status(400).json({
        error: "EMAIL NOT FOUND"
      });
    }

    const prompt = `
You are a professional polymer materials consultant for FairVia.

Your task:
Create a concise but professional "Biodegradable Material Compatibility Screening Report"
based on the submitted form data.

Important rules:
- Be practical and businesslike.
- Do NOT invent precise technical parameters.
- Do NOT provide legal guarantees.
- Keep language clear and professional.
- Write in English.
- Return ONLY valid JSON.
- No markdown.
- No code fences.

Use this exact JSON structure:
{
  "report_title": "FairVia Screening Report",
  "executive_summary": "2-4 sentence summary",
  "application_overview": [
    "bullet 1",
    "bullet 2",
    "bullet 3"
  ],
  "compatibility_observations": [
    "bullet 1",
    "bullet 2",
    "bullet 3"
  ],
  "potential_risks": [
    "bullet 1",
    "bullet 2",
    "bullet 3"
  ],
  "recommended_next_steps": [
    "bullet 1",
    "bullet 2",
    "bullet 3"
  ],
  "provisional_conclusion": "final short conclusion paragraph"
}

Submitted payload:
${JSON.stringify(payload, null, 2)}
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a polymer materials consultant. Return only valid JSON."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    });

    const rawReport =
      completion?.choices?.[0]?.message?.content || "";

    console.log("RAW REPORT:", rawReport);

    const parsed = safeJsonParse(rawReport);

    const reportData = parsed || {
      report_title: "FairVia Screening Report",
      executive_summary:
        "A structured screening report could not be fully parsed from the AI response. Please review the attached provisional summary.",
      application_overview: ["Submitted form data was received successfully."],
      compatibility_observations: [rawReport || "No report generated."],
      potential_risks: ["Further review may be required for a complete assessment."],
      recommended_next_steps: ["Conduct a more detailed engineering review."],
      provisional_conclusion:
        "This document should be treated as a preliminary screening output."
    };

    const reportTitle = escapeHtml(
      reportData.report_title || "FairVia Screening Report"
    );
    const executiveSummary = escapeHtml(
      reportData.executive_summary || ""
    );
    const applicationOverview = normalizeArray(reportData.application_overview);
    const compatibilityObservations = normalizeArray(
      reportData.compatibility_observations
    );
    const potentialRisks = normalizeArray(reportData.potential_risks);
    const recommendedNextSteps = normalizeArray(
      reportData.recommended_next_steps
    );
    const provisionalConclusion = escapeHtml(
      reportData.provisional_conclusion || ""
    );

    const makeList = (items) =>
      items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${reportTitle}</title>
  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      color: #1d2430;
      background: #f6f7fb;
    }

    .page {
      width: 210mm;
      min-height: 297mm;
      margin: 0 auto;
      background: white;
      padding: 28mm 22mm 24mm 22mm;
    }

    .topbar {
      width: 100%;
      height: 8px;
      background: linear-gradient(90deg, #17263c 0%, #b4965a 100%);
      border-radius: 999px;
      margin-bottom: 22px;
    }

    .brand {
      font-size: 13px;
      letter-spacing: 1.2px;
      color: #7a8595;
      text-transform: uppercase;
      margin-bottom: 10px;
    }

    h1 {
      margin: 0;
      font-size: 30px;
      line-height: 1.2;
      color: #17263c;
    }

    .subtitle {
      margin-top: 10px;
      font-size: 14px;
      color: #5f6b7a;
      line-height: 1.7;
    }

    .meta-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      margin-top: 24px;
      margin-bottom: 30px;
    }

    .meta-card {
      border: 1px solid #e5e8ef;
      border-radius: 14px;
      padding: 14px 16px;
      background: #fbfcfe;
    }

    .meta-label {
      font-size: 12px;
      color: #7b8592;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      margin-bottom: 6px;
    }

    .meta-value {
      font-size: 15px;
      color: #1f2937;
      font-weight: 600;
      word-break: break-word;
    }

    .section {
      margin-top: 26px;
      border: 1px solid #e8ebf2;
      border-radius: 16px;
      overflow: hidden;
      background: #fff;
    }

    .section-header {
      background: #17263c;
      color: #fff;
      padding: 13px 16px;
      font-size: 16px;
      font-weight: 700;
      letter-spacing: 0.2px;
    }

    .section-body {
      padding: 18px 18px 16px 18px;
    }

    p {
      margin: 0;
      line-height: 1.8;
      font-size: 14px;
      color: #273244;
    }

    ul {
      margin: 0;
      padding-left: 20px;
    }

    li {
      margin: 0 0 10px 0;
      line-height: 1.75;
      font-size: 14px;
      color: #273244;
    }

    .footer-note {
      margin-top: 28px;
      font-size: 11.5px;
      line-height: 1.7;
      color: #7b8592;
      border-top: 1px solid #e5e8ef;
      padding-top: 14px;
    }

    @page {
      size: A4;
      margin: 0;
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="topbar"></div>

    <div class="brand">FairVia Screening System</div>
    <h1>${reportTitle}</h1>
    <div class="subtitle">
      Preliminary biodegradable material compatibility screening generated from submitted form data.
    </div>

    <div class="meta-grid">
      <div class="meta-card">
        <div class="meta-label">Recipient</div>
        <div class="meta-value">${escapeHtml(email)}</div>
      </div>
      <div class="meta-card">
        <div class="meta-label">Reference Application</div>
        <div class="meta-value">${escapeHtml(product || "Submitted form")}</div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">Executive Summary</div>
      <div class="section-body">
        <p>${executiveSummary}</p>
      </div>
    </div>

    <div class="section">
      <div class="section-header">Application Overview</div>
      <div class="section-body">
        <ul>
          ${makeList(applicationOverview)}
        </ul>
      </div>
    </div>

    <div class="section">
      <div class="section-header">Compatibility Observations</div>
      <div class="section-body">
        <ul>
          ${makeList(compatibilityObservations)}
        </ul>
      </div>
    </div>

    <div class="section">
      <div class="section-header">Potential Risks</div>
      <div class="section-body">
        <ul>
          ${makeList(potentialRisks)}
        </ul>
      </div>
    </div>

    <div class="section">
      <div class="section-header">Recommended Next Steps</div>
      <div class="section-body">
        <ul>
          ${makeList(recommendedNextSteps)}
        </ul>
      </div>
    </div>

    <div class="section">
      <div class="section-header">Provisional Conclusion</div>
      <div class="section-body">
        <p>${provisionalConclusion}</p>
      </div>
    </div>

    <div class="footer-note">
      This report is a preliminary screening output generated for early-stage review purposes.
      A detailed engineering and processing validation may be required before material adoption decisions are made.
    </div>
  </div>
</body>
</html>
`;

    const browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: {
        top: "0",
        right: "0",
        bottom: "0",
        left: "0"
      }
    });

    await browser.close();

    const emailResult = await resend.emails.send({
      from: "FairVia <info@ilnautico.com>",
      reply_to: "info@ilnautico.com",
      to: email,
      subject: "FairVia Screening Report",
      text: "Your screening report is attached as a PDF.",
      html: `
        <p>Thank you for your submission.</p>
        <p>Your FairVia screening report is attached as a PDF.</p>
      `,
      attachments: [
        {
          filename: "fairvia_report.pdf",
          content: pdf.toString("base64")
        }
      ]
    });

    console.log("RESEND RESULT:", JSON.stringify(emailResult, null, 2));
    console.log("MAIL SENT:", email);

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": "attachment; filename=fairvia_report.pdf"
    });

    res.send(pdf);
  } catch (err) {
    console.error("ERROR:", err);

    res.status(500).json({
      error: err.message
    });
  }
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});

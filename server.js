const express = require("express");
const OpenAI = require("openai").default;
const puppeteer = require("puppeteer");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.json({ limit: "2mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const transporter = nodemailer.createTransport({
  いhost: "smtp.zoho.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

app.get("/", (req, res) => {
  res.send("FairVia server running");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/generate-report", async (req, res) => {
  try {
    const payload = req.body;

    console.log("PAYLOAD:", JSON.stringify(payload, null, 2));

    let email = null;

    if (payload.email && typeof payload.email === "string") {
      email = payload.email;
    }

    if (!email && Array.isArray(payload.data)) {
      const emailField = payload.data.find(
        (f) => f && f.type === "INPUT_EMAIL"
      );
      if (emailField && typeof emailField.value === "string") {
        email = emailField.value;
      }
    }

    if (
      !email &&
      payload.data &&
      Array.isArray(payload.data.fields)
    ) {
      const emailField = payload.data.fields.find(
        (f) => f && f.type === "INPUT_EMAIL"
      );
      if (emailField && typeof emailField.value === "string") {
        email = emailField.value;
      }
    }

    console.log("EMAIL FOUND:", email);

    const getFieldValue = (keyName) => {
      if (payload[keyName]) return payload[keyName];

      if (Array.isArray(payload.data)) {
        const field = payload.data.find(
          (f) =>
            f &&
            (
              f.key === keyName ||
              f.label === keyName ||
              (typeof f.key === "string" && f.key.toLowerCase() === keyName.toLowerCase()) ||
              (typeof f.label === "string" && f.label.toLowerCase() === keyName.toLowerCase())
            )
        );
        return field ? field.value || "" : "";
      }

      if (payload.data && Array.isArray(payload.data.fields)) {
        const field = payload.data.fields.find(
          (f) =>
            f &&
            (
              f.key === keyName ||
              f.label === keyName ||
              (typeof f.key === "string" && f.key.toLowerCase() === keyName.toLowerCase()) ||
              (typeof f.label === "string" && f.label.toLowerCase() === keyName.toLowerCase())
            )
        );
        return field ? field.value || "" : "";
      }

      return "";
    };

    const application = getFieldValue("application");
    const material = getFieldValue("material");
    const bio_material = getFieldValue("bio_material");
    const equipment = getFieldValue("equipment");
    const concern = getFieldValue("concern");
    const stage = getFieldValue("stage");
    const notes = getFieldValue("notes");

    const prompt = `
You are a biodegradable materials consultant.

Generate a concise but professional screening report.

Application: ${application}
Current Material: ${material}
Bio Material: ${bio_material}
Equipment: ${equipment}
Concern: ${concern}
Stage: ${stage}
Notes: ${notes}

Return the report in these sections:

Compatibility Level
Technical Observations
Potential Risks
Suggested Next Step
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: "You are a polymer processing expert."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    });

    const report = completion.choices?.[0]?.message?.content || "No report generated.";

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    body {
      font-family: Arial, sans-serif;
      padding: 40px;
      line-height: 1.7;
      color: #222;
    }
    h1 {
      color: #17263c;
      border-bottom: 3px solid #b4965a;
      padding-bottom: 10px;
      margin-bottom: 24px;
      font-size: 28px;
    }
    .meta {
      margin-bottom: 28px;
      font-size: 14px;
      color: #555;
    }
    .meta p {
      margin: 4px 0;
    }
    .report {
      white-space: normal;
      font-size: 15px;
    }
  </style>
</head>
<body>
  <h1>FairVia™ Screening Report</h1>

  <div class="meta">
    <p><strong>Application:</strong> ${application || "-"}</p>
    <p><strong>Current Material:</strong> ${material || "-"}</p>
    <p><strong>Bio Material:</strong> ${bio_material || "-"}</p>
    <p><strong>Equipment:</strong> ${equipment || "-"}</p>
    <p><strong>Concern:</strong> ${concern || "-"}</p>
    <p><strong>Stage:</strong> ${stage || "-"}</p>
  </div>

  <div class="report">
    ${String(report).replace(/\n/g, "<br>")}
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
      printBackground: true
    });

    await browser.close();

    if (email) {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: "FairVia Screening Report",
        text: "Your biodegradable material screening report is attached.",
        attachments: [
          {
            filename: "fairvia_report.pdf",
            content: pdf
          }
        ]
      });

      console.log("MAIL SENT:", email);
    } else {
      console.log("EMAIL NOT FOUND");
    }

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": "attachment; filename=fairvia_report.pdf"
    });

    res.send(pdf);
  } catch (error) {
    console.error("ERROR:", error);

    res.status(500).json({
      error: "AI generation failed",
      details: error.message
    });
  }
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});

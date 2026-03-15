const express = require("express");
const OpenAI = require("openai").default;
const puppeteer = require("puppeteer");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.json());

/* -------------------------
OPENAI
------------------------- */

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* -------------------------
MAIL
------------------------- */

const transporter = nodemailer.createTransport({
  host: "smtp.zoho.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

/* -------------------------
TEST
------------------------- */

app.get("/", (req, res) => {
  res.send("FairVia server running");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/* -------------------------
REPORT GENERATION
------------------------- */

app.post("/generate-report", async (req, res) => {

  try {

    const payload = req.body;

    console.log("PAYLOAD:", JSON.stringify(payload, null, 2));

    /* -------------------------
    EMAIL取得（Tally対応）
    ------------------------- */

    let email = null;

    if (payload.email) {
      email = payload.email;
    }

    if (!email && payload.data && payload.data.fields) {

      const emailField = payload.data.fields.find(
        f =>
          (f.key && f.key.toLowerCase().includes("email")) ||
          (f.label && f.label.toLowerCase().includes("email"))
      );

      if (emailField) {
        email = emailField.value;
      }
    }

    console.log("EMAIL FOUND:", email);

    /* -------------------------
    OPENAI
    ------------------------- */

    const prompt = `
You are a biodegradable materials consultant.

Generate a short technical screening report.
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: "You are a polymer materials expert." },
        { role: "user", content: prompt }
      ]
    });

    const report = completion.choices[0].message.content;

    /* -------------------------
    HTML
    ------------------------- */

    const html = `
    <html>
    <body style="font-family:Arial;padding:40px">
    <h1>FairVia Screening Report</h1>
    <p>${report}</p>
    </body>
    </html>
    `;

    /* -------------------------
    PDF
    ------------------------- */

    const browser = await puppeteer.launch({
      args: ["--no-sandbox"]
    });

    const page = await browser.newPage();
    await page.setContent(html);

    const pdf = await page.pdf({
      format: "A4"
    });

    await browser.close();

    /* -------------------------
    MAIL
    ------------------------- */

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

    /* -------------------------
    RESPONSE
    ------------------------- */

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": "attachment; filename=fairvia_report.pdf"
    });

    res.send(pdf);

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: "AI generation failed",
      details: error.message
    });

  }

});

/* -------------------------
SERVER
------------------------- */

const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});
